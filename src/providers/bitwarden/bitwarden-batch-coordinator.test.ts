import { expect, it, vi } from 'vitest';
import { createLoginItem, type ProviderAccount, type VaultItem, createEmptyVaultState, type PasskeyItem } from '../../core/model';
import { assertBitwardenLocalMoveSource, readBitwardenBatches } from '../../core/bitwarden-batch-transfer';
import { SecureVaultService } from '../../security/secure-vault-service';
import { MemoryVaultStorage } from '../../security/vault-storage';
import { MemoryVaultSessionStore } from '../../security/vault-session';
import { MemoryVaultDeviceKeyStore } from '../../security/vault-device-key';
import { bytesToBase64 } from '../../security/encoding';
import { ssoLogicalId, resolveSsoAccount } from '../../core/sso-links';
import { createSourceRecord } from '../../core/source-records';
import { decodeBitwardenCipher } from './bitwarden-cipher-codec';
import { readBitwardenBatchResource, assertBitwardenPortableProjection } from './bitwarden-batch-resource';
import { BitwardenBatchTransferCoordinator } from './bitwarden-batch-coordinator';
import type { BitwardenCopyRemote } from './bitwarden-transfer-execution';
import { mdbx2TransferOperationScope as hash } from '../mdbx2/mdbx2-transfer-identity';
import { prepareMdbx2TransferSourceDeletion } from '../mdbx2/mdbx2-transfer-source-delete';
import type { Mdbx2SourceDeletionIntent } from '../../core/mdbx2-source-deletion';
import type { Mdbx2ObjectBatchResult } from '../mdbx2/native-contract';
import { ProviderOperationQueue } from '../../background/provider-operation-queue';
import type { BitwardenMdbxMoveGroup } from '../../core/bitwarden-mdbx-move';

