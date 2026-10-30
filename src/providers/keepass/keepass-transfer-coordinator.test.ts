import { expect, it, vi } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { createLoginItem, type ProviderAccount, type VaultState } from '../../core/model';
import { SecureVaultService } from '../../security/secure-vault-service';
import { MemoryVaultStorage } from '../../security/vault-storage';
import { MemoryVaultSessionStore } from '../../security/vault-session';
import { MemoryVaultDeviceKeyStore } from '../../security/vault-device-key';
import { ProviderOperationQueue } from '../../background/provider-operation-queue';
import { KeePassProvider } from './keepass-provider';
import { KeePassLocalWorkingCopyService } from './keepass-local-working-copy';
import { MemoryKeePassWorkingCopyStorage } from './keepass-working-copy-store';
import { buildKeePassFixture, keePassCredentials } from './keepass-fixture';
import { keePassTransferContentHash } from './keepass-transfer-file';
import { KeePassRemoteSessionService, type KeePassRemoteFileClient } from './keepass-remote-session';
import { ProviderTransportError } from '../provider-transport';
import { readKeePassTransfers } from '../../core/keepass-transfer-journal';
import { openKeePassVault } from './keepass-vault';
import { createKeePassCacheEncryptionKey } from './keepass-receipt-crypto';
import { KeePassTransferCoordinator } from './keepass-transfer-coordinator';
import { readKeePassTransferResource } from './keepass-transfer-resource';
import type { Mdbx2BatchTransferRequest } from '../mdbx2/mdbx2-batch-transfer-coordinator';

const password = 'fixture master password';
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))].map(n => n.toString(16).padStart(2, '0')).join('');
async function fixture() {
  const store = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore(), keys = new MemoryVaultDeviceKeyStore();
  const vault = new SecureVaultService(store, sessions, Date.now, keys);
  const original = createLoginItem({ title: 'Synthetic portable', password: 'portable secret' });
  await vault.setup('', [original]);
  const bytes = await buildKeePassFixture({ entries: [{ title: 'Existing target', protectedFields: { Password: 'existing secret' }, group: 'Destination' }] });
  const target: ProviderAccount = { id: 'target', name: 'Synthetic target', kind: 'keepass', enabled: true, isDefaultSaveTarget: false,
    config: { sourceMode: 'local-file', databaseId: 33, localFileSourceSha256: await digest(bytes), cacheEncryptionKey: createKeePassCacheEncryptionKey() } };
  await vault.upsertProvider(target);
  const provider = new KeePassProvider(), storage = new MemoryKeePassWorkingCopyStorage(), persistence = new KeePassLocalWorkingCopyService(provider, storage);
  await provider.unlock(target, bytes, { password, sourceMode: 'local-file' }); await persistence.initialize(target, bytes);
  const snapshot = (await vault.readState()).items, initial = await provider.sync(target, { now: new Date().toISOString(), localItems: snapshot });
  await vault.applyProviderSync(target.id, initial.items, initial.accountPatch, [], initial.sourceRecords, snapshot);
  const queue = new ProviderOperationQueue();
  const dependencies = {
    ensure: async (account: ProviderAccount) => { if (!provider.isUnlocked(account.id)) throw new Error('Locked source'); },
    reload: (account: ProviderAccount) => persistence.reload(account),
    publish: async (account: ProviderAccount) => (await persistence.publishWorkingCopy(account)).accountConfig,
    persistence: () => persistence,
    exclusive: queue.run.bind(queue),
    resource: (state: VaultState, item: VaultState['items'][number], preserve: boolean) => readKeePassTransferResource(state, item, preserve, {
      provider, files: { listSourceAttachments: async () => [], readSourceAttachment: async () => { throw new Error('Unexpected foreign read'); } }, prepare: async () => undefined })
  };
  const coordinator = new KeePassTransferCoordinator(vault, provider, storage, dependencies);
  const input: Mdbx2BatchTransferRequest = { itemIds: [original.id], targetProviderId: target.id, preserveCategories: true, action: 'copy' };
  const plan = await coordinator.plan(input), request = { ...input, operationId: plan.operationId, operationCreatedAt: plan.operationCreatedAt };
  return { vault, provider, storage, persistence, target, original, bytes, plan, request, coordinator, dependencies, store, sessions, keys };
}

