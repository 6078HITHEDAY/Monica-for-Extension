import { expect, it, vi } from 'vitest';
import { createLoginItem, type ProviderAccount } from '../core/model';
import { type BitwardenCipherCopyRecord } from '../core/bitwarden-transfer-journal';
import { bitwardenBatchOrder, bitwardenBatchResult, bitwardenBatchSnapshotHash, bitwardenBatchSourceHash, normalizeBitwardenBatchRequest, type BitwardenBatchIntent } from '../core/bitwarden-batch-transfer';
import { ssoLogicalId, resolveSsoAccount } from '../core/sso-links';
import { prepareBitwardenTransferCipher, verifyBitwardenTransferCipher } from '../providers/bitwarden/bitwarden-transfer-cipher';
import { encodeBitwardenCipher } from '../providers/bitwarden/bitwarden-cipher-codec';
import { executeBitwardenCipherCopy, type BitwardenCopyRemote } from '../providers/bitwarden/bitwarden-transfer-execution';
import { mdbx2TransferOperationScope as hash } from '../providers/mdbx2/mdbx2-transfer-identity';
import { bytesToBase64 } from './encoding';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';
import { MemoryVaultDeviceKeyStore } from './vault-device-key';
import { createSourceRecord } from '../core/source-records';
import { encryptBitwardenString } from '../providers/bitwarden/bitwarden-crypto';
import { executeBitwardenBatchFolders, readBitwardenBatchFolders } from '../providers/bitwarden/bitwarden-batch-folders';

const sourceKey = { encKey: new Uint8Array(32).fill(5), macKey: new Uint8Array(32).fill(6) };
const targetKey = { encKey: new Uint8Array(32).fill(20), macKey: new Uint8Array(32).fill(21) };
const target: ProviderAccount = { id: 'destination', kind: 'bitwarden', name: 'Synthetic destination', enabled: true, isDefaultSaveTarget: false,
  config: { apiUrl: 'https://example.invalid/api', vaultKeyEnc: bytesToBase64(targetKey.encKey), vaultKeyMac: bytesToBase64(targetKey.macKey) } };

async function fixture() {
  const base = createLoginItem({ title: 'Same title', password: 'Base password' });
  const sso = { ...createLoginItem({ title: 'Same title', password: '' }), loginType: 'SSO' as const, ssoProvider: 'github', ssoRefEntryId: 7, ssoRefLogicalId: ssoLogicalId(base) };
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore(), keys = new MemoryVaultDeviceKeyStore();
  let vault = new SecureVaultService(storage, sessions, Date.now, keys);
  await vault.setup('', [base, sso]); await vault.upsertProvider(target);
  const state = await vault.readState();
  const request = normalizeBitwardenBatchRequest({ itemIds: [sso.id], targetProviderId: target.id, action: 'copy', preserveCategories: false });
  const copies: BitwardenCipherCopyRecord[] = [];
  for (const source of [sso, base]) {
    const native = { ...await encodeBitwardenCipher(source, sourceKey), id: source.id, revisionDate: source.updatedAt };
    const prepared = await prepareBitwardenTransferCipher({ source: native, operationId: request.operationId, copyId: crypto.randomUUID(),
      targetProviderId: target.id, sourceOwnerKey: sourceKey, targetOwnerKey: targetKey, deferSsoBinding: true });
    copies.push({ version: 1, revision: 0, target, prepared, sourceItemIds: [source.id],
      sourceSnapshotSha256: await bitwardenBatchSourceHash(state, [source.id]), files: [], attachmentReceipts: [], stage: 'prepared', batchOperationId: request.operationId });
  }
  const batch: BitwardenBatchIntent = { version: 1, request, requestHash: await hash(request), snapshotHash: await bitwardenBatchSnapshotHash(state, request),
    target, status: 'writing', plan: { ...request, items: [sso, base].map(item => ({ sourceItemId: item.id, kind: item.kind, title: item.title,
      sourcePath: [], targetPath: [], pathIncomplete: false, effectiveAction: 'copy' })), transferableCount: 2, blockedCount: 0, requiresMoveConfirmation: false, warnings: [] },
    units: [{ copyId: copies[0].prepared.copyId, sources: [{ id: sso.id, kind: 'login' }], ssoTargetCopyId: copies[1].prepared.copyId },
      { copyId: copies[1].prepared.copyId, sources: [{ id: base.id, kind: 'login' }] }] };
  const raw: Record<string, unknown>[] = [];
  const remote: BitwardenCopyRemote = {
    list: vi.fn(async () => structuredClone(raw)), read: vi.fn(async id => structuredClone(raw.find(row => row.id === id) || null)),
    create: vi.fn(async payload => { const row = { ...payload, id: `remote-${raw.length}`, revisionDate: new Date().toISOString() }; raw.push(row); return row; }),
    upload: vi.fn(async () => { throw new Error('Unexpected upload'); }), readFile: vi.fn(async () => { throw new Error('Unexpected download'); })
  };
  return { base, sso, batch, copies, storage, sessions, remote, raw, get vault() { return vault; },
    stage: () => vault.stageBitwardenBatch(batch, copies),
    restart: () => { vault = new SecureVaultService(storage, sessions, Date.now, keys); },
    run: async (copyId: string) => {
      const store = await vault.openBitwardenCipherCopyStore(); await store.materialize(copyId);
      return executeBitwardenCipherCopy(copyId, store, remote, targetKey);
    } };
}