async function fixture(extra: VaultItem[] = [], native = false) {
  const base = createLoginItem({ title: 'Same name', password: 'Synthetic secret' }); base.categoryName = 'Accounts';
  const sso = { ...createLoginItem({ title: 'Same name' }), loginType: 'SSO' as const, ssoRefLogicalId: ssoLogicalId(base), categoryName: 'Accounts' };
  const source: ProviderAccount = { id: 'native-source', kind: 'mdbx2', name: 'Synthetic MDBX', enabled: true, isDefaultSaveTarget: false,
    config: { vaultHandle: 'handle', nativeVaultId: 'vault' } };
  if (native) for (const item of [base, sso, ...extra]) item.providerRefs = [{ providerId: source.id, remoteId: `native-${item.id}`, remoteFolderId: 'folder', revision: 'head' }];
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore(), device = new MemoryVaultDeviceKeyStore();
  let vault = new SecureVaultService(storage, sessions, Date.now, device);
  await vault.setup('', [base, sso, ...extra]);
  if (native) await vault.upsertProvider(source);
  const key = { encKey: new Uint8Array(32).fill(3), macKey: new Uint8Array(32).fill(4) };
  const account: ProviderAccount = { id: 'target', kind: 'bitwarden', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false,
    config: { apiUrl: 'https://example.invalid/api', vaultKeyEnc: bytesToBase64(key.encKey), vaultKeyMac: bytesToBase64(key.macKey) } };
  await vault.upsertProvider(account);
  const raw: Record<string, unknown>[] = [], folders: { id: string; name: string }[] = [];
  const remote: BitwardenCopyRemote & { dispose(): void } = {
    list: vi.fn(async () => structuredClone(raw)), read: vi.fn(async id => structuredClone(raw.find(row => row.id === id) || null)),
    create: vi.fn(async payload => { const row = { ...payload, id: `cipher-${raw.length}`, revisionDate: '2026-10-12T00:00:00.000Z' }; raw.push(row); return structuredClone(row); }),
    upload: vi.fn(async () => { throw new Error('Unexpected upload'); }), readFile: vi.fn(async () => { throw new Error('Unexpected download'); }), dispose() {}
  };
  const folderRemote = { list: vi.fn(async () => structuredClone(folders)), create: vi.fn(async (name: string) => {
    const row = { id: `folder-${folders.length}`, name }; folders.push(row); return row;
  }) };
  const provider = { sync: vi.fn(async () => {
    const state = await vault.readState(), decoded = (await Promise.all(raw.map(row => decodeBitwardenCipher(row, account.id, key)))).flatMap(row => row.items);
    return { items: [...state.items.filter(row => !row.providerRefs.some(ref => ref.providerId === account.id)), ...decoded], conflicts: [], warnings: [],
      sourceRecords: await Promise.all(raw.map(row => createSourceRecord({ providerId: account.id, remoteId: String(row.id), revision: String(row.revisionDate),
        format: 'bitwarden-cipher', encoding: 'json', payload: JSON.stringify(row) }))) };
  }) };
  const resource = vi.fn((state, items, preserve) => readBitwardenBatchResource(state, items, preserve, {
    context: async () => { throw new Error('Unexpected source read'); }, files: async () => [],
    portableSource: async (_account, item) => ({ item: { ...item, providerRefs: [] }, files: [], path: [], fingerprint: await hash(item) })
  }));
  const deleted = new Set<string>();
  const receipts = new Map<string, Mdbx2ObjectBatchResult>();
  const mdbx = {
    verify: vi.fn(async (_state, _account, items: VaultItem[]) => { if (items.some(item => deleted.has(item.id))) throw new Error('Native source deleted'); return { vaultId: 'vault' }; }),
    prepare: vi.fn(async (group: BitwardenMdbxMoveGroup, targetId: string, verify: () => Promise<void>) => prepareMdbx2TransferSourceDeletion({
      vaultStatus: async () => ({ vaultHandle: 'handle', vaultId: 'vault', available: true, open: true }),
      readWriteRevision: async () => ({ vaultId: 'vault', revisionSha256: 'a'.repeat(64) }),
      resolveObjectOperation: async () => ({ known: false, committed: false })
    }, group.account, group.sources, group.id, targetId, group.vaultId, verify)),
    remove: vi.fn(async (_account: ProviderAccount, items: VaultItem[], _id: string, _target: string, intent: Mdbx2SourceDeletionIntent): Promise<Mdbx2ObjectBatchResult> => {
      if (!receipts.has(intent.operationScope)) {
        receipts.set(intent.operationScope, { operationId: 'native-operation', commitId: 'deleted-commit', changed: true,
          items: items.map(item => ({ kind: 'delete', logicalObjectId: `native:${item.providerRefs[0].remoteId}`, objectId: item.providerRefs[0].remoteId!, changed: true })) });
        items.forEach(item => deleted.add(item.id));
      }
      return structuredClone(receipts.get(intent.operationScope)!);
    })
  };
  const queue = new ProviderOperationQueue();
  const make = () => new BitwardenBatchTransferCoordinator(vault, provider, { resource, folders: async () => structuredClone(folders),
    folderRemote: () => folderRemote, remote: () => remote, exclusive: (id, work) => queue.run(id, work),
    ...(native ? { mdbx } : {}), exclusiveMany: (ids, work) => queue.runMany(ids, work) });
  let coordinator = make();
  return { base, sso, storage, sessions, account, source, raw, folders, remote, folderRemote, provider, resource, mdbx, receipts, queue,
    get vault() { return vault; }, get coordinator() { return coordinator; },
    restart() { coordinator.clear(); vault = new SecureVaultService(storage, sessions, Date.now, device); coordinator = make(); },
    request: { itemIds: [sso.id, ...extra.map(row => row.id)], targetProviderId: account.id, action: 'copy' as const, preserveCategories: true } };
}

async function interruptedMove(native = false) {
  const f = await fixture([], native), input = { ...f.request, action: 'move' as const }, plan = await f.coordinator.plan(input);
  const request = { ...input, operationId: plan.operationId, operationCreatedAt: plan.operationCreatedAt, confirmed: true };
  const create = vi.mocked(f.remote.create).getMockImplementation()!;
  vi.mocked(f.remote.create).mockImplementationOnce(async payload => { await create(payload); throw new Error('Lost first reply'); });
  await expect(f.coordinator.execute(request)).rejects.toThrow('Lost first reply');
  return { current: f, request };
}

