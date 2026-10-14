import type { Mdbx2ContentWriteInput } from '../providers/mdbx2/content-write';
import { base64ToBytes, bytesToBase64 } from '../security/encoding';
import { mdbx2TransferOperationScope as hash } from '../providers/mdbx2/mdbx2-transfer-identity';
import type { NearbyNativeAdoption } from './native-adoption';
import type { NearbyIncomingRecord } from './local-adoption';
import { invalidNearby, wireInteger, wireObject } from './wire-shape';
import { parseLosslessJson } from '../core/lossless-json';

export interface NearbyAcknowledgement { recordId: string; clockJson: string; localId: string; scope: string; guard: string; dataJson: string }
export interface NearbyNativeIntent {
  version: 1; replicaStorageId: string; providerId: string; vaultId: string; operationId: string;
  write: Omit<Mdbx2ContentWriteInput, 'assets'> & { assets: { id: string; dataBase64: string }[] };
  acknowledgements: NearbyAcknowledgement[];
}
export interface NearbyNativeJournal {
  version: 1; replicaStorageId: string; providerId: string; vaultId: string;
  intent?: NearbyNativeIntent;
  acknowledgements: NearbyAcknowledgement[];
}
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/, digest = /^[a-f0-9]{64}$/;
const id = (value: unknown) => { if (typeof value !== 'string' || !uuid.test(value)) invalidNearby('native-journal-identity'); };
function ack(value: unknown, provider: string): NearbyAcknowledgement {
  const a = wireObject(value);
  if (typeof a.recordId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(a.recordId) || a.scope !== `mdbx:${provider}`
    || typeof a.localId !== 'string' || !a.localId.startsWith(`${a.scope}:`) || a.localId.length > 256
    || typeof a.guard !== 'string' || !digest.test(a.guard) || typeof a.dataJson !== 'string' || a.dataJson.length > 1024 * 1024
    || typeof a.clockJson !== 'string' || a.clockJson.length > 65536) invalidNearby('native-journal-ack');
  wireObject(parseLosslessJson(a.dataJson));
  const clock = Object.entries(wireObject(parseLosslessJson(a.clockJson)));
  if (!clock.length || clock.length > 1024) invalidNearby('native-journal-clock');
  for (const [device, value] of clock) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(device)) invalidNearby('native-journal-clock');
    wireInteger(value, (1n << 64n) - 1n);
  }
  return structuredClone(value) as NearbyAcknowledgement;
}
/** Stored only inside the encrypted vault envelope. No runtime request accepts
 * journal contents. A corrupt intent must stop recovery, never become a create. */