it('integrates local-to-KeePass copy, encrypted completion and replay without changing unrelated items', async () => {
  const f = await fixture(), result = await f.coordinator.execute(f.request);
  expect(result.completedCount).toBe(1);
  const state = await f.vault.readState(), copy = state.items.find(row => row.id === result.items[0].targetItemId)!;
  expect(state.items).toHaveLength(3); expect(state.items.find(row => row.id === f.original.id)).toMatchObject({ password: 'portable secret' });
  expect(copy).toMatchObject({ title: f.original.title, password: 'portable secret' });
  expect(state.keepassTransfers?.[0].status).toBe('completed');
  expect(await f.coordinator.pending(f.target.id)).toEqual([]);
  const after = await f.storage.read(f.target.id);
  f.provider.lock(); f.coordinator.clear();
  expect(await f.coordinator.execute(f.request)).toEqual(result);
  expect(await f.storage.read(f.target.id)).toEqual(after);
});

it.each(['file-response', 'adoption', 'adoption-response'] as const)('recovers %s failure across coordinator and provider restart', async failure => {
  const f = await fixture();
  if (failure === 'file-response') {
    const save = f.storage.save.bind(f.storage);
    vi.spyOn(f.storage, 'save').mockImplementationOnce(async (...args) => { await save(...args); throw new Error('Lost file reply'); });
  } else {
    const adopt = f.vault.applyProviderSync.bind(f.vault);
    vi.spyOn(f.vault, 'applyProviderSync').mockImplementationOnce(async (...args) => {
      if (failure === 'adoption-response') await adopt(...args);
      throw new Error('Lost adoption');
    });
  }
  await expect(f.coordinator.execute(f.request)).rejects.toThrow();
  const committed = await f.storage.read(f.target.id);
  const restartedVault = new SecureVaultService(f.store, f.sessions, Date.now, f.keys);
  await restartedVault.unlock('');
  f.coordinator.clear(); f.provider.lock();
  await f.persistence.restore(f.target, { password });
  const next = new KeePassTransferCoordinator(restartedVault, f.provider, f.storage, f.dependencies);
  const result = await next.execute(f.request);
  expect(result.completedCount).toBe(1);
  expect(await f.storage.read(f.target.id)).toEqual(committed);
  expect((await restartedVault.readState()).items.filter(row => row.title === f.original.title)).toHaveLength(2);
});

it('recovers the latest target after file commit and later native deletion without resurrecting the receipt snapshot', async () => {
  const f = await fixture();
  vi.spyOn(f.vault, 'applyProviderSync').mockRejectedValueOnce(new Error('Synthetic adoption interruption'));
  await expect(f.coordinator.execute(f.request)).rejects.toThrow();
  const rows = (await f.provider.refreshFromSession(f.target, (await f.vault.readState()).items, new Date().toISOString())).items;
  const copy = rows.find(row => row.title === f.original.title && row.providerRefs.some(ref => ref.providerId === f.target.id))!;
  await f.provider.remove(f.target, copy); await f.persistence.persistWorkingCopy(f.target);
  await f.coordinator.execute(f.request);
  const state = await f.vault.readState();
  expect(state.items.find(row => row.id === copy.id)?.deletedAt).toBeTruthy();
  expect(state.items.find(row => row.id === f.original.id)?.deletedAt).toBeUndefined();
});

it('requires a fresh matching preview and blocks changed source or target before writing a file', async () => {
  const f = await fixture();
  await f.vault.upsertItem({ ...f.original, password: 'later source secret' });
  await expect(f.coordinator.execute(f.request)).rejects.toThrow(/预览后/);
  expect((await f.storage.read(f.target.id))!.workingBytes).toEqual(f.bytes);
  expect((await f.vault.readState()).keepassTransfers).toBeUndefined();
});

