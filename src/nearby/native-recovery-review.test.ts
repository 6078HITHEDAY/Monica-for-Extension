import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { reviewNearbyNativeRecovery } from './native-recovery-review';
import { nearbyNativeIntent, readNearbyNativeJournal } from './native-journal';
import { nativeNearbySource } from './native-adapter';
import { advanceMdbx2ContentWriteAnchor, type Mdbx2ContentWriteAnchor } from '../providers/mdbx2/content-write-anchor';
import type { Mdbx2CommitHistoryItem, Mdbx2CommitDiffItem } from '../providers/mdbx2/native-contract';
import type { Mdbx2NativeClient } from '../providers/mdbx2/native-client';
import { SecureVaultService } from '../security/secure-vault-service';
import { MemoryVaultStorage } from '../security/vault-storage';
import { MemoryVaultSessionStore } from '../security/vault-session';
import { MemoryVaultDeviceKeyStore } from '../security/vault-device-key';
import * as writer from '../providers/mdbx2/content-write';

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore();
  const store = new SecureVaultService(storage, sessions, Date.now, new MemoryVaultDeviceKeyStore());
  await store.setup(''); const sessionId = (await store.passkeySessionId())!;
  const providerId = randomUUID(), vaultHandle = randomUUID(), vaultId = randomUUID(), collectionId = randomUUID();
  await store.upsertProvider({ id: providerId, name: 'Synthetic', kind: 'mdbx2', enabled: true, isDefaultSaveTarget: false, config: { vaultHandle } });
  await store.updateNearbyPreferences({ kind: 'source', providerId }, (await store.nearbySessionPreferences(sessionId)).epoch, sessionId);
  const preferences = await store.nearbySessionPreferences(sessionId);
  const anchor: Mdbx2ContentWriteAnchor = { writeRevision: { vaultId, revisionSha256: '' }, branches: [{ branchId: randomUUID(), branchName: 'main', headCommitId: randomUUID() }] };
  const hash = createHash('sha256');
  for (const text of ['monica-extension-write-revision-v1', vaultId, ...anchor.branches.flatMap(b => [b.branchId, b.branchName, b.headCommitId])]) {
    const bytes = Buffer.from(text), length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(bytes.length)); hash.update(length).update(bytes);
  }
  anchor.writeRevision.revisionSha256 = hash.digest('hex');
  const assetId = randomUUID(), secret = 'synthetic retained recovery bytes';
  const original = await nearbyNativeIntent({ providerId, vaultHandle, sourceHash: 'a'.repeat(64),
    write: { operationId: randomUUID(), writeRevision: anchor.writeRevision, plan: { commands: [], attachments: [{ kind: 'create', attachmentId: randomUUID(), collectionId, fileName: 'synthetic.bin', assetId }] }, assets: [{ id: assetId, bytes: new TextEncoder().encode(secret) }] },
    remainingWrites: [{ operationId: randomUUID(), plan: { commands: [{ kind: 'collection-rename', collectionId, title: 'Incoming folder' }], attachments: [] }, assets: [] }],
    bindings: [{ recordId: 'incoming-folder', clockJson: '{"peer":1}', dataJson: '{"title":"Incoming folder"}', localId: `mdbx:${providerId}:folder:${collectionId}`, deleted: false }]
  }, preferences.replicaStorageId, anchor);
  await store.stageNearbyNativeIntent(original, preferences.epoch, sessionId, () => {});
  const current = await store.advanceNearbyNativeIntent(original.operationId, randomUUID(), sessionId, () => {});
  await expect(store.finishNearbyNativeIntent(current.operationId, sessionId, () => {}, true)).rejects.toMatchObject({ code: 'native-sequence-conflict' });
  const intent = (await store.readNearbyNativeJournal(sessionId))!.intent!;
  const commitId = randomUUID(), entryId = randomUUID();
  const after = await advanceMdbx2ContentWriteAnchor(intent.sequence!.anchor, commitId);
  const history: Mdbx2CommitHistoryItem = { commitId, deviceId: randomUUID(), localSeq: 3, commitKind: 'change', changeScope: 'entry', createdAt: '2026-10-16T00:00:00Z', operationId: randomUUID(), operationKind: 'monica-content-adoption-v1', branchName: 'main', changes: [{ objectType: 'entry', objectId: entryId, action: 'update', fields: ['title', 'payload'] }], parentIds: [intent.sequence!.anchor.branches[0].headCommitId], legacy: false };
  const diff: Mdbx2CommitDiffItem = { commitId, objectType: 'entry', objectId: entryId, collectionId, previousDeleted: false, currentDeleted: false, changedFields: ['title', 'payload'], payloadChanged: true, createdAt: history.createdAt };
  const baseline: Mdbx2CommitHistoryItem = { ...history, commitId: history.parentIds[0], localSeq: 2, changes: [], parentIds: [randomUUID()] };
  const genesis: Mdbx2CommitHistoryItem = { ...baseline, commitId: randomUUID(), localSeq: 0, deviceId: 'monica-browser', legacy: true, changeScope: 'vault-meta', operationId: undefined, operationKind: undefined, branchName: undefined, parentIds: [] };
  const client = { listCommitHistory: vi.fn().mockResolvedValue({ items: [history, baseline, genesis] }), listCommitDiff: vi.fn().mockResolvedValue({ items: [diff] }),
    readWriteRevision: vi.fn().mockImplementation(async () => ({ ...after.writeRevision })), request: vi.fn().mockResolvedValue(after),
    hello: vi.fn().mockResolvedValue({ supportsContentWrite: true, supportsContentWriteAnchor: true, supportsVaultWriteRevision: true }) };
  let epoch = preferences.epoch; const abort = new AbortController();
  const makeAdapter = () => nativeNearbySource({ store, client: client as unknown as Mdbx2NativeClient, providerId, replicaStorageId: preferences.replicaStorageId, sessionId,
    epoch: () => epoch, signal: abort.signal, assertActive: () => {}, exclusive: work => work() });
  const write = vi.spyOn(writer, 'writeMdbx2Content').mockImplementation(async (_client, _handle, value) => ({ operationId: value.operationId, commitId: randomUUID(), alreadyCommitted: false }));
  return { store, storage, sessions, sessionId, preferences, intent, after, history, baseline, diff, client, vaultHandle, makeAdapter, write, abort, secret, setEpoch: () => { epoch = randomUUID(); } };
}

