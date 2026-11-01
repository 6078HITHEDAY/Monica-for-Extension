import { ProviderSyncActivity } from './provider-sync-activity';
import { expect, it, vi } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderKind } from '../core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../core/project-credentials';
import { SecureVaultService } from '../security/secure-vault-service';
import { MemoryVaultSessionStore } from '../security/vault-session';
import { MemoryVaultStorage } from '../security/vault-storage';
import { PasswordProjectRemovalWorkflow, PasswordProjectRemovalNotStagedError } from './password-project-removal';
import { ProviderOperationQueue } from './provider-operation-queue';
import { BitwardenProjectRemovalRuntime } from './bitwarden-project-removal-runtime';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(kind: ProviderKind = 'mdbx2', bitwardenEnabled = false) {
  const vault = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
  const group = crypto.randomUUID(), credential = crypto.randomUUID();
  const rows: LoginItem[] = [0, 1, 2].map(index => ({ ...createLoginItem({ title: 'Project', username: 'private-account', password: `private-password-${index}` }),
    passwordGroupId: group, providerRefs: [{ providerId: kind, remoteId: `remote-${index}`, remoteFolderId: 'folder', revision: 'commit' }],
    customFields: [{ name: PROJECT_CREDENTIAL_FIELD, value: JSON.stringify({ version: 1, projectId: group, groupId: credential,
      passwordId: crypto.randomUUID(), label: 'Group', primary: true, groupOrder: 0, passwordOrder: index }), protected: true }] }));
  await vault.setup('Synthetic workflow master password', rows);
  await vault.upsertProvider({ id: kind, kind, name: 'Synthetic', enabled: true, isDefaultSaveTarget: false,
    config: { vaultHandle: 'handle', nativeVaultId: 'vault', password: 'private-provider-secret' } });
  const items = await vault.listItems() as LoginItem[];
  const input = { operationId: crypto.randomUUID(), items, expected: Object.fromEntries(items.map(row => [row.id, row.updatedAt])), removedItemIds: [items[0].id] };
  const queue = new ProviderOperationQueue(), changed = vi.fn();
  const removal = { resume: vi.fn(async () => (await vault.readPasswordProjectRemovals())[0]) };
  const restore = { restore: vi.fn() };
  const bitwarden = { resume: vi.fn(async (_id: string, _signal?: AbortSignal) => (await vault.readPasswordProjectRemovals())[0]) };
  const active = new ProviderSyncActivity(), invalidate = vi.fn();
  const runtime = new BitwardenProjectRemovalRuntime(vault, bitwarden, active, invalidate);
  const workflow = new PasswordProjectRemovalWorkflow(vault, removal, restore, queue, changed, bitwardenEnabled ? runtime : undefined);
  return { vault, input, queue, removal, restore, workflow, changed, bitwarden, active, invalidate, runtime };
}

it.each(['keepass', 'monica-webdav', 'bitwarden'] as const)('rejects unsupported %s before any draft/journal write even with incoming references omitted', async kind => {
  const f = await fixture(kind), before = await f.vault.readState();
  await expect(f.workflow.stage({ ...f.input, items: f.input.items.map(row => ({ ...row, providerRefs: [] })) })).rejects.toThrow('目前支持');
  expect(await f.vault.readState()).toEqual(before); expect(f.removal.resume).not.toHaveBeenCalled();
});

it('lists recoverable operations without disclosing passwords or saved provider secrets, then cancels', async () => {
  const f = await fixture();
  f.removal.resume.mockRejectedValue(new Error('Synthetic remote interruption'));
  await expect(f.workflow.stage(f.input)).rejects.toThrow('remote interruption');
  const pending = await f.workflow.pending();
  expect(pending).toEqual([expect.objectContaining({ operationId: f.input.operationId, status: 'preparing', canCancel: true, supported: true,
    removedItemIds: f.input.removedItemIds, providerId: 'mdbx2' })]);
  expect(JSON.stringify(pending)).not.toContain('private-');
  expect(f.changed).toHaveBeenCalled();
  expect((await f.workflow.cancel(f.input.operationId)).status).toBe('cancelled');
  expect(await f.workflow.pending()).toEqual([]);
  expect(await f.workflow.pending(f.input.operationId)).toEqual([expect.objectContaining({status:'cancelled'})]);
  expect(await f.workflow.pending(crypto.randomUUID())).toEqual([]);
  await expect(f.workflow.pending('')).rejects.toThrow('标识无效');
  expect(await f.vault.listDeletedItems()).toEqual([]);
});

