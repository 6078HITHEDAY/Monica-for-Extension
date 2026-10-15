import type { SecureVaultService } from '../security/secure-vault-service';
import type { Mdbx2NativeClient } from '../providers/mdbx2/native-client';
import { Mdbx2NativeHostError } from '../providers/mdbx2/native-contract';
import { requireMdbx2ContentWriteCapabilities, writeMdbx2Content } from '../providers/mdbx2/content-write';
import { mdbx2TransferOperationScope as hash } from '../providers/mdbx2/mdbx2-transfer-identity';
import { clearNearbyNativeAdoption, planNearbyNativeAdoption } from './native-adoption';
import { captureNearbyNativeSource, nativeActive, type NearbyNativeSource } from './native-source';
import { projectNearbyNativeRecords, requireCompleteNearbyNativeProjection } from './native-records';
import { nearbyNativeIntent, restoreNearbyNativeWrite, savedNativeAcknowledgements, type NearbyNativeIntent } from './native-journal';
import type { NearbySourceAdapter } from './source-adapter';
import { invalidNearby, wireObject } from './wire-shape';

type Store = Pick<SecureVaultService, 'getProvider' | 'readNearbyNativeJournal' | 'stageNearbyNativeIntent' | 'finishNearbyNativeIntent'>;
export function nativeNearbySource(options: {
  store: Store; client: Mdbx2NativeClient; providerId: string; replicaStorageId: string; sessionId: string;
  epoch: () => string; assertActive: () => void; signal: AbortSignal;
  exclusive: <T>(work: () => Promise<T>) => Promise<T>;
}): NearbySourceAdapter {
  const { store, client, providerId, replicaStorageId, sessionId, signal } = options;
  let planningSource: NearbyNativeSource | undefined;
  const active = () => { nativeActive(signal); options.assertActive(); };
  const binding = async () => {
    active(); const p = await store.getProvider(providerId); active();
    if (!p || !p.enabled || p.kind !== 'mdbx2' || typeof p.config.vaultHandle !== 'string') invalidNearby('native-source-unavailable');
    return { providerId, vaultHandle: p.config.vaultHandle };
  };
  const capture = async () => captureNearbyNativeSource(client, await binding(), signal);
  const journal = async () => {
    active(); const j = await store.readNearbyNativeJournal(sessionId); active();
    if (j && (j.providerId !== providerId || j.replicaStorageId !== replicaStorageId)) invalidNearby('native-journal-source');
    return j;
  };
  const apply = async (intent: NearbyNativeIntent) => {
    planningSource = undefined;
    const b = await binding(), revision = await client.readWriteRevision(b.vaultHandle); active();
    if (revision.vaultId !== intent.vaultId) invalidNearby('native-journal-vault');
    const write = restoreNearbyNativeWrite(intent);
    try {
      // Never substitute a new operation/revision after an uncertain outcome.
      const receipt = await writeMdbx2Content(client, b.vaultHandle, write, signal); active();
      if (receipt.operationId !== intent.operationId) invalidNearby('native-journal-receipt');
      await store.finishNearbyNativeIntent(intent.operationId, sessionId, active); active();
      return intent.acknowledgements;
    } catch (e) {
      // Only this engine result proves no transaction was applied. Keep every
      // other intent (including cancellation) for exact receipt recovery.
      if (e instanceof Mdbx2NativeHostError && e.code === 'content-write-stale') {
        await store.finishNearbyNativeIntent(intent.operationId, sessionId, active, true);
      }
      throw e;
    } finally { write.assets.forEach(a => a.bytes.fill(0)); }
  };
  return {
    scope: `mdbx:${providerId}`, native: true,
    async snapshotHash() { const b = await binding(), writeRevision = await client.readWriteRevision(b.vaultHandle); active(); return hash({ providerId, handle: b.vaultHandle, writeRevision }); },
    capture: () => options.exclusive(async () => {
      const source = await capture(), projection = requireCompleteNearbyNativeProjection(await projectNearbyNativeRecords(source, signal)); active();
      planningSource = source;
      return { sourceHash: source.sourceHash, records: projection.records, async readAsset(id) {
        const attachment = projection.assets.find(a => a.contentHash === id); if (!attachment) invalidNearby('source-asset-missing');
        active(); return client.readContentAttachmentBytes(source.vaultHandle, { writeRevision: source.writeRevision, attachment }, signal);
      } };
    }),
    recover: () => options.exclusive(async () => { const j = await journal(); return j?.intent ? apply(j.intent) : []; }),
    saved: async records => savedNativeAcknowledgements(await journal(), records),
    groups: records => options.exclusive(async () => {
      const projection = requireCompleteNearbyNativeProjection(await projectNearbyNativeRecords(await capture(), signal));
      const byLocal = new Map(projection.records.map(row=>[row.local_id,row.data]));
      return records.flatMap(record=>{
        const data=record.localId ? byLocal.get(record.localId) : undefined;
        const group=data?.extensions === undefined ? undefined : wireObject(data.extensions).password_group_id;
        return typeof group==='string' && group ? [[record.id,group] as [string,string]] : [];
      });
    }),
    adopt: batch => options.exclusive(async () => {
      if ((await journal())?.intent) invalidNearby('native-recovery-required');
      const b = await binding();
      let source = planningSource;
      if (source && source.providerId === b.providerId && source.vaultHandle === b.vaultHandle && source.sourceHash === batch.sourceHash) {
        const revision = await client.readWriteRevision(b.vaultHandle); active();
        if (revision.vaultId !== source.writeRevision.vaultId || revision.revisionSha256 !== source.writeRevision.revisionSha256) source = undefined;
      } else source = undefined;
      // Reuse only the just-scanned, unchanged revision for incoming planning.
      // Outgoing captures always reread native policy/data, and every actual
      // write still executes the native authorization/revision checks.
      source ??= await capture(); active();
      planningSource = source;
      const plan = await planNearbyNativeAdoption(source, { ...batch, operationId: crypto.randomUUID() }, signal);
      try {
        // A known unsupported engine must not leave a durable intent that can
        // never execute. The writer checks again before native staging.
        const caps = await client.hello(15_000, source.vaultHandle); active();
        requireMdbx2ContentWriteCapabilities(caps, plan.write.plan.commands.some(row => row.kind === 'collection-trash'));
        const intent = await nearbyNativeIntent(plan, replicaStorageId); active();
        await store.stageNearbyNativeIntent(intent, options.epoch(), sessionId, active); active();
        const acknowledgements = await apply(intent), after = await client.readWriteRevision(source.vaultHandle); active();
        return { acknowledgements, sourceHash: await hash({ providerId, handle: source.vaultHandle, writeRevision: after }) };
      } finally { clearNearbyNativeAdoption(plan); }
    })
  };
}