it('records failed-before-write intent, exposes it for recovery and permits cancellation only without a file receipt', async () => {
  const f = await fixture();
  vi.spyOn(f.storage, 'save').mockRejectedValueOnce(new Error('Synthetic disk failure'));
  await expect(f.coordinator.execute(f.request)).rejects.toThrow();
  expect(await f.coordinator.pending(f.target.id)).toHaveLength(1);
  f.coordinator.clear();
  await expect(f.coordinator.execute(f.request)).rejects.toThrow(/尚未写入/);
  await f.coordinator.cancel(f.target.id, f.request.operationId);
  await expect(f.coordinator.execute(f.request)).rejects.toThrow(/取消/);
  expect((await f.storage.read(f.target.id))!.workingBytes).toEqual(f.bytes);
});

it('rejects changed request identity and cancellation after a file has already committed', async () => {
  const f = await fixture();
  vi.spyOn(f.vault, 'applyProviderSync').mockRejectedValueOnce(new Error('Synthetic adoption interruption'));
  await expect(f.coordinator.execute(f.request)).rejects.toThrow();
  await expect(f.coordinator.cancel(f.target.id, f.request.operationId)).rejects.toThrow(/文件已保存/);
  await expect(f.coordinator.execute({ ...f.request, preserveCategories: false })).rejects.toThrow(/原计划/);
  const file = await openKeePassVault((await f.storage.read(f.target.id))!.workingBytes, { password, databaseId: 33, providerId: f.target.id });
  expect(file.items).toHaveLength(2);
});

it.each([[3, 1], [4, 0], [4, 1]] as const)('matches saved native moves in KDBX %i.%i while retaining supported metadata guards', async (major, minor) => {
  const bytes = await buildKeePassFixture({ version: major, entries: [{ title: 'Native entry', group: 'Source' }] });
  const db = await kdbxweb.Kdbx.load(bytes.slice().buffer, keePassCredentials(password));
  db.header.versionMinor = minor;
  const root = db.getDefaultGroup(), source = root.groups.find(row => row.name === 'Source')!;
  const destination = db.createGroup(root, 'Target');
  db.move(source.entries[0], destination); db.move(source, destination);
  const saved = new Uint8Array(await db.save());
  const reopened = await kdbxweb.Kdbx.load(saved.buffer, keePassCredentials(password));
  expect(await keePassTransferContentHash(db)).toBe(await keePassTransferContentHash(reopened));
  const baseline = await keePassTransferContentHash(db);
  destination.entries[0].previousParentGroup = kdbxweb.KdbxUuid.random();
  if (major === 4 && minor === 1) expect(await keePassTransferContentHash(db)).not.toBe(baseline);
  else expect(await keePassTransferContentHash(db)).toBe(baseline);
  const changed = await keePassTransferContentHash(db);
  destination.entries[0].fields.set('previousParentGroup', 'opaque custom field');
  expect(await keePassTransferContentHash(db)).not.toBe(changed);
});

it('refuses recovery over unpersisted native changes and succeeds after those changes are saved', async () => {
  const f = await fixture();
  vi.spyOn(f.vault, 'applyProviderSync').mockRejectedValueOnce(new Error('Synthetic interruption'));
  await expect(f.coordinator.execute(f.request)).rejects.toThrow();
  const native = (await f.provider.refreshFromSession(f.target, (await f.vault.readState()).items, new Date().toISOString())).items
    .find(row => row.title === 'Existing target')!;
  await f.provider.update(f.target, { ...native, title: 'Unsaved native edit' });
  const before = await f.storage.read(f.target.id), publish = vi.spyOn(f.dependencies, 'publish');
  await expect(f.coordinator.execute(f.request)).rejects.toThrow(/未持久保存/);
  expect(publish).not.toHaveBeenCalled(); expect(await f.storage.read(f.target.id)).toEqual(before);
  await f.persistence.persistWorkingCopy(f.target);
  await f.coordinator.execute(f.request);
  expect((await f.vault.readState()).items.find(row => row.id === native.id)?.title).toBe('Unsaved native edit');
});

