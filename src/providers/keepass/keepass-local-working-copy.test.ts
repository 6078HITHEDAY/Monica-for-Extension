import { expect, it, vi } from 'vitest';
import type { LoginItem, ProviderAccount } from '../../core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../../core/project-credentials';
import { buildKeePassFixture, type KeePassFixtureOptions } from './keepass-fixture';
import { createLoginItem } from '../../core/model';
import { KeePassDurableSyncCoordinator } from './keepass-durable-sync';
import { KeePassProjectRemovalWorkflow } from '../../background/keepass-project-removal';
import { ProviderOperationQueue } from '../../background/provider-operation-queue';
import { SecureVaultService } from '../../security/secure-vault-service';
import { MemoryVaultStorage } from '../../security/vault-storage';
import { MemoryVaultSessionStore } from '../../security/vault-session';
import { KeePassProvider } from './keepass-provider';
import { KeePassLocalWorkingCopyService, KEEPASS_LOCAL_SOURCE_HASH } from './keepass-local-working-copy';
import { MemoryKeePassWorkingCopyStorage } from './keepass-working-copy-store';
import { createKeePassCacheEncryptionKey, KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG } from './keepass-receipt-crypto';
import { openKeePassVault } from './keepass-vault';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))]
  .map(value => value.toString(16).padStart(2, '0')).join('');
const credential = { password: 'fixture master password', sourceMode: 'local-file' as const };

async function fixture(options: Omit<KeePassFixtureOptions, 'entries'> = {}) {
  const bytes = await buildKeePassFixture({ ...options, entries: [0, 1].map(n => ({ title: 'Local project', fields: {
    URL: 'https://example.invalid/', Notes: '  shared\r\n中文\t  ' }, protectedFields: {
    Password: `local-synthetic-secret-${n}`, [PROJECT_CREDENTIAL_FIELD]: JSON.stringify({ version: 1,
      projectId: uuid(1), groupId: uuid(2), passwordId: uuid(n + 10), label: 'Main', primary: true,
      groupOrder: 0, passwordOrder: n }).replace(/}$/, ',"future":9007199254740993}') },
    binaries: n === 0 ? { 'project.bin': Uint8Array.of(1, 3, 5) } : undefined })) });
  const sha = await digest(bytes);
  const account: ProviderAccount = { id: 'kp-local', kind: 'keepass', name: 'Local synthetic', enabled: true,
    isDefaultSaveTarget: false, config: { sourceMode: 'local-file', databaseId: 7, [KEEPASS_LOCAL_SOURCE_HASH]: sha,
      [KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG]: createKeePassCacheEncryptionKey() } };
  const suppliedCredential = { ...credential, password: options.password === undefined ? credential.password : options.password || '', keyFile: options.keyFile };
  const provider = new KeePassProvider(); await provider.unlock(account, bytes, suppliedCredential);
  const originals = (await provider.sync(account, { now: '2026-10-09T00:00:00Z', localItems: [] })).items as LoginItem[];
  const storage = new MemoryKeePassWorkingCopyStorage(), service = new KeePassLocalWorkingCopyService(provider, storage);
  await service.initialize(account, bytes);
  const request = { operationId: uuid(90), expectedWorkingSha256: sha, draft: { providerId: account.id,
    anchorItemId: originals[0].id, originals, items: structuredClone(originals), removedItemIds: [originals[0].id] } };
  return { account, storage, provider, service, bytes, request, suppliedCredential };
}

it('commits local owner removal and attachment handoff without storing database credentials or changing the live file', async () => {
  const f = await fixture(), receipt = await f.service.persistProjectRemoval(f.account, f.request);
  expect(receipt.result.type).toBe('project-remove');
  expect(f.account.config).not.toHaveProperty('databasePassword'); expect(f.account.config).not.toHaveProperty('keyFile');
  expect(f.provider.summarize(f.account.id).itemCount).toBe(2);
  const stored = (await f.storage.read(f.account.id))!;
  expect(stored.baseBytes).toEqual(f.bytes); expect(stored.revision).toBe(2);
  expect(JSON.stringify(await f.storage.readReceipt(f.account.id, f.request.operationId))).not.toContain('synthetic-secret');
  const reopened = await openKeePassVault(stored.workingBytes, { password: credential.password, providerId: f.account.id, databaseId: 7 });
  const retained = reopened.items.filter(row => !row.deletedAt);
  expect(retained).toHaveLength(1);
  expect(reopened.items.filter(row => row.deletedAt)).toHaveLength(1);
  expect(retained[0].keepassEntryUuid).toBe(f.request.draft.originals[1].keepassEntryUuid);
  for (const row of reopened.items) expect(reopened.entriesByUuid.get(row.keepassEntryUuid!)!.binaries.has('project.bin')).toBe(true);
  expect((retained[0] as LoginItem).customFields.find(field => field.name === PROJECT_CREDENTIAL_FIELD)?.value).toContain('9007199254740993');
  const nextProvider = new KeePassProvider(), next = new KeePassLocalWorkingCopyService(nextProvider, f.storage);
  expect(await next.persistProjectRemoval(f.account, f.request)).toEqual(receipt);
  await expect(next.restore(f.account, { password: 'wrong' })).rejects.toThrow();
  expect(nextProvider.isUnlocked(f.account.id)).toBe(false);
  const summary = await next.restore(f.account, credential);
  expect(summary.itemCount).toBe(1); expect(summary.dirty).toBe(true);
  expect((await f.storage.read(f.account.id))!.revision).toBe(2);
});