it.each([false, true])('keeps edited %s sources and their pending changes while adopting the reviewed copy after restart', async native => {
  const { current: f, request } = await interruptedMove(native);
  await f.vault.upsertItem({ ...f.base, password: 'Later local edit' });
  const before = await f.vault.readState(), original = before.bitwardenBatchTransfers![0];
  await expect(f.coordinator.execute(request)).rejects.toThrow('已变化');
  const reads = f.resource.mock.calls.length;
  const pending = await f.coordinator.keepBoth(f.account.id, request.operationId, true);
  expect(pending).toMatchObject({ canKeepBoth: false, keptBoth: true, request: { action: 'move' }, plan: { action: 'copy', requiresMoveConfirmation: false } });
  expect(Object.keys(pending).sort()).toEqual(['canKeepBoth', 'keptBoth', 'plan', 'request']);
  const saved = (await f.vault.readState()).bitwardenBatchTransfers![0];
  expect(saved).toMatchObject({ version: 4, request: original.request, plan: original.plan, requestHash: original.requestHash,
    resolution: { originalVersion: native ? 3 : 2, kind: 'keep-both', version: 1 } });
  f.restart();
  expect(await f.coordinator.execute(request)).toMatchObject({ action: 'copy', completedCount: 2 });
  const after = await f.vault.readState();
  for (const source of before.items) expect(after.items.find(item => item.id === source.id)).toEqual(source);
  expect(after.mutationQueue).toEqual(before.mutationQueue);
  expect(after.sourceRecords.filter(row => row.providerId !== f.account.id)).toEqual(before.sourceRecords);
  expect(after.items.find(item => item.id !== f.base.id && item.kind === 'login' && item.loginType !== 'SSO')).toMatchObject({ password: 'Synthetic secret' });
  expect(f.resource).toHaveBeenCalledTimes(reads); expect(f.mdbx.remove).not.toHaveBeenCalled(); expect(f.raw).toHaveLength(2);
  expect(await f.coordinator.pending(f.account.id)).toEqual([]);
  expect(() => readBitwardenBatches(after.bitwardenBatchTransfers)).not.toThrow();
});

it.each(['save-failure', 'lost-reply', 'offline'] as const)('makes the keep-both decision durable across %s without early source removal', async failure => {
  const { current: f, request } = await interruptedMove();
  if (failure === 'save-failure') vi.spyOn(f.storage, 'write').mockRejectedValueOnce(new Error('Save failed'));
  if (failure === 'lost-reply') {
    const save = f.vault.keepBitwardenBatchSources.bind(f.vault);
    vi.spyOn(f.vault, 'keepBitwardenBatchSources').mockImplementationOnce(async (...args) => { await save(...args); throw new Error('Reply lost'); });
  }
  const choice = f.coordinator.keepBoth(f.account.id, request.operationId, true);
  if (failure === 'offline') await choice; else await expect(choice).rejects.toThrow();
  f.restart();
  expect((await f.coordinator.pending(f.account.id))[0].keptBoth).toBe(failure !== 'save-failure');
  // A failed save does not authorize a decision. A successful retry preserves
  // the same operation; a lost response does not need another confirmation.
  if (failure === 'save-failure') await f.coordinator.keepBoth(f.account.id, request.operationId, true);
  const stable = await f.storage.read();
  await f.coordinator.keepBoth(f.account.id, request.operationId, true); expect(await f.storage.read()).toEqual(stable);
  if (failure === 'offline') {
    f.provider.sync.mockRejectedValueOnce(new Error('Offline'));
    await expect(f.coordinator.execute(request)).rejects.toThrow('Offline'); f.restart();
  }
  expect(await f.coordinator.execute(request)).toMatchObject({ action: 'copy', completedCount: 2 });
  expect((await f.vault.readState()).items.find(row => row.id === f.base.id)).toEqual(f.base);
  expect(f.raw).toHaveLength(2);
});

it('preserves a newly added local file and user-deleted source instead of restoring the reviewed snapshot', async () => {
  const { current: f, request } = await interruptedMove();
  const bytes = new TextEncoder().encode('Later file');
  const attachment = { attachmentId: 'later-file', itemId: f.base.id, fileName: 'later.txt', sizeBytes: bytes.length,
    dataBase64: bytesToBase64(bytes), sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join(''), protected: true, mediaType: 'text/plain' };
  await f.vault.mutateLocalAttachment({ operationId: crypto.randomUUID(), providerId: 'local', itemId: f.base.id,
    attachmentId: attachment.attachmentId, mode: 'create', attachment }, (await f.vault.passkeySessionId())!);
  await f.vault.deleteItem(f.sso.id);
  const before = await f.vault.readState();
  await f.coordinator.keepBoth(f.account.id, request.operationId, true); f.restart();
  expect(await f.coordinator.execute(request)).toMatchObject({ action: 'copy' });
  const after = await f.vault.readState();
  expect(after.localItemAttachments).toEqual(before.localItemAttachments);
  expect(after.localAttachmentReceipts).toEqual(before.localAttachmentReceipts);
  expect(after.items.find(row => row.id === f.sso.id)).toEqual(before.items.find(row => row.id === f.sso.id));
  expect(f.remote.upload).not.toHaveBeenCalled();
});

