import type { Mdbx2ContentWriteInput } from '../providers/mdbx2/content-write';
import { base64ToBytes, bytesToBase64 } from '../security/encoding';
import { mdbx2TransferOperationScope as hash } from '../providers/mdbx2/mdbx2-transfer-identity';
import type { NearbyNativeAdoption } from './native-adoption';
import type { NearbyIncomingRecord } from './local-adoption';
import { invalidNearby, wireInteger, wireObject } from './wire-shape';
import { parseLosslessJson } from '../core/lossless-json';
import { advanceMdbx2ContentWriteAnchor, validateMdbx2ContentWriteAnchor, type Mdbx2ContentWriteAnchor } from '../providers/mdbx2/content-write-anchor';

export interface NearbyAcknowledgement { recordId: string; clockJson: string; localId: string; scope: string; guard: string; dataJson: string }
export interface NearbyNativeIntent {
  version: 1; replicaStorageId: string; providerId: string; vaultId: string; operationId: string;
  write: Omit<Mdbx2ContentWriteInput, 'assets'> & { assets: { id: string; dataBase64: string }[] };
  acknowledgements: NearbyAcknowledgement[];
  sequence?: {
    anchor: Mdbx2ContentWriteAnchor;
    completedSteps: number;
    remaining: Omit<NearbyNativeIntent['write'], 'writeRevision'>[];
  };
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
    const writes = [w];
    if (i.sequence !== undefined) {
      const sequence = wireObject(i.sequence), anchor = wireObject(sequence.anchor), anchorRevision = wireObject(anchor.writeRevision);
      if (!Number.isSafeInteger(sequence.completedSteps) || (sequence.completedSteps as number) < 0
        || !Array.isArray(sequence.remaining) || sequence.remaining.length + (sequence.completedSteps as number) >= 68
        || anchorRevision.vaultId !== revision.vaultId || anchorRevision.revisionSha256 !== revision.revisionSha256
        || !Array.isArray(anchor.branches) || !anchor.branches.length || anchor.branches.length > 1024
        || new TextEncoder().encode(JSON.stringify(anchor)).length > 512 * 1024) invalidNearby('native-journal-sequence');
      writes.push(...sequence.remaining.map(wireObject));
    }
    let bytes = 0, planBytes = 0;
    const operations = new Set<string>();
    for (const write of writes) {
      id(write.operationId);
      if (operations.has(write.operationId as string)) invalidNearby('native-journal-duplicate'); operations.add(write.operationId as string);
      const p = wireObject(write.plan);
      if (!Array.isArray(p.commands) || p.commands.length > 128 || !Array.isArray(p.attachments) || p.attachments.length > 64
        || !(p.commands.length + p.attachments.length) || !Array.isArray(write.assets) || write.assets.length > 64) invalidNearby('native-journal-intent');
      planBytes += new TextEncoder().encode(JSON.stringify(p)).length;
      if (planBytes > 8 * 1024 * 1024) invalidNearby('native-journal-limit');
      const assets = new Set<string>();
      for (const raw of write.assets) {
        const a = wireObject(raw); id(a.id);
        if (assets.has(a.id as string)) invalidNearby('native-journal-duplicate'); assets.add(a.id as string);
        if (typeof a.dataBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(a.dataBase64)) invalidNearby('native-journal-asset');
        bytes += a.dataBase64.length; if (bytes > 90 * 1024 * 1024) invalidNearby('native-journal-limit');
      }
    }
    const seen = new Set<string>();
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
export async function nearbyNativeIntent(plan: NearbyNativeAdoption, replicaStorageId: string, anchor?: Mdbx2ContentWriteAnchor): Promise<NearbyNativeIntent> {
  const scope = `mdbx:${plan.providerId}`;
  const acknowledgements = await Promise.all(plan.bindings.map(async b => ({ recordId: b.recordId, clockJson: b.clockJson, localId: b.localId, scope,
    // The receipt proves the original transaction, not the current content.
    // A synthetic guard forces revalidation if a later inbound update arrives
    // before a fresh scan. Content hashes (not guards) drive replica clocks.
    guard: await hash({ operationId: plan.write.operationId, localId: b.localId, clockJson: b.clockJson }), dataJson: b.dataJson })));
  const intent: NearbyNativeIntent = { version: 1, replicaStorageId, providerId: plan.providerId, vaultId: plan.write.writeRevision.vaultId,
    operationId: plan.write.operationId, write: { operationId: plan.write.operationId, writeRevision: { ...plan.write.writeRevision },
      plan: structuredClone(plan.write.plan), assets: plan.write.assets.map(a => ({ id: a.id, dataBase64: bytesToBase64(a.bytes) })) }, acknowledgements };
  if (plan.remainingWrites?.length) {
    if (!anchor) invalidNearby('native-journal-sequence');
    intent.sequence = { anchor: await validateMdbx2ContentWriteAnchor(anchor), completedSteps: 0,
      remaining: plan.remainingWrites.map(write => ({ operationId: write.operationId, plan: structuredClone(write.plan),
        assets: write.assets.map(a => ({ id: a.id, dataBase64: bytesToBase64(a.bytes) })) })) };
  }
  readNearbyNativeJournal({ version: 1, replicaStorageId, providerId: intent.providerId, vaultId: intent.vaultId, intent, acknowledgements: [] });
  return intent;
}
/** Called only after verifying this exact operation's native receipt. No
 * acknowledgements become durable until the last step has committed. */
export async function advanceNearbyNativeIntent(intent: NearbyNativeIntent, commitId: string): Promise<NearbyNativeIntent> {
  const original = structuredClone(intent), sequence = original.sequence;
  if (!sequence?.remaining.length) invalidNearby('native-journal-sequence');
  const anchor = await advanceMdbx2ContentWriteAnchor(sequence.anchor, commitId), [write, ...remaining] = sequence.remaining;
  return { ...original, operationId: write.operationId, write: { ...structuredClone(write), writeRevision: { ...anchor.writeRevision } },
    sequence: { anchor, completedSteps: sequence.completedSteps + 1, remaining: structuredClone(remaining) } };
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