it('keeps newer queued target edits and unrelated local items when recovering the whole target universe', async () => {
  const f = await fixture();
  vi.spyOn(f.vault, 'applyProviderSync').mockRejectedValueOnce(new Error('Synthetic interruption'));
  await expect(f.coordinator.execute(f.request)).rejects.toThrow();
  const original = (await f.vault.readState()).items.find(row => row.title === 'Existing target')!;
  await f.vault.upsertItem({ ...original, title: 'Later queued edit' });
  const unrelated = createLoginItem({ title: 'Unrelated local', password: 'another synthetic secret' });
  await f.vault.upsertItem(unrelated);
  const before = await f.vault.readState(), queued = before.mutationQueue;
  expect(queued.some(row => row.itemId === original.id)).toBe(true);
  await f.coordinator.execute(f.request);
  const state = await f.vault.readState();
  expect(state.items.find(row => row.id === original.id)?.title).toBe('Later queued edit');
  expect(state.items.find(row => row.id === unrelated.id)).toEqual(before.items.find(row => row.id === unrelated.id));
  expect(state.mutationQueue).toEqual(queued);
  expect(state.items.filter(row => row.title === f.original.title)).toHaveLength(2);
});

it('moves a native entry in the same file without changing its identity or password', async () => {
  const f = await fixture(), source = (await f.vault.readState()).items.find(row => row.title === 'Existing target')!;
  const input: Mdbx2BatchTransferRequest = { itemIds: [source.id], targetProviderId: f.target.id, action: 'move', preserveCategories: false };
  const plan = await f.coordinator.plan(input), request = { ...input, operationId: plan.operationId, operationCreatedAt: plan.operationCreatedAt };
  await expect(f.coordinator.execute(request)).rejects.toThrow(/确认/);
  const result = await f.coordinator.execute({ ...request, confirmed: true });
  expect(result.items[0].targetItemId).toBe(source.id);
  const state = await f.vault.readState();
  expect(state.items).toHaveLength(2);
  expect(state.items.find(row => row.id === source.id)).toMatchObject({ keepassEntryUuid: source.keepassEntryUuid, password: 'existing secret' });
  const file = await openKeePassVault((await f.storage.read(f.target.id))!.workingBytes, { password, databaseId: 33, providerId: f.target.id });
  expect(file.entriesByUuid.get(source.keepassEntryUuid!)!.parentGroup).toBe(file.database.getDefaultGroup());
});

async function remoteFixture(mode: 'webdav' | 'onedrive') {
  const f = await fixture(); f.coordinator.clear(); f.provider.lock();
  const wire = { bytes: f.bytes.slice(), etag: '"remote-1"', writes: [] as string[], loseReply: false };
  const stat = () => ({ url: 'http://127.0.0.1:8787/vault.kdbx', fileName: 'vault.kdbx', etag: wire.etag, sizeBytes: wire.bytes.length });
  const client: KeePassRemoteFileClient = {
    testConnection: async () => {}, stat: async () => stat(),
    read: async () => ({ ...stat(), bytes: wire.bytes.slice(), sha256: await digest(wire.bytes) }),
    write: async (bytes, expected) => {
      if (expected !== wire.etag) throw new ProviderTransportError('conflict', 'Synthetic ETag conflict', { retryable: false, operation: 'fixture-write', attempts: 1, status: 412 });
      wire.writes.push(expected!); wire.bytes = bytes.slice(); wire.etag = `"written-${wire.writes.length}"`;
      if (wire.loseReply) { wire.loseReply = false; throw new Error('Synthetic lost upload response'); }
      return { ...stat(), bytes: wire.bytes.slice(), sha256: await digest(wire.bytes), alreadyApplied: false };
    }
  };
  const remote = new KeePassRemoteSessionService(f.provider, f.storage, () => client, () => client);
  const base = { ...f.target, config: { ...f.target.config, sourceMode: mode,
    oneDriveConnection: { id: 'synthetic-connection', clientId: 'synthetic-client', profile: { id: 'synthetic-user' }, accessToken: 'synthetic-old-token' } } };
  const opened = mode === 'webdav'
    ? await remote.open(base, { baseUrl: 'http://127.0.0.1:8787', username: 'fixture', webDavPassword: 'synthetic', remotePath: 'vault.kdbx', databasePassword: password })
    : await remote.openOneDrive(base, { driveId: 'synthetic-drive', itemId: 'synthetic-item', databasePassword: password });
  const target = { ...base, config: opened.accountConfig };
  await f.vault.upsertProvider(target);
  const dependencies = { ...f.dependencies, reload: (account: ProviderAccount) => remote.restore(account),
    persistence: () => remote, publish: async (account: ProviderAccount, signal?: AbortSignal) => (await remote.publishWorkingCopy(account, signal))!.accountConfig };
  const coordinator = new KeePassTransferCoordinator(f.vault, f.provider, f.storage, dependencies);
  const plan = await coordinator.plan({ ...f.request, operationId: undefined, operationCreatedAt: undefined });
  const request = { ...f.request, operationId: plan.operationId, operationCreatedAt: plan.operationCreatedAt };
  return { ...f, target, remote, wire, coordinator, dependencies, plan, request };
}