it('rejects unconfirmed, wrong-target and stale-session decisions without writing', async () => {
  const { current: f, request } = await interruptedMove(), sessionId = (await f.vault.passkeySessionId())!, before = await f.storage.read();
  await expect(f.coordinator.keepBoth(f.account.id, request.operationId, false)).rejects.toThrow('先确认');
  await expect(f.coordinator.keepBoth('another', request.operationId, true)).rejects.toThrow('不匹配');
  expect(await f.storage.read()).toEqual(before);
  await f.vault.lock(); await f.vault.unlock('');
  await expect(f.vault.keepBitwardenBatchSources(f.account.id, request.operationId, true, sessionId)).rejects.toThrow();
  expect(await f.storage.read()).toEqual(before);
});

it.each([false, true])('refuses keep-both after native deletion authorization (committed=%s)', async committed => {
  const f = await fixture([], true), input = { ...f.request, action: 'move' as const }, plan = await f.coordinator.plan(input);
  const request = { ...input, operationId: plan.operationId, operationCreatedAt: plan.operationCreatedAt, confirmed: true };
  const remove = f.mdbx.remove.getMockImplementation()!;
  f.mdbx.remove.mockImplementationOnce(async (...args) => { if (committed) await remove(...args); throw new Error('Native reply lost'); });
  await expect(f.coordinator.execute(request)).rejects.toThrow('Native reply lost');
  expect((await f.coordinator.pending(f.account.id))[0].canKeepBoth).toBe(false);
  const before = await f.storage.read();
  await expect(f.coordinator.keepBoth(f.account.id, plan.operationId, true)).rejects.toThrow('删除已进入');
  expect(await f.storage.read()).toEqual(before);
  f.restart(); expect(await f.coordinator.execute(request)).toMatchObject({ action: 'move' });
});