it.each(['before-commit', 'lost-response', 'revision-race'] as const)('recovers local %s without a partial file or repeated deletion', async mode => {
  const f = await fixture(), save = f.storage.save.bind(f.storage);
  vi.spyOn(f.storage, 'save').mockImplementationOnce(async (input, revision, receipt) => {
    if (mode === 'before-commit') throw new Error('Synthetic disk failure');
    if (mode === 'revision-race') {
      const current = (await f.storage.read(f.account.id))!; await save(current, current.revision);
      return save(input, revision, receipt);
    }
    await save(input, revision, receipt); throw new Error('Synthetic response loss');
  });
  await expect(f.service.persistProjectRemoval(f.account, f.request)).rejects.toThrow();
  if (mode !== 'lost-response') {
    expect((await f.storage.read(f.account.id))!.workingBytes).toEqual(f.bytes);
    expect(await f.storage.readReceipt(f.account.id, f.request.operationId)).toBeUndefined();
  }
  const nextProvider = new KeePassProvider(), next = new KeePassLocalWorkingCopyService(nextProvider, f.storage);
  if (mode !== 'lost-response') await next.restore(f.account, credential);
  expect((await next.persistProjectRemoval(f.account, f.request)).result.type).toBe('project-remove');
  expect((await f.storage.read(f.account.id))!.revision).toBe(mode === 'revision-race' ? 3 : 2);
});

it('refuses a changed file, source, request and corrupted stored bytes while preserving the recoverable result', async () => {
  const f = await fixture();
  await f.service.persistProjectRemoval(f.account, f.request);
  const before = (await f.storage.read(f.account.id))!;
  const other = { ...f.account, config: { ...f.account.config, [KEEPASS_LOCAL_SOURCE_HASH]: '0'.repeat(64) } };
  await expect(f.service.initialize(other, f.bytes)).rejects.toThrow();
  await expect(f.service.persistProjectRemoval(other, f.request)).rejects.toThrow();
  await expect(f.service.restore(other, credential)).rejects.toThrow();
  const changed = structuredClone(f.request); changed.draft.items[1].notes = 'changed request';
  await expect(f.service.persistProjectRemoval(f.account, changed)).rejects.toThrow();
  await f.service.initialize(f.account, f.bytes);
  expect(await f.storage.read(f.account.id)).toEqual(before);
  const corrupt = structuredClone(before); corrupt.workingBytes[60] ^= 1;
  vi.spyOn(f.storage, 'read').mockResolvedValueOnce(corrupt);
  await expect(f.service.restore(f.account, credential)).rejects.toThrow();
  expect(await f.storage.read(f.account.id)).toEqual(before);
});

it.each(['lock', 'replace'] as const)('rejects a %s during local file preparation, without a durable write', async mode => {
  const f = await fixture(), prepare = f.provider.prepareLocalProjectRemovalFile.bind(f.provider);
  vi.spyOn(f.provider, 'prepareLocalProjectRemovalFile').mockImplementationOnce(async (...args) => {
    const result = await prepare(...args);
    if (mode === 'lock') f.provider.lock(); else await f.provider.unlock(f.account, f.bytes, credential);
    return result;
  });
  await expect(f.service.persistProjectRemoval(f.account, f.request)).rejects.toThrow(/锁定或替换/);
  expect((await f.storage.read(f.account.id))!.workingBytes).toEqual(f.bytes);
  expect(await f.storage.readReceipt(f.account.id, f.request.operationId)).toBeUndefined();
});

it('captures later live content before removal and preserves it through encrypted restart', async () => {
  const f = await fixture(), edited = { ...f.request.draft.originals[1], title: 'Later local title' };
  await f.provider.update(f.account, edited);
  const snapshot = await f.service.persistWorkingCopy(f.account);
  expect(snapshot.workingSha256).not.toBe(f.request.expectedWorkingSha256);
  await expect(f.service.persistProjectRemoval(f.account, f.request)).rejects.toThrow(/文件版本/);
  const nextProvider = new KeePassProvider(), next = new KeePassLocalWorkingCopyService(nextProvider, f.storage);
  await next.restore(f.account, credential);
  const rows = (await nextProvider.sync(f.account, { now: '2026-10-09T00:00:01Z', localItems: [] })).items;
  expect(rows.find(row => row.id === edited.id)?.title).toBe('Later local title');
});