it('allows draft editing only after a rejected stage has no durable receipt', async () => {
  const f = await fixture();
  const stale = { ...f.input, expected: { ...f.input.expected, [f.input.items[0].id]: 'stale' } };
  await expect(f.workflow.stage(stale)).rejects.toBeInstanceOf(PasswordProjectRemovalNotStagedError);
  expect(await f.workflow.pending()).toEqual([]);
  const pendingError = new Error('Native preparation failed');
  f.removal.resume.mockRejectedValue(pendingError);
  await expect(f.workflow.stage(f.input)).rejects.toBe(pendingError);
  expect(await f.workflow.pending(f.input.operationId)).toHaveLength(1);
  await expect(f.workflow.stage({...f.input, removedItemIds:[f.input.items[1].id]})).rejects.not.toBeInstanceOf(PasswordProjectRemovalNotStagedError);
});

it('keeps stage outcome unknown when journal readback fails', async () => {
  const f = await fixture();
  const writeError = new Error('Storage result unknown');
  vi.spyOn(f.vault, 'stagePasswordProjectRemoval').mockRejectedValue(writeError);
  vi.spyOn(f.vault, 'readPasswordProjectRemovals').mockRejectedValue(new Error('Read failed'));
  await expect(f.workflow.stage(f.input)).rejects.toBe(writeError);
});

it('queues a new removal after failed sync without blocking another source', async () => {
  const f = await fixture(), started = deferred(), release = deferred();
  const sync = f.queue.run('mdbx2', async () => { started.resolve(); await release.promise; throw new Error('Synthetic sync failure'); });
  const expectedFailure = expect(sync).rejects.toThrow('sync failure');
  await started.promise;
  const stage = f.workflow.stage(f.input);
  await f.queue.run('independent', async () => undefined);
  expect(await f.vault.readPasswordProjectRemovals()).toEqual([]);
  release.resolve(); await expectedFailure;
  expect((await stage).status).toBe('preparing'); expect(f.removal.resume).toHaveBeenCalledOnce();
});

it('rechecks source replacement before a queued draft can be saved', async () => {
  const f = await fixture(), started = deferred(), release = deferred();
  const sync = f.queue.run('mdbx2', async () => { started.resolve(); await release.promise; });
  await started.promise;
  const stage = f.workflow.stage(f.input), failed = expect(stage).rejects.toThrow('密码源已变化');
  // Allow the request to capture its original source while the write queue remains held.
  await f.queue.run('independent', async () => undefined);
  const account = (await f.vault.getProvider('mdbx2'))!;
  await f.vault.upsertProvider({ ...account, config: { ...account.config, vaultHandle: 'replacement' } });
  release.resolve(); await sync; await failed;
  expect(await f.vault.readPasswordProjectRemovals()).toEqual([]);
});

it('allows cancellation while the source queue is held by preparation', async () => {
  const f = await fixture(), started = deferred(), release = deferred();
  f.removal.resume.mockImplementation(async () => { started.resolve(); await release.promise; return (await f.vault.readPasswordProjectRemovals())[0]; });
  const stage = f.workflow.stage(f.input); await started.promise;
  expect((await f.workflow.cancel(f.input.operationId)).status).toBe('cancelled');
  release.resolve(); expect((await stage).status).toBe('cancelled');
  expect(await f.workflow.pending()).toEqual([]);
});

it('runs local removal without any native coordinator call', async () => {
  const f = await fixture('local');
  expect((await f.workflow.stage(f.input)).status).toBe('completed');
  expect(await f.vault.listDeletedItems()).toHaveLength(1);
  expect(f.removal.resume).not.toHaveBeenCalled();
  expect(await f.workflow.pending()).toEqual([]);
});

it('routes Bitwarden to its own abortable coordinator and invalidates only that source', async () => {
  const f = await fixture('bitwarden', true);
  expect((await f.workflow.stage(f.input)).supported).toBe(true);
  expect(f.removal.resume).not.toHaveBeenCalled();
  expect(f.bitwarden.resume).toHaveBeenCalledWith(f.input.operationId, expect.any(AbortSignal));
  expect(f.invalidate.mock.calls).toEqual([['bitwarden'], ['bitwarden']]);
  expect(f.active.isBusy('bitwarden')).toBe(false);
  expect(JSON.stringify(await f.workflow.pending())).not.toContain('private-');
});

it('serializes Bitwarden removals behind ordinary sync without blocking other providers', async () => {
  const f = await fixture('bitwarden', true), started = deferred(), release = deferred();
  const sync = f.queue.run('bitwarden', async () => { started.resolve(); await release.promise; });
  await started.promise;
  const stage = f.workflow.stage(f.input);
  await f.queue.run('independent', async () => undefined);
  expect(f.bitwarden.resume).not.toHaveBeenCalled();
  release.resolve(); await sync; await stage;
  expect(f.bitwarden.resume).toHaveBeenCalledOnce();
});