it('reserves the native source queue and rejects an old-session choice after waiting', async () => {
  const { current: f, request } = await interruptedMove(true);
  let release!: () => void, entered!: () => void;
  const running = new Promise<void>(resolve => { entered = resolve; });
  const hold = f.queue.run(f.source.id, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
  await running;
  const snapshot = await f.storage.read(), read = f.vault.readState.bind(f.vault);
  let readCount = 0, waiting!: () => void;
  const queued = new Promise<void>(resolve => { waiting = resolve; });
  vi.spyOn(f.vault, 'readState').mockImplementation(async (...args) => { const state = await read(...args); if (++readCount === 2) waiting(); return state; });
  const choice = f.coordinator.keepBoth(f.account.id, request.operationId, true);
  const failure = expect(choice).rejects.toThrow();
  await queued; expect(await f.storage.read()).toEqual(snapshot);
  await f.vault.lock(); await f.vault.unlock(''); release(); await hold; await failure;
  expect(await f.storage.read()).toEqual(snapshot);
});

it('refuses a changed target binding even when current sources are deliberately kept', async () => {
  const { current: f, request } = await interruptedMove();
  await f.vault.upsertProvider({ ...f.account, config: { ...f.account.config, apiUrl: 'https://different.invalid/api' } });
  const before = await f.storage.read();
  await expect(f.coordinator.keepBoth(f.account.id, request.operationId, true)).rejects.toThrow('目标');
  expect(await f.storage.read()).toEqual(before); expect(f.raw).toHaveLength(1);
});

it('refuses a copy decision for a completed move or an original copy', async () => {
  const f = await fixture(), plan = await f.coordinator.plan(f.request);
  vi.mocked(f.remote.create).mockRejectedValueOnce(new Error('Offline'));
  await expect(f.coordinator.execute({ ...f.request, ...plan })).rejects.toThrow('Offline');
  await expect(f.coordinator.keepBoth(f.account.id, plan.operationId, true)).rejects.toThrow('不是移动');
  const { current: move, request } = await interruptedMove();
  await move.coordinator.execute(request);
  await expect(move.coordinator.keepBoth(move.account.id, request.operationId, true)).rejects.toThrow('已结束');
});

it('still requires complete untampered target readback after choosing keep-both', async () => {
  const { current: f, request } = await interruptedMove(true);
  await f.coordinator.keepBoth(f.account.id, request.operationId, true);
  const sync = f.provider.sync.getMockImplementation()!;
  f.provider.sync.mockImplementationOnce(async () => ({ ...await sync(), sourceRecords: [] }));
  await expect(f.coordinator.execute(request)).rejects.toThrow();
  expect((await f.coordinator.pending(f.account.id))[0].keptBoth).toBe(true);
  expect((await f.vault.readState()).items.find(row => row.id === f.base.id)).toEqual(f.base);
  f.restart(); expect(await f.coordinator.execute(request)).toMatchObject({ action: 'copy' });
  expect(f.mdbx.remove).not.toHaveBeenCalled();
});

it('rejects malformed, downgraded or deletion-bearing keep-both journals and direct staging', async () => {
  const { current: f, request } = await interruptedMove(true);
  await f.coordinator.keepBoth(f.account.id, request.operationId, true);
  const state = await f.vault.readState(), batch = state.bitwardenBatchTransfers![0];
  for (const change of [
    { version: 3 }, { resolution: undefined }, { resolution: { ...batch.resolution, originalVersion: 2 } },
    { resolution: { ...batch.resolution, confirmedAt: 'invalid' } },
    { mdbxMoves: batch.mdbxMoves!.map(group => ({ ...group, deletion: null })) }
  ]) expect(() => readBitwardenBatches([{ ...batch, ...change }])).toThrow();
  await expect(f.vault.stageBitwardenBatch(batch, state.bitwardenCipherCopies!)).rejects.toThrow('初始计划');
});

it('previews the complete graph, creates one folder and adopts both linked passwords atomically', async () => {
  const f = await fixture(), plan = await f.coordinator.plan(f.request);
  expect(plan.items.map(row => row.blockedReason)).toEqual([undefined, undefined]); expect(plan.transferableCount).toBe(2);
  const result = await f.coordinator.execute({ ...f.request, operationId: plan.operationId, operationCreatedAt: plan.operationCreatedAt });
  expect(result.completedCount).toBe(2); expect(f.folders).toHaveLength(1); expect(f.raw).toHaveLength(2);
  const state = await f.vault.readState(), copied = state.items.filter(row => row.providerRefs.some(ref => ref.providerId === f.account.id));
  const sso = copied.find(row => row.kind === 'login' && row.loginType === 'SSO'); expect(sso?.kind).toBe('login');
  expect(sso?.kind === 'login' && resolveSsoAccount(sso, copied)?.id).toBe(copied.find(row => row.kind === 'login' && row.loginType !== 'SSO')?.id);
  expect(state.bitwardenBatchTransfers![0].status).toBe('completed');
});

it.each(['folder', 'cipher', 'adoption'] as const)('recovers a lost %s reply after restarting without duplicate creates', async mode => {
  const f = await fixture(), plan = await f.coordinator.plan(f.request), request = { ...f.request, operationId: plan.operationId, operationCreatedAt: plan.operationCreatedAt };
  if (mode === 'folder') { const create = f.folderRemote.create.getMockImplementation()!; f.folderRemote.create.mockImplementationOnce(async name => { await create(name); throw new Error('Lost reply'); }); }
  if (mode === 'cipher') { const create = vi.mocked(f.remote.create).getMockImplementation()!; vi.mocked(f.remote.create).mockImplementationOnce(async payload => { await create(payload); throw new Error('Lost reply'); }); }
  if (mode === 'adoption') { const adopt = f.vault.applyProviderSync.bind(f.vault); vi.spyOn(f.vault, 'applyProviderSync').mockImplementationOnce(async (...args) => { await adopt(...args); throw new Error('Lost reply'); }); }
  await expect(f.coordinator.execute(request)).rejects.toThrow('Lost reply'); f.restart();
  const result = await f.coordinator.execute(request); expect(result.completedCount).toBe(2); expect(f.raw).toHaveLength(2); expect(f.folders).toHaveLength(1);
  const before = await f.storage.read(), calls = f.provider.sync.mock.calls.length;
  expect(await f.coordinator.execute(request)).toEqual(result); expect(await f.storage.read()).toEqual(before); expect(f.provider.sync.mock.calls.length).toBe(calls);
});

it('blocks an unsupported field without suppressing an independent transferable graph', async () => {
  const extra = { ...createLoginItem({ title: 'Extra' }), boundNoteEntryId: 'unresolved-note' };
  const f = await fixture([extra]), plan = await f.coordinator.plan(f.request);
  expect(plan.transferableCount).toBe(2); expect(plan.blockedCount).toBe(1); expect(plan.items.find(row => row.sourceItemId === extra.id)?.blockedReason).toBeTruthy();
  expect((await f.coordinator.execute({ ...f.request, operationId: plan.operationId, operationCreatedAt: plan.operationCreatedAt })).completedCount).toBe(2);
});

it('refuses stale preview, expired memory and lock during preparation before remote mutation', async () => {
  const f = await fixture(), plan = await f.coordinator.plan(f.request), request = { ...f.request, operationId: plan.operationId, operationCreatedAt: plan.operationCreatedAt };
  await f.vault.upsertItem({ ...f.base, password: 'Later edit' }); await expect(f.coordinator.execute(request)).rejects.toThrow('已变化');
  f.restart(); await expect(f.coordinator.execute(request)).rejects.toThrow('预览已过期');
  const resource = f.resource.getMockImplementation()!; f.resource.mockImplementationOnce(async (...args) => { const result = await resource(...args); f.coordinator.clear(); return result; });
  await expect(f.coordinator.plan(f.request)).rejects.toThrow('锁定'); expect(f.remote.create).not.toHaveBeenCalled(); expect(f.folderRemote.create).not.toHaveBeenCalled();
});

it('rejects loss of protected/custom field semantics instead of comparing only names and values', async () => {
  const source = { ...createLoginItem({ title: 'Field preservation' }), customFields: [{ name: 'Secret', value: 'synthetic', protected: true }] };
  await expect(assertBitwardenPortableProjection(source, { ...source, customFields: [{ ...source.customFields[0], protected: false }] })).rejects.toThrow('customFields');
  const boolean = { ...source, customFields: [{ ...source.customFields[0], fieldType: 'BOOLEAN' as const }] };
  await expect(assertBitwardenPortableProjection(boolean, source)).rejects.toThrow('customFields');
});

it('expands incoming SSO dependents for a move and requires confirmation before any writes', async () => {
  const f = await fixture(), input = { ...f.request, itemIds: [f.base.id], action: 'move' as const };
  const plan = await f.coordinator.plan(input);
  expect(plan.transferableCount).toBe(2); expect(plan.requiresMoveConfirmation).toBe(true);
  const request = { ...input, operationId: plan.operationId, operationCreatedAt: plan.operationCreatedAt };
  await expect(f.coordinator.execute(request)).rejects.toThrow('先确认'); expect(f.remote.create).not.toHaveBeenCalled(); expect(f.folderRemote.create).not.toHaveBeenCalled();
  const result = await f.coordinator.execute({ ...request, confirmed: true });
  expect(result).toMatchObject({ action: 'move', completedCount: 2 });
  expect((await f.vault.readState()).items.map(item => item.id)).not.toContain(f.base.id);
  expect((await f.vault.readState()).items.map(item => item.id)).not.toContain(f.sso.id);
});

it('resumes an already confirmed local move after a lost Cipher reply', async () => {
  const f = await fixture(), input = { ...f.request, action: 'move' as const }, plan = await f.coordinator.plan(input);
  const request = { ...input, operationId: plan.operationId, operationCreatedAt: plan.operationCreatedAt };
  const create = vi.mocked(f.remote.create).getMockImplementation()!;
  vi.mocked(f.remote.create).mockImplementationOnce(async payload => { await create(payload); throw new Error('Lost reply'); });
  await expect(f.coordinator.execute({ ...request, confirmed: true })).rejects.toThrow('Lost reply');
  expect((await f.vault.readState()).items.map(item => item.id)).toContain(f.base.id);
  f.restart(); expect(await f.coordinator.execute(request)).toMatchObject({ completedCount: 2, action: 'move' });
  expect(f.raw).toHaveLength(2); expect((await f.vault.readState()).items).toHaveLength(2);
});

it.each(['[{"credentialId":"dXNlcg"}]', '[{}]', '{broken'])('preserves Passkeys with matching or ambiguous local bindings: %s', raw => {
  const state = createEmptyVaultState(), item = { id: 'key', kind: 'passkey', credentialId: 'dXNlcg', providerRefs: [] } as unknown as PasskeyItem;
  state.items = [item, { ...createLoginItem({ title: 'Owner' }), passkeyBindings: raw }];
  expect(() => assertBitwardenLocalMoveSource(state, item)).toThrow('关联');
});

it('does not treat remote bindings as local-only records and accepts unrelated valid local metadata', () => {
  const state = createEmptyVaultState(), item = { id: 'key', kind: 'passkey', credentialId: 'dXNlcg', providerRefs: [] } as unknown as PasskeyItem;
  state.items = [item, { ...createLoginItem({ title: 'Unrelated' }), passkeyBindings: '[{"credentialId":"b3RoZXI"}]' }];
  expect(() => assertBitwardenLocalMoveSource(state, item)).not.toThrow();
  item.providerRefs = [{ providerId: 'remote' }];
  expect(() => assertBitwardenLocalMoveSource(state, item)).toThrow('跨库移动');
});

it('keeps old copy receipt versions distinct from newly authorized moves', async () => {
  const f = await fixture(), input = { ...f.request, action: 'move' as const }, plan = await f.coordinator.plan(input);
  await f.coordinator.execute({ ...input, operationId: plan.operationId, operationCreatedAt: plan.operationCreatedAt, confirmed: true });
  const batch = (await f.vault.readState()).bitwardenBatchTransfers![0];
  expect(() => readBitwardenBatches([{ ...batch, version: 1 }])).toThrow();
  const changed = structuredClone(batch); changed.plan.requiresMoveConfirmation = false;
  expect(() => readBitwardenBatches([changed])).toThrow();
  const mismatched = structuredClone(batch); mismatched.result!.items[0].effectiveAction = 'copy';
  expect(() => readBitwardenBatches([mismatched])).toThrow();
});

it.each(['reply','receipt-save','adoption','lock'] as const)('recovers a native move after %s failure without rereading deleted sources', async mode => {
  const f = await fixture([], true), input = { ...f.request, action: 'move' as const }, plan = await f.coordinator.plan(input);
  expect(plan.transferableCount).toBe(2); expect(plan.blockedCount).toBe(0);
  const request = { ...input, operationId: plan.operationId, operationCreatedAt: plan.operationCreatedAt, confirmed: true };
  if (mode === 'reply' || mode === 'receipt-save' || mode === 'lock') {
    const remove = f.mdbx.remove.getMockImplementation()!;
    f.mdbx.remove.mockImplementationOnce(async (...args) => {
      const result = await remove(...args);
      if (mode === 'reply') throw new Error('Lost native reply');
      if (mode === 'receipt-save') vi.spyOn(f.storage, 'write').mockRejectedValueOnce(new Error('Receipt save failed'));
      if (mode === 'lock') await f.sessions.clear();
      return result;
    });
  } else vi.spyOn(f.vault, 'applyProviderSync').mockRejectedValueOnce(new Error('Adoption failed'));
  await expect(f.coordinator.execute(request)).rejects.toThrow();
  if (mode === 'lock') await f.vault.unlock('');
  const pending = (await f.vault.readState()).bitwardenBatchTransfers![0];
  expect(pending.status).toBe('writing'); expect(pending.mdbxMoves![0].deletion?.version).toBe(1);
  expect((await f.vault.readState()).items.map(row => row.id)).toContain(f.base.id);
  const reads = f.resource.mock.calls.length, preparations = f.mdbx.prepare.mock.calls.length;
  await f.vault.upsertProvider({ ...f.source, name: 'Reopened source', isDefaultSaveTarget: true,
    lastError: undefined, config: { ...f.source.config, hostVerifiedAt: new Date().toISOString(), schemaVersion: 2 } });
  f.restart();
  expect(await f.coordinator.execute(request)).toMatchObject({ action: 'move', completedCount: 2 });
  expect(f.resource).toHaveBeenCalledTimes(reads); expect(f.mdbx.prepare).toHaveBeenCalledTimes(preparations);
  expect(f.receipts.size).toBe(1); expect(f.raw).toHaveLength(2);
  const state = await f.vault.readState();
  expect(state.items).toHaveLength(2); expect(state.items.every(row => row.providerRefs[0].providerId === f.account.id)).toBe(true);
  expect(state.bitwardenBatchTransfers![0]).toMatchObject({ version: 3, status: 'completed' });
});

it('pins sources, incoming dependencies and connections from saved deletion until adoption', async () => {
  const f = await fixture([], true), input = { ...f.request, action: 'move' as const }, plan = await f.coordinator.plan(input);
  f.mdbx.remove.mockRejectedValueOnce(new Error('Native temporarily unavailable'));
  await expect(f.coordinator.execute({ ...input, operationId: plan.operationId, operationCreatedAt: plan.operationCreatedAt, confirmed: true })).rejects.toThrow('temporarily');
  const before = await f.storage.read();
  await expect(f.vault.upsertItem({ ...f.base, password: 'edited' })).rejects.toThrow('来源已变化');
  await expect(f.vault.importItems([{ ...f.sso, id: crypto.randomUUID(), title: 'new dependent' }])).rejects.toThrow();
  for (const provider of [f.source, f.account]) {
    await expect(f.vault.removeProvider(provider.id)).rejects.toThrow('连接');
    await expect(f.vault.upsertProvider({ ...provider, enabled: false })).rejects.toThrow('连接');
  }
  await expect(f.vault.assertNoBitwardenMdbxMove(f.source.id)).rejects.toThrow('待恢复');
  await expect(f.vault.applyProviderSync(f.source.id, [])).rejects.toThrow('恢复快照');
  await expect(f.coordinator.cancel(f.account.id, plan.operationId)).rejects.toThrow('已尝试写入');
  expect(await f.storage.read()).toEqual(before);
});

it('stops before deletion when target readback or native source verification changes', async () => {
  const f = await fixture([], true), input = { ...f.request, action: 'move' as const }, plan = await f.coordinator.plan(input);
  const sync = f.provider.sync.getMockImplementation()!;
  f.provider.sync.mockImplementationOnce(async () => { const result = await sync(); return { ...result, sourceRecords: [] }; });
  await expect(f.coordinator.execute({ ...input, operationId: plan.operationId, operationCreatedAt: plan.operationCreatedAt, confirmed: true })).rejects.toThrow();
  expect(f.mdbx.remove).not.toHaveBeenCalled();
  expect((await f.vault.readState()).bitwardenBatchTransfers![0].mdbxMoves![0].deletion).toBeUndefined();
  expect(f.raw).toHaveLength(2);
});

it('rejects a changed source lock set after waiting for the target queue', async () => {
  const f = await fixture([], true), input = { ...f.request, action: 'move' as const };
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = f.queue.run(f.account.id, () => gate);
  let queued!: () => void; const enqueued = new Promise<void>(resolve => { queued = resolve; });
  const runMany = f.queue.runMany.bind(f.queue);
  vi.spyOn(f.queue, 'runMany').mockImplementation((ids, work) => { queued(); return runMany(ids, work); });
  const planning = f.coordinator.plan(input);
  await enqueued;
  await f.vault.upsertProvider({ ...f.source, id: 'another-source' });
  await f.vault.upsertItem({ ...f.sso, providerRefs: [{ ...f.sso.providerRefs[0], providerId: 'another-source' }] });
  release(); await waiting;
  await expect(planning).rejects.toThrow('等待传输期间来源已变化');
});

it('packs complete independent groups and recovers only the unfinished native transaction', async () => {
  const extra = Array.from({ length: 49 }, (_, i) => createLoginItem({ title: `Independent ${i}`, password: 'Synthetic' }));
  const f = await fixture(extra, true), input = { ...f.request, action: 'move' as const }, plan = await f.coordinator.plan(input);
  expect(plan.transferableCount).toBe(51);
  const request = { ...input, operationId: plan.operationId, operationCreatedAt: plan.operationCreatedAt, confirmed: true };
  const remove = f.mdbx.remove.getMockImplementation()!;
  f.mdbx.remove.mockImplementationOnce(remove).mockImplementationOnce(async (...args) => { await remove(...args); throw new Error('Second commit reply lost'); });
  await expect(f.coordinator.execute(request)).rejects.toThrow('Second commit');
  const groups = (await f.vault.readState()).bitwardenBatchTransfers![0].mdbxMoves!;
  expect(groups.map(group => group.sources.length)).toEqual([50,1]); expect(groups.map(group => !!group.receipt)).toEqual([true,false]);
  f.restart(); expect(await f.coordinator.execute(request)).toMatchObject({ completedCount: 51 });
  expect(f.receipts.size).toBe(2); expect(f.mdbx.remove).toHaveBeenCalledTimes(3); expect(f.raw).toHaveLength(51);
}, 60_000); // 51 real encrypted journals/readbacks also run under full-suite CPU contention.

it('blocks an oversized relationship component without splitting or blocking an independent component', async () => {
  const extra = Array.from({ length: 51 }, (_, i) => ({ ...createLoginItem({ title: `Related ${i}` }), passwordGroupId: 'oversized' }));
  const f = await fixture(extra, true), plan = await f.coordinator.plan({ ...f.request, action: 'move' });
  expect(plan).toMatchObject({ transferableCount: 2, blockedCount: 51 });
  expect(plan.items.filter(row => row.blockedReason).every(row => row.blockedReason!.includes('50'))).toBe(true);
  expect(f.remote.create).not.toHaveBeenCalled(); expect(f.mdbx.remove).not.toHaveBeenCalled();
});