it('stages the whole graph atomically and copies in dependency order across a restart', async () => {
  const f = await fixture(); await f.stage();
  expect(bitwardenBatchOrder(f.batch.units).map(row => row.copyId)).toEqual([f.copies[1].prepared.copyId, f.copies[0].prepared.copyId]);
  await expect(f.run(f.copies[0].prepared.copyId)).rejects.toThrow('关联记录尚未确认'); expect(f.remote.create).not.toHaveBeenCalled();
  const copiedBase = await f.run(f.copies[1].prepared.copyId); expect(copiedBase.stage).toBe('verified');
  f.restart();
  const copiedSso = await f.run(f.copies[0].prepared.copyId); expect(copiedSso.stage).toBe('verified');
  const items = [...copiedBase.verifiedItems!, ...copiedSso.verifiedItems!], owner = items.find(row => row.kind === 'login' && row.loginType === 'SSO')!;
  expect(owner).toMatchObject({ ssoRefLogicalId: 'password:bitwarden:remote-0' });
  expect(owner.kind === 'login' && owner.ssoRefEntryId).toBeUndefined();
  expect(owner.kind === 'login' && resolveSsoAccount(owner, items)?.id).toBe(copiedBase.verifiedItems![0].id);
  expect(f.remote.create).toHaveBeenCalledTimes(2); expect((await f.vault.readState()).items).toEqual([f.base, f.sso]);
  expect(bitwardenBatchResult(f.batch, [copiedSso, copiedBase])).toMatchObject({ completedCount: 2, blockedCount: 0, failedCount: 0 });
});

it('never executes an unresolved template or materializes twice with another server identity', async () => {
  const f = await fixture(); await f.stage(); const copy = f.copies[0], store = await f.vault.openBitwardenCipherCopyStore();
  await expect(executeBitwardenCipherCopy(copy.prepared.copyId, store, f.remote, targetKey)).rejects.toThrow();
  await expect(verifyBitwardenTransferCipher(copy.prepared, { ...JSON.parse(copy.prepared.payloadJson), id: 'should-not-exist', revisionDate: new Date().toISOString() }, targetKey)).rejects.toThrow();
  expect(f.remote.list).not.toHaveBeenCalled();
  await f.run(f.copies[1].prepared.copyId);
  const once = await store.materialize(copy.prepared.copyId), twice = await store.materialize(copy.prepared.copyId);
  expect(twice).toEqual(once); expect(once.prepared.pendingSso).toBeUndefined(); expect(once.prepared.boundSso?.targetCipherId).toBe('remote-0');
});

it('retains the originally reviewed graph when sources change after staging', async () => {
  const f = await fixture(); await f.stage();
  await f.vault.upsertItem({ ...f.base, password: 'Later local edit' });
  await f.vault.upsertItem({ ...f.sso, ssoRefLogicalId: undefined, ssoRefEntryId: undefined });
  await f.run(f.copies[1].prepared.copyId); const copy = await f.run(f.copies[0].prepared.copyId);
  expect(copy.verifiedItems![0]).toMatchObject({ ssoRefLogicalId: 'password:bitwarden:remote-0' });
  expect((await f.vault.readState()).items[0]).toMatchObject({ password: 'Later local edit' });
});

