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

async function fixture(extra: VaultItem[] = []) {
  const base = createLoginItem({ title: 'Same name', password: 'Synthetic secret' }); base.categoryName = 'Accounts';
  const sso = { ...createLoginItem({ title: 'Same name' }), loginType: 'SSO' as const, ssoRefLogicalId: ssoLogicalId(base), categoryName: 'Accounts' };
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore(), device = new MemoryVaultDeviceKeyStore();
  let vault = new SecureVaultService(storage, sessions, Date.now, device);
  await vault.setup('', [base, sso, ...extra]);
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
    context: async () => { throw new Error('Unexpected source read'); }, files: async () => []
  }));
  const make = () => new BitwardenBatchTransferCoordinator(vault, provider, { resource, folders: async () => structuredClone(folders),
    folderRemote: () => folderRemote, remote: () => remote, exclusive: async (_id, work) => work() });
  let coordinator = make();
  return { base, sso, storage, sessions, account, raw, folders, remote, folderRemote, provider, resource,
    get vault() { return vault; }, get coordinator() { return coordinator; },
    restart() { coordinator.clear(); vault = new SecureVaultService(storage, sessions, Date.now, device); coordinator = make(); },
    request: { itemIds: [sso.id, ...extra.map(row => row.id)], targetProviderId: account.id, action: 'copy' as const, preserveCategories: true } };
}

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