it.each(['webdav', 'onedrive'] as const)('publishes %s transfers with ETag protection and keeps peer edits through rebase', async mode => {
  const f = await remoteFixture(mode);
  const peer = await kdbxweb.Kdbx.load(f.wire.bytes.slice().buffer, keePassCredentials(password));
  peer.getDefaultGroup().groups.find(row => row.name === 'Destination')!.entries[0].fields.set('Notes', 'Later peer note');
  f.wire.bytes = new Uint8Array(await peer.save()); f.wire.etag = '"peer-2"';
  expect((await f.coordinator.execute(f.request)).completedCount).toBe(1);
  expect(f.wire.writes).toEqual(['"peer-2"']);
  const opened = await openKeePassVault(f.wire.bytes, { password, databaseId: 33, providerId: f.target.id });
  expect(opened.items).toHaveLength(2); expect(opened.items.find(row => row.title === 'Existing target')?.notes).toBe('Later peer note');
  expect((await f.vault.readState()).items.find(row => row.title === 'Existing target')?.notes).toBe('Later peer note');
  const record = (await f.storage.read(f.target.id))!; expect(record.workingSha256).toBe(record.baseSha256);
});

it.each(['webdav', 'onedrive'] as const)('recovers a lost %s publication response after restart without duplicate copies', async mode => {
  const f = await remoteFixture(mode); f.wire.loseReply = true;
  await expect(f.coordinator.execute(f.request)).rejects.toThrow(/lost upload/);
  expect((await f.vault.readState()).keepassTransfers![0].status).toBe('writing');
  f.provider.lock(); f.coordinator.clear(); await f.remote.restore(f.target);
  const restarted = new SecureVaultService(f.store, f.sessions, Date.now, f.keys); await restarted.unlock('');
  const coordinator = new KeePassTransferCoordinator(restarted, f.provider, f.storage, f.dependencies);
  expect((await coordinator.execute(f.request)).completedCount).toBe(1);
  const opened = await openKeePassVault(f.wire.bytes, { password, databaseId: 33, providerId: f.target.id });
  expect(opened.items.filter(row => row.title === f.original.title)).toHaveLength(1);
  const after = f.wire.bytes.slice(), writes = f.wire.writes.length;
  await coordinator.execute(f.request); expect(f.wire.bytes).toEqual(after); expect(f.wire.writes).toHaveLength(writes);
});

it.each(['before-resume', 'during-reload'] as const)('rejects target reconfiguration %s before cloud publication', async when => {
  const f = await remoteFixture('webdav');
  vi.spyOn(f.dependencies, 'publish').mockRejectedValueOnce(new Error('Synthetic offline'));
  await expect(f.coordinator.execute(f.request)).rejects.toThrow(/offline/);
  const replace = () => f.vault.upsertProvider({ ...f.target, config: { ...f.target.config, remotePath: 'other.kdbx' } });
  if (when === 'before-resume') await replace();
  else { const reload = f.dependencies.reload; vi.spyOn(f.dependencies, 'reload').mockImplementationOnce(async account => { const result = await reload(account); await replace(); return result; }); }
  await expect(f.coordinator.execute(f.request)).rejects.toThrow(/密码源已变化/);
  expect(f.wire.writes).toEqual([]);
  expect(f.wire.bytes).toEqual(f.bytes);
});