it('reviews without writing, then persists explicit approval before exact replay and retains completed bytes', async () => {
  const f = await fixture(), adapter = f.makeAdapter();
  const view = await adapter.reviewRecovery!(f.intent.operationId);
  expect(view).toMatchObject({ editedEntries: 1, interveningCommits: 1, remainingSteps: 1 });
  expect(JSON.stringify(view)).not.toContain(f.intent.vaultId); expect(f.write).not.toHaveBeenCalled();
  expect((await f.store.readNearbyNativeJournal(f.sessionId))!.intent).toEqual(f.intent);
  f.write.mockImplementation(async (_client, _handle, value) => {
    const saved = (await f.store.readNearbyNativeJournal(f.sessionId))!.intent!;
    expect(saved.operationId).toBe(value.operationId); expect(value.operationId).not.toBe(f.intent.operationId);
    expect(saved.sequence!.completed).toEqual(f.intent.sequence!.completed);
    expect(saved.sequence!.resolutions).toHaveLength(1); expect(saved.write.plan).toEqual(f.intent.write.plan);
    expect(value.writeRevision).toEqual(f.after.writeRevision);
    expect(JSON.stringify(await f.storage.read())).not.toContain(Buffer.from(f.secret).toString('base64'));
    return { operationId: value.operationId, commitId: randomUUID(), alreadyCommitted: false };
  });
  expect(await adapter.confirmRecovery!(view.reviewId)).toEqual(f.intent.acknowledgements);
  expect((await f.store.readNearbyNativeJournal(f.sessionId))!.intent).toBeUndefined();
  await expect(f.store.assertNoNearbyNativeSequence(f.preferences.localProviderId)).resolves.toBeUndefined();
  await expect(adapter.confirmRecovery!(view.reviewId)).rejects.toMatchObject({ code: 'native-recovery-changed' });
  expect(f.write).toHaveBeenCalledTimes(1);
});

it.each(['revision', 'epoch', 'expiry', 'token', 'cancel'] as const)('refuses a changed %s between review and confirmation', async kind => {
  const f = await fixture(), adapter = f.makeAdapter(), view = await adapter.reviewRecovery!(f.intent.operationId);
  if (kind === 'revision') f.client.readWriteRevision.mockResolvedValue({ ...f.after.writeRevision, revisionSha256: 'f'.repeat(64) });
  if (kind === 'epoch') f.setEpoch();
  if (kind === 'expiry') { const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 120001); }
  if (kind === 'cancel') f.abort.abort();
  await expect(adapter.confirmRecovery!(kind === 'token' ? randomUUID() : view.reviewId)).rejects.toThrow();
  expect(f.write).not.toHaveBeenCalled(); expect((await f.store.readNearbyNativeJournal(f.sessionId))!.intent).toEqual(f.intent);
});

