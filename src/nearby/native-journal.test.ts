import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { SecureVaultService } from '../security/secure-vault-service';
import { MemoryVaultStorage } from '../security/vault-storage';
import { MemoryVaultSessionStore } from '../security/vault-session';
import { MemoryVaultDeviceKeyStore } from '../security/vault-device-key';
import { nearbyNativeIntent, readNearbyNativeJournal, restoreNearbyNativeWrite, savedNativeAcknowledgements } from './native-journal';
import { createNearbyPreferences, changeNearbyPreferences } from './preferences';
import type { NearbyNativeAdoption } from './native-adoption';
import { advanceMdbx2ContentWriteAnchor, type Mdbx2ContentWriteAnchor } from '../providers/mdbx2/content-write-anchor';
import * as writer from '../providers/mdbx2/content-write';
import { nativeNearbySource } from './native-adapter';
import type { Mdbx2NativeClient } from '../providers/mdbx2/native-client';

afterEach(() => vi.restoreAllMocks());

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
  async function sequenceFixture() {
    const f = await fixture(), anchor: Mdbx2ContentWriteAnchor = {
      writeRevision: { ...f.p.write.writeRevision }, branches: [{ branchId: randomUUID(), branchName: 'main', headCommitId: randomUUID() }]
    };
    const hash = createHash('sha256');
    for (const text of ['monica-extension-write-revision-v1', anchor.writeRevision.vaultId, ...anchor.branches.flatMap(b => [b.branchId, b.branchName, b.headCommitId])]) {
      const bytes = Buffer.from(text), length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(bytes.length)); hash.update(length).update(bytes);
    }
    anchor.writeRevision.revisionSha256 = hash.digest('hex'); f.p.write.writeRevision = { ...anchor.writeRevision };
    const next = { operationId: randomUUID(), plan: structuredClone(f.p.write.plan), assets: [] };
    f.p.remainingWrites = [next];
    f.intent = await nearbyNativeIntent(f.p, f.preferences.replicaStorageId, anchor);
    return { ...f, anchor, next };
  }
  it('advances encrypted sequence state after reply loss and acknowledges only the final commit', async () => {
    const f = await sequenceFixture(); await f.service.stageNearbyNativeIntent(f.intent, f.preferences.epoch, f.sessionId, () => {});
    await expect(f.service.assertNoNearbyNativeSequence(f.p.providerId)).rejects.toThrow('Wi-Fi');
    await expect(f.service.assertNoNearbyNativeSequence('unrelated-provider')).resolves.toBeUndefined();
    const alias=randomUUID();await f.service.upsertProvider({id:alias,kind:'mdbx2',enabled:true,isDefaultSaveTarget:false,name:'Same native vault alias',config:{vaultHandle:f.p.vaultHandle}});
    await expect(f.service.assertNoNearbyNativeSequence(alias)).rejects.toThrow('Wi-Fi');
    await expect(f.service.finishNearbyNativeIntent(f.intent.operationId, f.sessionId, () => {})).rejects.toThrow('incomplete');
    const original = f.storage.write.bind(f.storage), commitId = randomUUID();
    f.storage.write = async envelope => { await original(envelope); throw Error('synthetic sequence reply loss'); };
    await expect(f.service.advanceNearbyNativeIntent(f.intent.operationId, commitId, f.sessionId, () => {})).rejects.toThrow('reply loss');
    f.storage.write = original;
    const journal = await f.service.readNearbyNativeJournal(f.sessionId), anchor = await advanceMdbx2ContentWriteAnchor(f.anchor, commitId);
    expect(journal!.intent!.operationId).toBe(f.next.operationId);
    expect(journal!.intent!.write.writeRevision).toEqual(anchor.writeRevision);
    expect(journal!.intent!.sequence).toEqual({ anchor, completedSteps: 1, remaining: [] });
    expect(journal!.acknowledgements).toEqual([]);
    expect(JSON.stringify(await f.storage.read())).not.toContain('synthetic-private-marker');
    await expect(f.service.finishNearbyNativeIntent(f.next.operationId, f.sessionId, () => {}, true)).rejects.toThrow('preserve remaining');
    expect((await f.service.readNearbyNativeJournal(f.sessionId))!.intent).toEqual(journal!.intent);
    await f.service.finishNearbyNativeIntent(f.next.operationId, f.sessionId, () => {});
    expect((await f.service.readNearbyNativeJournal(f.sessionId))!.acknowledgements).toEqual(f.intent.acknowledgements);
    await expect(f.service.assertNoNearbyNativeSequence(f.p.providerId)).resolves.toBeUndefined();
  });
  it('recovers the complete sequence using predicted revisions and preserves exact operations', async () => {
    const f = await sequenceFixture(); await f.service.stageNearbyNativeIntent(f.intent, f.preferences.epoch, f.sessionId, () => {});
    const commits = [randomUUID(), randomUUID()];
    const write = vi.spyOn(writer, 'writeMdbx2Content').mockImplementation(async (_client, _handle, input) => ({
      operationId: input.operationId, commitId: input.operationId === f.intent.operationId ? commits[0] : commits[1], alreadyCommitted: input.operationId === f.intent.operationId
    }));
    const client = { readWriteRevision: vi.fn().mockResolvedValue({ ...f.p.write.writeRevision, revisionSha256: 'f'.repeat(64) }) } as unknown as Mdbx2NativeClient;
    const adapter = nativeNearbySource({ store: f.service, client, providerId: f.p.providerId, replicaStorageId: f.preferences.replicaStorageId, sessionId: f.sessionId,
      epoch: () => f.preferences.epoch, assertActive: () => {}, signal: new AbortController().signal, exclusive: work => work() });
    expect(await adapter.recover()).toEqual(f.intent.acknowledgements);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0][2]).toEqual(f.p.write);
    expect(write.mock.calls[1][2]).toEqual({ ...f.next, writeRevision: (await advanceMdbx2ContentWriteAnchor(f.anchor, commits[0])).writeRevision });
    expect((await f.service.readNearbyNativeJournal(f.sessionId))!.intent).toBeUndefined();
  });
  it('retains the exact unfinished step after cancellation or failed native continuation', async () => {
    const f = await sequenceFixture(); await f.service.stageNearbyNativeIntent(f.intent, f.preferences.epoch, f.sessionId, () => {});
    await expect(f.service.advanceNearbyNativeIntent(f.intent.operationId, randomUUID(), f.sessionId, () => { throw Error('cancelled'); })).rejects.toThrow('cancelled');
    expect((await f.service.readNearbyNativeJournal(f.sessionId))!.intent).toEqual(f.intent);
    const write = vi.spyOn(writer, 'writeMdbx2Content').mockImplementation(async (_client, _handle, input) => {
      if (input.operationId === f.next.operationId) throw new writer.Mdbx2ContentWriteOutcomeUnknownError(input.operationId);
      return { operationId: input.operationId, commitId: randomUUID(), alreadyCommitted: false };
    });
    const client = { readWriteRevision: vi.fn().mockResolvedValue(f.p.write.writeRevision) } as unknown as Mdbx2NativeClient;
    const adapter = nativeNearbySource({ store: f.service, client, providerId: f.p.providerId, replicaStorageId: f.preferences.replicaStorageId, sessionId: f.sessionId,
      epoch: () => f.preferences.epoch, assertActive: () => {}, signal: new AbortController().signal, exclusive: work => work() });
    await expect(adapter.recover()).rejects.toMatchObject({ code: 'content-write-outcome-unknown' });
    expect(write).toHaveBeenCalledTimes(2);
    const journal = await f.service.readNearbyNativeJournal(f.sessionId);
    expect(journal!.intent!.operationId).toBe(f.next.operationId); expect(journal!.acknowledgements).toEqual([]);
  });
  it('rejects corrupt sequence operation identities, anchors and step budgets', async () => {
    const f = await sequenceFixture();
    for (const kind of ['duplicate', 'anchor', 'budget', 'progress']) {
      const intent = structuredClone(f.intent);
      if (kind === 'duplicate') intent.sequence!.remaining[0].operationId = intent.operationId;
      if (kind === 'anchor') intent.sequence!.anchor.writeRevision.revisionSha256 = 'f'.repeat(64);
      if (kind === 'budget') intent.sequence!.remaining = Array(68).fill(intent.sequence!.remaining[0]);
      if (kind === 'progress') intent.sequence!.completedSteps = -1;
      await expect(f.service.stageNearbyNativeIntent(intent, f.preferences.epoch, f.sessionId, () => {})).rejects.toThrow();
      expect(await f.service.readNearbyNativeJournal(f.sessionId)).toBeUndefined();
    }
  });
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