it('stops after a lock during reload before publishing a committed file', async () => {
  const f = await remoteFixture('webdav'), reload = f.dependencies.reload;
  vi.spyOn(f.dependencies, 'reload').mockImplementationOnce(async account => { const result = await reload(account); f.coordinator.clear(); return result; });
  await expect(f.coordinator.execute(f.request)).rejects.toThrow(/锁定/);
  expect(f.wire.writes).toEqual([]);
});

it('aborts an in-flight publication on lock and keeps the pending file recoverable', async () => {
  const f = await remoteFixture('webdav');
  vi.spyOn(f.dependencies, 'publish').mockImplementationOnce(async (_account, signal) => {
    expect(signal?.aborted).toBe(false); f.coordinator.clear();
    expect(signal?.aborted).toBe(true); throw new DOMException('Synthetic aborted upload', 'AbortError');
  });
  await expect(f.coordinator.execute(f.request)).rejects.toThrow(/aborted upload/);
  expect((await f.coordinator.pending(f.target.id))).toHaveLength(1);
  expect(f.wire.writes).toHaveLength(0);
  await f.coordinator.execute(f.request);
  expect((await f.coordinator.pending(f.target.id))).toHaveLength(0);
});

it.each(['folder', 'attachment'] as const)('revalidates authenticated %s resources after preview before a file is written', async kind => {
  const f = await fixture(), resource = f.dependencies.resource;
  vi.spyOn(f.dependencies, 'resource').mockImplementationOnce(async (...args) => {
    const row = await resource(...args);
    if (kind === 'folder') row.folder = { identities: ['later-folder'], segments: ['Later folder'] };
    else row.attachments = [{ itemId: f.original.id, attachmentId: 'later-file', fileName: 'later.txt',
      sizeBytes: 1, sha256: await digest(Uint8Array.of(1)), dataBase64: 'AQ==' }];
    return row;
  });
  await expect(f.coordinator.execute(f.request)).rejects.toThrow(/预览后已变化/);
  expect((await f.storage.read(f.target.id))!.workingBytes).toEqual(f.bytes);
  expect((await f.vault.readState()).keepassTransfers).toBeUndefined();
});

it('keeps refreshed OneDrive tokens through publication and the final vault transaction', async () => {
  const f = await remoteFixture('onedrive'), apply = f.vault.applyProviderSync.bind(f.vault);
  vi.spyOn(f.vault, 'applyProviderSync').mockImplementationOnce(async (...args) => {
    const latest = (await f.vault.readState()).providers.find(row => row.id === f.target.id)!;
    await f.vault.upsertProvider({ ...latest, config: { ...latest.config, oneDriveConnection: {
      ...(latest.config.oneDriveConnection as object), accessToken: 'synthetic-refreshed-token'
    } } });
    return apply(...args);
  });
  await f.coordinator.execute(f.request);
  expect((await f.vault.readState()).providers.find(row => row.id === f.target.id)!.config.oneDriveConnection).toMatchObject({ accessToken: 'synthetic-refreshed-token' });
});

it('rejects inconsistent encrypted recovery plans and result identities', async () => {
  const f = await fixture(); await f.coordinator.execute(f.request);
  const original = (await f.vault.readState()).keepassTransfers![0];
  expect(readKeePassTransfers([original])).toEqual([original]);
  for (const change of [
    (row: typeof original) => { row.plan.action = 'move'; },
    (row: typeof original) => { row.plan.operationCreatedAt = '2020-01-01T00:00:00Z'; },
    (row: typeof original) => { row.plan.targetCollectionId = 'different'; },
    (row: typeof original) => { row.plan.items[0].sourceItemId = 'different'; },
    (row: typeof original) => { row.plan.requiresMoveConfirmation = true; },
    (row: typeof original) => { row.result!.completedCount++; },
    (row: typeof original) => { row.result!.items[0].targetItemId = ''; }
  ]) {
    const row = structuredClone(original); change(row);
    expect(() => readKeePassTransfers([row])).toThrow(/恢复记录无效/);
  }
  const tampered = structuredClone(original); tampered.status = 'writing'; delete tampered.result;
  tampered.requestHash = 'f'.repeat(64);
  await expect(f.vault.stageKeePassTransfer(tampered)).rejects.toThrow(/校验失败/);
});