it('leaves neither partial graph nor partial copy records when the encrypted transaction fails', async () => {
  const f = await fixture(), before = await f.storage.read();
  const write = vi.spyOn(f.storage, 'write').mockRejectedValueOnce(new Error('Synthetic storage failure'));
  await expect(f.stage()).rejects.toThrow('storage failure'); expect(await f.storage.read()).toEqual(before);
  write.mockRestore(); f.restart(); expect((await f.vault.readState()).bitwardenCipherCopies).toBeUndefined();
  await f.stage(); expect((await f.vault.readState()).bitwardenCipherCopies).toHaveLength(2);
});

it('rejects changed sources, omitted dependencies, a substituted source kind, or a cycle before creation', async () => {
  const f = await fixture();
  const partial = structuredClone(f.batch); partial.units.pop(); await expect(f.vault.stageBitwardenBatch(partial, f.copies)).rejects.toThrow();
  const altered = structuredClone(f.batch); altered.units[0].sources[0].kind = 'card'; altered.plan.items[0].kind = 'card';
  await expect(f.vault.stageBitwardenBatch(altered, f.copies)).rejects.toThrow();
  const cyclic = structuredClone(f.batch); cyclic.units[1].ssoTargetCopyId = cyclic.units[0].copyId;
  await expect(f.vault.stageBitwardenBatch(cyclic, f.copies)).rejects.toThrow('循环');
  await f.vault.upsertItem({ ...f.base, password: 'Changed before confirmation' });
  await expect(f.stage()).rejects.toThrow('已变化'); expect(f.remote.create).not.toHaveBeenCalled();
});

async function completedFixture() {
  const f = await fixture(); await f.stage();
  const one = await f.run(f.copies[1].prepared.copyId), two = await f.run(f.copies[0].prepared.copyId);
  const copies = [one, two], state = await f.vault.readState(), items = [...state.items, ...copies.flatMap(row => row.verifiedItems!)];
  const records = await Promise.all(f.raw.map(raw => createSourceRecord({ providerId: target.id, remoteId: String(raw.id),
    revision: String(raw.revisionDate), format: 'bitwarden-cipher', encoding: 'json', payload: JSON.stringify(raw) })));
  const guard = { expectedAccount: target, bitwardenBatchTransfer: { operationId: f.batch.request.operationId, sessionId: (await f.vault.passkeySessionId())! } };
  return { f, copies, state, items, records, guard,
    adopt: () => f.vault.applyProviderSync(target.id, items, undefined, [], records, state.items, [], [], false, [], guard) };
}

it('adopts the entire verified graph and completion in one encrypted write, with restart-safe replay', async () => {
  const a = await completedFixture(), write = vi.spyOn(a.f.storage, 'write');
  await a.adopt(); expect(write).toHaveBeenCalledTimes(1);
  const state = await a.f.vault.readState(); expect(state.items).toHaveLength(4); expect(state.bitwardenBatchTransfers![0].status).toBe('completed');
  expect(state.bitwardenBatchTransfers![0].result?.completedCount).toBe(2); expect(state.sourceRecords).toHaveLength(2);
  await a.f.vault.upsertItem({ ...state.items[2], notes: 'Later target edit' });
  const before = await a.f.storage.read(); a.f.restart();
  await a.adopt(); expect(await a.f.storage.read()).toEqual(before); expect((await a.f.vault.readState()).items[2].notes).toBe('Later target edit');
});

it('keeps the complete graph recoverable if final adoption aborts or its reply is lost', async () => {
  const a = await completedFixture(), before = await a.f.storage.read();
  const write = vi.spyOn(a.f.storage, 'write').mockRejectedValueOnce(new Error('Synthetic abort'));
  await expect(a.adopt()).rejects.toThrow('abort'); expect(await a.f.storage.read()).toEqual(before); write.mockRestore();
  const originalWrite = a.f.storage.write.bind(a.f.storage);
  const lost = vi.spyOn(a.f.storage, 'write').mockImplementationOnce(async envelope => { await originalWrite(envelope); throw new Error('Synthetic lost reply'); });
  await expect(a.adopt()).rejects.toThrow('lost reply'); lost.mockRestore(); a.f.restart(); await a.adopt();
  expect((await a.f.vault.readState()).items).toHaveLength(4); expect((await a.f.vault.readState()).bitwardenBatchTransfers![0].status).toBe('completed');
});