it('aborts the same in-flight request on source lock while keeping the encrypted intent retryable', async () => {
  const f = await fixture('bitwarden', true), started = deferred();
  f.bitwarden.resume.mockImplementation(async (_id, signal) => {
    started.resolve();
    await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), {once: true}));
    throw new Error('Unreachable');
  });
  const stage = f.workflow.stage(f.input), rejected = expect(stage).rejects.toThrow('Synthetic lock');
  await started.promise;
  f.active.abort('bitwarden', new DOMException('Synthetic lock', 'AbortError'));
  await rejected;
  expect(f.active.isBusy('bitwarden')).toBe(false);
  expect(f.invalidate).toHaveBeenCalledTimes(2);
  expect(await f.workflow.pending()).toEqual([expect.objectContaining({ status: 'preparing', canCancel: true })]);
});

it('does not overlap an active Passkey assertion and leaves a staged request recoverable', async () => {
  const f = await fixture('bitwarden', true), assertion = new AbortController();
  f.active.reserve('bitwarden', assertion);
  await expect(f.workflow.stage(f.input)).rejects.toThrow('其他操作');
  expect(f.bitwarden.resume).not.toHaveBeenCalled();
  expect(f.active.owns('bitwarden', assertion.signal)).toBe(true);
  expect(await f.workflow.pending()).toHaveLength(1);
});

it('allows Bitwarden preparation cancellation while holding the provider queue', async () => {
  const f = await fixture('bitwarden', true), started = deferred(), release = deferred();
  f.bitwarden.resume.mockImplementation(async () => { started.resolve(); await release.promise; return (await f.vault.readPasswordProjectRemovals())[0]; });
  const stage = f.workflow.stage(f.input); await started.promise;
  expect((await f.workflow.cancel(f.input.operationId)).status).toBe('cancelled');
  release.resolve(); expect((await stage).status).toBe('cancelled');
});

it('recovers inside the existing sync slot and returns refreshed credentials before ordinary sync', async () => {
  const f = await fixture('bitwarden', true);
  await f.vault.stagePasswordProjectRemoval(f.input);
  const old = (await f.vault.getProvider('bitwarden'))!, sync = new AbortController();
  f.active.reserve('bitwarden', sync);
  f.bitwarden.resume.mockImplementation(async () => {
    await f.vault.upsertProvider({ ...old, config: { ...old.config, accessToken: 'synthetic-new-token' } }, false);
    return f.vault.cancelPasswordProjectRemovalPreparation(f.input.operationId);
  });
  const current = await f.queue.run('bitwarden', () => f.workflow.recoverBeforeSync(old, sync.signal));
  expect(current.config.accessToken).toBe('synthetic-new-token');
  expect(f.active.owns('bitwarden', sync.signal)).toBe(true);
  expect(f.invalidate.mock.calls).toEqual([['bitwarden'], ['bitwarden']]);
});

it('stops ordinary sync when recovery remains pending or its signal does not own the slot', async () => {
  const f = await fixture('bitwarden', true);
  await f.vault.stagePasswordProjectRemoval(f.input);
  const account = (await f.vault.getProvider('bitwarden'))!, sync = new AbortController();
  await expect(f.workflow.recoverBeforeSync(account, sync.signal)).rejects.toThrow('当前同步');
  f.active.reserve('bitwarden', sync);
  await expect(f.workflow.recoverBeforeSync(account, sync.signal)).rejects.toThrow('未处理');
  sync.abort(new DOMException('Synthetic sync cancellation', 'AbortError'));
  await expect(f.workflow.recoverBeforeSync(account, sync.signal)).rejects.toThrow('Synthetic sync cancellation');
});

it('rejects a queued operation across vault lock and unlock even with an unchanged source', async () => {
  const f = await fixture('bitwarden', true), started = deferred(), release = deferred();
  const sync = f.queue.run('bitwarden', async () => { started.resolve(); await release.promise; });
  await started.promise;
  const stage = f.workflow.stage(f.input), rejected = expect(stage).rejects.toThrow('解锁会话已变化');
  await f.queue.run('independent', async () => undefined);
  await f.vault.lock(); await f.vault.unlock('Synthetic workflow master password');
  release.resolve(); await sync; await rejected;
  expect(await f.workflow.pending()).toEqual([]);
  expect(f.bitwarden.resume).not.toHaveBeenCalled();
});