it('recovers a persisted approval after its reply is lost without needing another approval', async () => {
  const f = await fixture(), adapter = f.makeAdapter(), view = await adapter.reviewRecovery!(f.intent.operationId);
  const save = f.storage.write.bind(f.storage);
  f.storage.write = async envelope => { await save(envelope); throw Error('synthetic stored reply loss'); };
  await expect(adapter.confirmRecovery!(view.reviewId)).rejects.toThrow('reply loss'); f.storage.write = save;
  expect(f.write).not.toHaveBeenCalled();
  const stored = (await f.store.readNearbyNativeJournal(f.sessionId))!.intent!;
  expect(stored.operationId).not.toBe(f.intent.operationId); expect(stored.sequence!.resolutions).toHaveLength(1);
  expect(await f.makeAdapter().recover(stored.operationId)).toEqual(f.intent.acknowledgements);
  expect(f.write.mock.calls[0][2].operationId).toBe(stored.operationId);
});

it.each(['legacy', 'move', 'delete', 'merge', 'unknown-writer', 'incomplete-diff', 'overlapping-plan', 'old-journal', 'missing-history', 'extra-branch', 'foreign-device', 'sequence-gap', 'duplicate-sequence', 'repeated-cursor'] as const)('retains conflict for %s without guessing from history previews', async kind => {
  const f = await fixture();
  if (kind === 'legacy') f.history.legacy = true;
  if (kind === 'move') f.history.changes[0].fields = ['project_id'];
  if (kind === 'delete') f.diff.currentDeleted = true;
  if (kind === 'merge') f.history.parentIds.push(randomUUID());
  if (kind === 'unknown-writer') f.history.operationKind = 'unknown';
  if (kind === 'incomplete-diff') f.client.listCommitDiff.mockResolvedValue({ items: [] });
  if (kind === 'overlapping-plan') f.intent.write.plan.commands = [{ kind: 'object-delete', objectId: f.diff.objectId, collectionId: f.diff.collectionId! }];
  if (kind === 'old-journal') delete f.intent.sequence!.completed;
  if (kind === 'missing-history') f.client.listCommitHistory.mockResolvedValue({ items: [] });
  if (kind === 'extra-branch') f.after.branches.push({ branchId: randomUUID(), branchName: 'other', headCommitId: randomUUID() });
  if (kind === 'foreign-device') f.baseline.deviceId = randomUUID();
  if (kind === 'sequence-gap') f.history.localSeq = 4;
  if (kind === 'duplicate-sequence') f.history.localSeq = f.baseline.localSeq;
  if (kind === 'repeated-cursor') f.client.listCommitHistory.mockResolvedValue({ items: [], nextCursor: 'loop' });
  await expect(reviewNearbyNativeRecovery(f.client, f.vaultHandle, f.intent, f.after, () => {})).rejects.toThrow();
  expect(f.write).not.toHaveBeenCalled();
});

it('uses complete native sequence history across pages despite reversed timestamps and object-specific parents', async () => {
  const f = await fixture(); f.history.createdAt = '2020-01-01'; f.history.parentIds = [randomUUID()];
  f.client.listCommitHistory.mockResolvedValueOnce({ items: [f.baseline], nextCursor: 'page2' }).mockResolvedValueOnce({ items: [f.history] });
  const proof = await reviewNearbyNativeRecovery(f.client, f.vaultHandle, f.intent, f.after, () => {});
  expect(proof.commitIds).toEqual([f.history.commitId]);
  expect(f.client.listCommitHistory).toHaveBeenNthCalledWith(2, f.vaultHandle, { pageSize: 50, cursor: 'page2' });
});

it('rejects malformed approval history in an encrypted journal', async () => {
  const f = await fixture(), adapter = f.makeAdapter(), view = await adapter.reviewRecovery!(f.intent.operationId);
  f.write.mockRejectedValue(Error('synthetic interruption'));
  await expect(adapter.confirmRecovery!(view.reviewId)).rejects.toThrow('interruption');
  const j = (await f.store.readNearbyNativeJournal(f.sessionId))!;
  j.intent!.sequence!.resolutions![0].previousOperationId = j.intent!.operationId;
  expect(() => readNearbyNativeJournal(j)).toThrow();
});