it.each(['missing-cipher','changed-revision','edited-projection','missing-sibling'] as const)('refuses incomplete final adoption (%s)', async mode => {
  const a = await completedFixture(), before = await a.f.storage.read();
  if (mode === 'missing-cipher') a.records.pop();
  if (mode === 'changed-revision') { const raw = JSON.parse(a.records[0].payload); raw.revisionDate = '2026-10-13T00:00:00.000Z'; a.records[0].payload = JSON.stringify(raw); }
  if (mode === 'edited-projection') a.items[2].notes = 'Tampered projection';
  if (mode === 'missing-sibling') a.items.pop();
  await expect(a.adopt()).rejects.toThrow(); expect(await a.f.storage.read()).toEqual(before);
  expect((await a.f.vault.readState()).bitwardenBatchTransfers![0].status).toBe('writing');
});

it('blocks ordinary sync from adopting a half-finished graph', async () => {
  const f = await fixture(); await f.stage(); const copy = await f.run(f.copies[1].prepared.copyId), state = await f.vault.readState();
  await expect(f.vault.applyProviderSync(target.id, [...state.items, ...copy.verifiedItems!], undefined, [], [], state.items)).rejects.toThrow('部分副本');
  expect((await f.vault.readState()).items).toHaveLength(2);
});

it('rejects a final result from an earlier unlock session', async () => {
  const a = await completedFixture(), session = (await a.f.sessions.read())!; await a.f.vault.lock();
  await a.f.sessions.write({ ...session, id: crypto.randomUUID() });
  await expect(a.adopt()).rejects.toThrow('locked'); expect((await a.f.vault.readState()).items).toHaveLength(2);
});

async function folderFixture() {
  const f = await fixture(), encryptedName = await encryptBitwardenString('Accounts/Games', targetKey);
  f.batch.folders = [{ key: 'folder-one', name: 'Accounts/Games', encryptedName, stage: 'prepared' }];
  for (const unit of f.batch.units) unit.folderKey = 'folder-one';
  for (const copy of f.copies) copy.prepared.pendingFolderKey = 'folder-one';
  const folders: Array<{ id: string; name: string }> = [];
  const remote = { list: vi.fn(async () => structuredClone(folders)), create: vi.fn(async (name: string) => {
    const row = { id: `folder-${folders.length}`, name }; folders.push(row); return row;
  }) };
  return { f, folders, remote, run: async () => executeBitwardenBatchFolders(f.batch.request.operationId, await f.vault.openBitwardenBatchStore(), remote, targetKey) };
}

it('recovers a lost folder-create reply after restart and binds both folder and SSO exactly once', async () => {
  const a = await folderFixture(); await a.f.stage();
  const create = a.remote.create.getMockImplementation()!;
  a.remote.create.mockImplementationOnce(async name => { await create(name); throw new Error('Lost folder reply'); });
  await expect(a.run()).rejects.toThrow('Lost folder reply');
  await expect(a.f.run(a.f.copies[1].prepared.copyId)).rejects.toThrow('文件夹');
  expect(a.f.remote.create).not.toHaveBeenCalled(); a.f.restart(); await a.run();
  await a.f.run(a.f.copies[1].prepared.copyId); const sso = await a.f.run(a.f.copies[0].prepared.copyId);
  expect(JSON.parse(sso.prepared.payloadJson).folderId).toBe('folder-0');
  expect(sso.prepared.boundSso?.targetCipherId).toBe('remote-0');
  await a.run(); expect(a.remote.create).toHaveBeenCalledTimes(1);
});

it.each(['missing', 'duplicate', 'same-plaintext', 'renamed'] as const)('refuses unsafe folder-create recovery: %s', async mode => {
  const a = await folderFixture(); await a.f.stage(); const store = await a.f.vault.openBitwardenBatchStore();
  await store.advanceFolder(a.f.batch.request.operationId, 'folder-one', a.f.batch.folders![0], 'attempted');
  if (mode === 'duplicate') a.folders.push(...[0,1].map(i => ({ id: `duplicate-${i}`, name: a.f.batch.folders![0].encryptedName })));
  if (mode === 'same-plaintext') a.folders.push({ id: 'another-create', name: await encryptBitwardenString('Accounts/Games', targetKey) });
  if (mode === 'renamed') a.folders.push({ id: 'old-id', name: await encryptBitwardenString('Renamed', targetKey) });
  await expect(a.run()).rejects.toThrow(); expect(a.remote.create).not.toHaveBeenCalled();
});