it.each([3, 4] as const)('retains KDBX %s key-file-only protection across removal and recovery', async version => {
  const keyFile = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const f = await fixture({ version, password: null, keyFile });
  await f.service.persistProjectRemoval(f.account, f.request);
  const provider = new KeePassProvider(), next = new KeePassLocalWorkingCopyService(provider, f.storage);
  await expect(next.restore(f.account, { password: '' })).rejects.toThrow();
  expect(provider.isUnlocked(f.account.id)).toBe(false);
  const summary = await next.restore(f.account, f.suppliedCredential);
  expect(summary.itemCount).toBe(1); expect(summary.versionMajor).toBe(version);
  expect(keyFile).toEqual(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
  expect(f.account.config).not.toHaveProperty('keyFile');
});

it('coordinates local owner removal, secure-vault adoption, session reload and export with the original source recoverable', async () => {
  const f = await fixture(), vault = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
  await vault.setup('Synthetic manager password', f.request.draft.originals); await vault.upsertProvider(f.account);
  const flow = new KeePassProjectRemovalWorkflow(vault, f.service, new ProviderOperationQueue(), undefined, {
    runMutationExclusive: async (_id, task) => task(),
    beforeCapture: async account => { await f.service.persistWorkingCopy(account); },
    invalidateSession: async () => { await f.service.reload(f.account); }
  });
  const token = await flow.sourceToken(f.account.id);
  const completed = await flow.stageFromManager({ operationId: f.request.operationId, sourceToken: token, draft: f.request.draft });
  expect(completed.localAdoptionCompleted).toBe(true);
  expect((await vault.readState()).items.filter(row => !row.deletedAt)).toHaveLength(1);
  expect(f.provider.summarize(f.account.id).itemCount).toBe(1);
  const exported = await f.service.exportFile(f.account);
  expect(f.provider.summarize(f.account.id).dirty).toBe(true);
  f.provider.markLocalFileExported(f.account);
  expect(f.provider.summarize(f.account.id).dirty).toBe(false);
  const reopenedAccount = { ...f.account, config: exported.accountConfig };
  await f.service.assertPickedFile(reopenedAccount, f.bytes);
  await f.service.assertPickedFile(reopenedAccount, exported.bytes);
  await expect(f.service.assertPickedFile(reopenedAccount, await buildKeePassFixture())).rejects.toThrow(/外部修改/);
  f.provider.lock(); await f.service.restore(reopenedAccount, credential);
  expect(f.provider.summarize(f.account.id).itemCount).toBe(1);
  expect(f.provider.summarize(f.account.id).dirty).toBe(false);
  await flow.resume(f.request.operationId);
  expect((await vault.readState()).items.filter(row => !row.deletedAt)).toHaveLength(1);
});

it('does not recreate a missing edited checkpoint from an older original file', async () => {
  const f = await fixture();
  await f.provider.update(f.account, { ...f.request.draft.originals[1], notes: 'A newer saved edit' });
  const saved = await f.service.persistWorkingCopy(f.account);
  const updated = { ...f.account, config: saved.accountConfig };
  const emptyStorage = new MemoryKeePassWorkingCopyStorage(), provider = new KeePassProvider();
  await expect(new KeePassLocalWorkingCopyService(provider, emptyStorage).openPickedFile(updated, f.bytes, credential)).rejects.toThrow(/来源/);
  expect(provider.isUnlocked(updated.id)).toBe(false);
  expect(await emptyStorage.read(updated.id)).toBeUndefined();
});

it('recovers an ordinary local create after encrypted adoption fails, without duplicating the native entry', async () => {
  const f = await fixture(), vaultStore = new MemoryVaultStorage();
  let vault = new SecureVaultService(vaultStore, new MemoryVaultSessionStore());
  await vault.setup('Synthetic manager password', f.request.draft.originals); await vault.upsertProvider(f.account);
  const added = createLoginItem({ title: 'New local entry', username: 'unique', password: 'new synthetic value', providerRefs: [{ providerId: f.account.id }] });
  await vault.upsertItem(added);
  const writer = async (account: ProviderAccount, config: Record<string, unknown>) => ({ ...account, config });
  const sync = new KeePassDurableSyncCoordinator(f.provider, f.service, vault, writer);
  vi.spyOn(vault, 'applyProviderSync').mockRejectedValueOnce(new Error('Synthetic adoption lost'));
  await expect(sync.synchronize(f.account)).rejects.toThrow('adoption lost');
  f.provider.lock();
  vault = new SecureVaultService(vaultStore, new MemoryVaultSessionStore()); await vault.unlock('Synthetic manager password');
  const provider = new KeePassProvider(), copies = new KeePassLocalWorkingCopyService(provider, f.storage);
  await copies.restore(f.account, credential);
  await new KeePassDurableSyncCoordinator(provider, copies, vault, writer).synchronize(f.account);
  const state = await vault.readState();
  expect(state.mutationQueue).toHaveLength(0);
  expect(state.items.filter(row => row.title === 'New local entry')).toHaveLength(1);
  expect(state.items.find(row => row.title === 'New local entry')?.id).toBe(added.id);
  expect(provider.summarize(f.account.id).itemCount).toBe(3);
});
