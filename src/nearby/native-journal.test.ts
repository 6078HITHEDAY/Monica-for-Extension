import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SecureVaultService } from '../security/secure-vault-service';
import { MemoryVaultStorage } from '../security/vault-storage';
import { MemoryVaultSessionStore } from '../security/vault-session';
import { MemoryVaultDeviceKeyStore } from '../security/vault-device-key';
import { nearbyNativeIntent, readNearbyNativeJournal, restoreNearbyNativeWrite, savedNativeAcknowledgements } from './native-journal';
import { createNearbyPreferences, changeNearbyPreferences } from './preferences';
import type { NearbyNativeAdoption } from './native-adoption';

function plan(providerId: string = randomUUID()): NearbyNativeAdoption {
  const operationId = randomUUID(), vaultId = randomUUID(), objectId = randomUUID(), scope = `mdbx:${providerId}`;
  return { providerId, vaultHandle: randomUUID(), sourceHash: 'a'.repeat(64),
    write: { operationId, writeRevision: { vaultId, revisionSha256: 'b'.repeat(64) },
      plan: { commands: [{ kind: 'object-create', objectId, collectionId: randomUUID(), objectTypeId: 'note', title: 'Synthetic', payloadJson: '{"item_data":"synthetic-private-marker"}' }], attachments: [] }, assets: [] },
    bindings: [{ recordId: 'remote-record', clockJson: '{"device":9007199254740993}', localId: `${scope}:${objectId}`, deleted: false, dataJson: '{"title":"Synthetic","folder":"","entry_type":"note","payload":{"item_data":"synthetic-private-marker"}}' }] };
}
async function fixture() {
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore(), service = new SecureVaultService(storage, sessions, Date.now, new MemoryVaultDeviceKeyStore());
  await service.setup(''); const sessionId = (await service.passkeySessionId())!, p = plan();
  await service.upsertProvider({ id: p.providerId, kind: 'mdbx2', enabled: true, isDefaultSaveTarget:false, name: 'Synthetic', config: { vaultHandle: p.vaultHandle } });
  const before = await service.nearbySessionPreferences(sessionId);
  await service.updateNearbyPreferences({ kind: 'source', providerId: p.providerId }, before.epoch, sessionId);
  const preferences = await service.nearbySessionPreferences(sessionId), intent = await nearbyNativeIntent(p, preferences.replicaStorageId);
  return { storage, sessions, service, sessionId, p, preferences, intent };
}
describe('native nearby encrypted intent recovery', () => {
  it('keeps the exact operation, numeric lexemes and payload across encrypted persistence and lost reply', async () => {
    const f = await fixture(), original = f.storage.write.bind(f.storage);
    f.storage.write = async envelope => { await original(envelope); throw Error('synthetic reply loss'); };
    await expect(f.service.stageNearbyNativeIntent(f.intent, f.preferences.epoch, f.sessionId, () => {})).rejects.toThrow('reply loss');
    f.storage.write = original;
    const journal = await f.service.readNearbyNativeJournal(f.sessionId); expect(journal?.intent).toEqual(f.intent);
    expect(JSON.stringify(await f.storage.read())).not.toContain('synthetic-private-marker');
    expect(restoreNearbyNativeWrite(journal!.intent!)).toEqual(f.p.write);
    await f.service.finishNearbyNativeIntent(f.intent.operationId, f.sessionId, () => {});
    const final = await f.service.readNearbyNativeJournal(f.sessionId); expect(final?.intent).toBeUndefined();
    const b = f.p.bindings[0], record = { id: b.recordId, clockJson: b.clockJson, dataJson: b.dataJson, deleted: false };
    expect(savedNativeAcknowledgements(final, [record])).toHaveLength(1);
    expect(savedNativeAcknowledgements(final, [{ ...record, clockJson: '{"device":9007199254740994}' }])).toHaveLength(0);
    expect(savedNativeAcknowledgements(final, [{ ...record, dataJson: '{}' }])).toHaveLength(0);
  });
  it('refuses a replacement intent and source change while a transaction needs recovery', async () => {
    const f = await fixture(); await f.service.stageNearbyNativeIntent(f.intent, f.preferences.epoch, f.sessionId, () => {});
    const other = await nearbyNativeIntent(plan(f.p.providerId), f.preferences.replicaStorageId);
    await expect(f.service.stageNearbyNativeIntent(other, f.preferences.epoch, f.sessionId, () => {})).rejects.toThrow();
    const local = (await f.service.readState()).providers.find(p => p.kind === 'local')!;
    await expect(f.service.updateNearbyPreferences({ kind: 'source', providerId: local.id }, f.preferences.epoch, f.sessionId)).rejects.toThrow('recovery-required');
    expect((await f.service.readNearbyNativeJournal(f.sessionId))?.intent).toEqual(f.intent);
  });
  it('only discards the intent on a proven stale rejection; it records no acknowledgement', async () => {
    const f = await fixture(); await f.service.stageNearbyNativeIntent(f.intent, f.preferences.epoch, f.sessionId, () => {});
    await f.service.finishNearbyNativeIntent(f.intent.operationId, f.sessionId, () => {}, true);
    expect((await f.service.readNearbyNativeJournal(f.sessionId))?.acknowledgements).toEqual([]);
  });
  it('will not persist or confirm after manager cancellation or vault lock', async () => {
    const f = await fixture();
    await expect(f.service.stageNearbyNativeIntent(f.intent, f.preferences.epoch, f.sessionId, () => { throw Error('cancelled'); })).rejects.toThrow('cancelled');
    expect(await f.service.readNearbyNativeJournal(f.sessionId)).toBeUndefined();
    await f.service.stageNearbyNativeIntent(f.intent, f.preferences.epoch, f.sessionId, () => {}); await f.service.lock();
    await expect(f.service.finishNearbyNativeIntent(f.intent.operationId, f.sessionId, () => {})).rejects.toThrow();
  });
  it('rotates replica storage and key when changing an unpaired source', () => {
    const p = createNearbyPreferences({ id: randomUUID(), kind: 'local', name: 'Local', enabled: true, isDefaultSaveTarget:false, config: {} });
    const next = changeNearbyPreferences(p, { kind: 'source', providerId: randomUUID() }, p.epoch);
    expect(next.replicaStorageId).not.toBe(p.replicaStorageId); expect(next.replicaKey).not.toBe(p.replicaKey);
  });
  it('fails closed on corrupt vault identity and acknowledgement scope', async () => {
    const p = plan(), intent = await nearbyNativeIntent(p, randomUUID());
    const value = { version: 1, providerId: p.providerId, vaultId: intent.vaultId, replicaStorageId: intent.replicaStorageId, intent, acknowledgements: [] };
    expect(() => readNearbyNativeJournal({ ...value, vaultId: randomUUID() })).toThrow();
    const broken = structuredClone(value); broken.intent.acknowledgements[0].scope = 'local'; expect(() => readNearbyNativeJournal(broken)).toThrow();
    const duplicate = structuredClone(value); duplicate.intent.acknowledgements.push(duplicate.intent.acknowledgements[0]);
    expect(() => readNearbyNativeJournal(duplicate)).toThrow('native-journal-duplicate');
    for (const clockJson of ['{}', '{"device":-1}', '{"device":18446744073709551616}', '{"bad/path":1}']) {
      const corrupt = structuredClone(value); corrupt.intent.acknowledgements[0].clockJson = clockJson;
      expect(() => readNearbyNativeJournal(corrupt)).toThrow();
    }
  });
});