export function readNearbyNativeJournal(value: unknown): NearbyNativeJournal | undefined {
  if (value === undefined) return undefined;
  const j = wireObject(value); id(j.replicaStorageId); id(j.vaultId);
  if (j.version !== 1 || typeof j.providerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(j.providerId) || !Array.isArray(j.acknowledgements) || j.acknowledgements.length > 20_000) invalidNearby('native-journal');
  const acknowledgements = j.acknowledgements.map(a => ack(a, j.providerId as string));
  const projected = new Map(acknowledgements.map(a => [a.recordId, a]));
  if (new Set(acknowledgements.map(a => a.recordId)).size !== acknowledgements.length) invalidNearby('native-journal-duplicate');
  if (j.intent !== undefined) {
    const i = wireObject(j.intent), w = wireObject(i.write), revision = wireObject(w.writeRevision), plan = wireObject(w.plan);
    id(i.operationId);
    if (i.version !== 1 || i.replicaStorageId !== j.replicaStorageId || i.providerId !== j.providerId || i.vaultId !== j.vaultId || w.operationId !== i.operationId
      || revision.vaultId !== j.vaultId || typeof revision.revisionSha256 !== 'string' || !digest.test(revision.revisionSha256)
      || !Array.isArray(plan.commands) || plan.commands.length > 128 || !Array.isArray(plan.attachments) || plan.attachments.length > 64
      || !Array.isArray(w.assets) || w.assets.length > 64 || !Array.isArray(i.acknowledgements) || !i.acknowledgements.length || i.acknowledgements.length > 128) invalidNearby('native-journal-intent');
    let bytes = 0;
    for (const raw of w.assets) {
      const a = wireObject(raw); id(a.id);
      if (typeof a.dataBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(a.dataBase64)) invalidNearby('native-journal-asset');
      bytes += a.dataBase64.length; if (bytes > 90 * 1024 * 1024) invalidNearby('native-journal-limit');
    }
    if (new TextEncoder().encode(JSON.stringify(plan)).length > 8 * 1024 * 1024) invalidNearby('native-journal-limit');
    const seen = new Set<string>(), assets = new Set<string>();
    for (const a of w.assets) {
      const assetId = wireObject(a).id as string;
      if (assets.has(assetId)) invalidNearby('native-journal-duplicate'); assets.add(assetId);
    }
    for (const value of i.acknowledgements) {
      const a = ack(value, j.providerId as string);
      if (seen.has(a.recordId)) invalidNearby('native-journal-duplicate'); seen.add(a.recordId);
      projected.set(a.recordId, a);
    }
  }
  // Check the post-commit acknowledgement set before staging the intent, so a
  // successful native commit cannot become unrecoverable at the journal limit.
  let budget = 0;
  if (projected.size > 20_000) invalidNearby('native-journal-limit');
  for (const a of projected.values()) {
    budget += new TextEncoder().encode(a.dataJson + a.clockJson).length;
    if (budget > 48 * 1024 * 1024) invalidNearby('native-journal-limit');
  }
  return structuredClone(value) as NearbyNativeJournal;
}
export async function nearbyNativeIntent(plan: NearbyNativeAdoption, replicaStorageId: string): Promise<NearbyNativeIntent> {
  const scope = `mdbx:${plan.providerId}`;
  const acknowledgements = await Promise.all(plan.bindings.map(async b => ({ recordId: b.recordId, clockJson: b.clockJson, localId: b.localId, scope,
    // The receipt proves the original transaction, not the current content.
    // A synthetic guard forces revalidation if a later inbound update arrives
    // before a fresh scan. Content hashes (not guards) drive replica clocks.
    guard: await hash({ operationId: plan.write.operationId, localId: b.localId, clockJson: b.clockJson }), dataJson: b.dataJson })));
  const intent: NearbyNativeIntent = { version: 1, replicaStorageId, providerId: plan.providerId, vaultId: plan.write.writeRevision.vaultId,
    operationId: plan.write.operationId, write: { operationId: plan.write.operationId, writeRevision: { ...plan.write.writeRevision },
      plan: structuredClone(plan.write.plan), assets: plan.write.assets.map(a => ({ id: a.id, dataBase64: bytesToBase64(a.bytes) })) }, acknowledgements };
  readNearbyNativeJournal({ version: 1, replicaStorageId, providerId: intent.providerId, vaultId: intent.vaultId, intent, acknowledgements: [] });
  return intent;
}
export function restoreNearbyNativeWrite(intent: NearbyNativeIntent): Mdbx2ContentWriteInput {
  const assets: { id: string; bytes: Uint8Array }[] = [];
  try { for (const a of intent.write.assets) assets.push({ id: a.id, bytes: base64ToBytes(a.dataBase64) }); return { ...structuredClone(intent.write), assets }; }
  catch (e) { assets.forEach(a => a.bytes.fill(0)); throw e; }
}
export function savedNativeAcknowledgements(journal: NearbyNativeJournal | undefined, records: readonly NearbyIncomingRecord[]): NearbyAcknowledgement[] {
  if (!journal) return [];
  return records.flatMap(r => {
    const a = journal.acknowledgements.find(a => a.recordId === r.id && a.clockJson === r.clockJson && a.dataJson === r.dataJson);
    return a ? [structuredClone(a)] : [];
  });
}