it('persists the attempt before network and refuses cancelled, raced, or old-session folder handles', async () => {
  const a = await folderFixture(); await a.f.stage(); const store = await a.f.vault.openBitwardenBatchStore();
  const write = vi.spyOn(a.f.storage, 'write').mockRejectedValueOnce(new Error('Abort folder transaction'));
  await expect(a.run()).rejects.toThrow('Abort folder transaction'); expect(a.remote.create).not.toHaveBeenCalled(); write.mockRestore();
  const expected = a.f.batch.folders![0]; await store.advanceFolder(a.f.batch.request.operationId, expected.key, expected, 'attempted');
  await expect(store.advanceFolder(a.f.batch.request.operationId, expected.key, expected, 'attempted')).rejects.toThrow();
  await expect(store.cancel(a.f.batch.request.operationId)).rejects.toThrow('已尝试');
  const session = (await a.f.sessions.read())!; await a.f.vault.lock(); await a.f.sessions.write({ ...session, id: crypto.randomUUID() });
  await expect(store.read(a.f.batch.request.operationId)).rejects.toThrow('locked');
  const b = await folderFixture(); await b.f.stage(); await (await b.f.vault.openBitwardenBatchStore()).cancel(b.f.batch.request.operationId);
  await expect(b.run()).rejects.toThrow('取消'); expect(b.remote.list).not.toHaveBeenCalled();
});

it.each([undefined, {}, [{ id: 'same', name: '2.a' }, { id: 'same', name: '2.b' }], [{ id: 'a', Id: 'b', name: '2.a' }]])('refuses incomplete folder inventories', raw => {
  expect(() => readBitwardenBatchFolders(raw)).toThrow();
});

it('allows token rotation without invalidating a preview but retains key/config guards', async () => {
  const f = await fixture(), state = await f.vault.readState();
  const rotated = structuredClone(state); rotated.providers.find(row => row.id === target.id)!.config.accessToken = 'new-token';
  expect(await bitwardenBatchSnapshotHash(rotated, f.batch.request)).toBe(f.batch.snapshotHash);
  rotated.providers.find(row => row.id === target.id)!.config.vaultKeyEnc = 'different-key';
  expect(await bitwardenBatchSnapshotHash(rotated, f.batch.request)).not.toBe(f.batch.snapshotHash);
});

it('preparation token CAS preserves concurrent settings/newer tokens and refuses an old unlock', async () => {
  const f = await fixture(), sessionId = (await f.vault.passkeySessionId())!;
  const original = { ...target, config: { ...target.config, accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 1 } };
  await f.vault.upsertProvider(original);
  await f.vault.upsertProvider({ ...original, name: 'Later name', config: { ...original.config, unrelated: true } });
  const next = { ...original.config, accessToken: 'new', refreshToken: 'new-refresh', expiresAt: 2 } as import('../providers/bitwarden/bitwarden-client').BitwardenSessionConfig;
  const result = await f.vault.saveBitwardenTransferSession(original, next, sessionId);
  expect(result).toMatchObject({ name: 'Later name', config: { unrelated: true, accessToken: 'new' } });
  expect((await f.vault.saveBitwardenTransferSession(original, { ...next, accessToken: 'stale' }, sessionId)).config.accessToken).toBe('new');
  const session = (await f.sessions.read())!; await f.vault.lock(); await f.sessions.write({ ...session, id: crypto.randomUUID() });
  await expect(f.vault.saveBitwardenTransferSession(result, next, sessionId)).rejects.toThrow('locked');
});

it('final adoption merges fresh server metadata while retaining concurrent account settings and tokens', async () => {
  const a = await completedFixture();
  await a.f.vault.upsertProvider({ ...target, name: 'Later account name', config: { ...target.config, preference: 'later', accessToken: 'new-token' } });
  await a.f.vault.applyProviderSync(target.id, a.items, { config: { ...target.config, preference: 'stale', accessToken: 'old-token', accountState: { fresh: true } } },
    [], a.records, a.state.items, [], [], false, [], a.guard);
  const state = await a.f.vault.readState();
  expect(state.providers.find(row => row.id === target.id)).toMatchObject({ name: 'Later account name',
    config: { preference: 'later', accessToken: 'new-token', accountState: { fresh: true } } });
  expect(state.bitwardenBatchTransfers![0].status).toBe('completed');
});
