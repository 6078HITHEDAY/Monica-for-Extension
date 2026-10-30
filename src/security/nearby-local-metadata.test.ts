import { describe, expect, it, vi } from 'vitest';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';
import { MemoryVaultDeviceKeyStore } from './vault-device-key';
import { createLoginItem, type VaultItem } from '../core/model';
import { parseLosslessJson } from '../core/lossless-json';
import { nearbyLocalItemToWire } from '../nearby/application-codec';
import { readNearbyLocalMetadata } from '../nearby/local-metadata';
import { groupNearbyPending } from '../nearby/pending';
import type { NearbyIncomingRecord } from '../nearby/local-adoption';
import type { NearbyWireData } from '../nearby/wire-shape';

const parent = '11111111-1111-4111-8111-111111111111', child = '22222222-2222-4222-8222-222222222222', root = '33333333-3333-4333-8333-333333333333';
const parentPath = [{ id: parent, title: 'Same name', parent: null }];
const childPath = [...parentPath, { id: child, title: 'Same name', parent }];
const folders: NearbyWireData[] = [
  { title: 'Same name', folder: '', entry_type: 'folder', payload: { path: parentPath, tags: [{ name: 'parent tag', payload: '{"n":9007199254740993}', version: 1 }] } },
  { title: 'Same name', folder: '', entry_type: 'folder', payload: { path: childPath, opaque: parseLosslessJson('{"n":9007199254740993,"d":1.00000000000000001}') } },
  { title: 'Independent root', folder: '', entry_type: 'vault-metadata', payload: { tags: [{ name: 'root tag', payload: '{"custom":"synthetic secret"}', version: 4294967295 }] } }
];
function incoming(id: string, data: NearbyWireData, version = 1, deleted = false): NearbyIncomingRecord {
  return { id, dataJson: JSON.stringify(data), clockJson: `{"phone":${version}}`, deleted };
}
async function fixture(items: VaultItem[] = []) {
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore(), keys = new MemoryVaultDeviceKeyStore();
  const service = new SecureVaultService(storage, sessions, Date.now, keys); await service.setup('', items);
  const providerId = (await service.readState()).providers[0].id, sessionId = (await service.passkeySessionId())!;
  const apply = async (records: NearbyIncomingRecord[]) => service.adoptNearbyLocalTransaction({ providerId,
    sourceHash: await service.nearbyLocalSnapshotHash(), records, assets: [] }, sessionId);
  return { storage, sessions, keys, service, providerId, sessionId, apply };
}

describe('nearby encrypted folder and root metadata adoption', () => {
  it('retains nested same-name identities, empty folders, exact metadata and item membership through restart', async () => {
    const f = await fixture();
    const data = await nearbyLocalItemToWire(createLoginItem({ title: 'Classified password', password: 'synthetic password' }), { folder: 'Same name', folder_path: childPath });
    const records = [incoming('login', data), incoming(root, folders[2]), incoming(child, folders[1]), incoming(parent, folders[0])];
    const result = await f.apply(records); expect(result.acknowledgements).toHaveLength(4);
    const state = await f.service.readState(); expect(state.items).toHaveLength(1); expect(state.nearbyLocalMetadata).toHaveLength(3);
    expect(state.localTransferFolders).toHaveLength(2);
    expect(state.items[0].categoryId).toBe(state.localTransferFolders!.find(row => row.origin === `nearby-folder:${child}`)!.categoryId);
    expect(JSON.stringify(await f.storage.read())).not.toContain('synthetic secret');
    const restarted = new SecureVaultService(f.storage, f.sessions, Date.now, f.keys);
    const snapshot = await restarted.captureNearbyLocalRecords(); expect(snapshot.records).toHaveLength(4);
    for (const [index, id] of [parent, child, root].entries()) expect(JSON.stringify(snapshot.records.find(row => row.global_id === id)!.data)).toBe(JSON.stringify(folders[index]));
    expect(snapshot.records.find(row => row.data.entry_type === 'login')!.data.folder_path).toEqual(childPath);
    expect(await restarted.nearbySavedAcknowledgements(records, f.sessionId)).toEqual(result.acknowledgements);
  });
  it('durably replays all metadata receipts after the committed response is lost', async () => {
    const f = await fixture(), records = [incoming(parent, folders[0]), incoming(child, folders[1]), incoming(root, folders[2])];
    const write = f.storage.write.bind(f.storage); vi.spyOn(f.storage, 'write').mockImplementationOnce(async envelope => { await write(envelope); throw Error('reply lost'); });
    await expect(f.apply(records)).rejects.toThrow('reply lost');
    const restarted = new SecureVaultService(f.storage, f.sessions, Date.now, f.keys);
    const acks = await restarted.nearbySavedAcknowledgements(records, f.sessionId); expect(acks).toHaveLength(3);
    const replay = await restarted.adoptNearbyLocalTransaction({ providerId: f.providerId, sourceHash: '0'.repeat(64), records, assets: [] }, f.sessionId);
    expect(replay.acknowledgements).toEqual(acks); expect((await restarted.readState()).localTransferFolders).toHaveLength(2);
  });
  it('exports original local categories and applies authenticated rename/delete without changing password IDs', async () => {
    const item = { ...createLoginItem({ title: 'Original local', password: 'unchanged' }), categoryId: 7, categoryName: 'Original folder' };
    const f = await fixture([item]), before = await f.service.captureNearbyLocalRecords();
    const folder = before.records.find(row => row.data.entry_type === 'folder')!;
    expect(folder).toBeDefined(); expect(before.records).toHaveLength(2);
    const renamed = { ...folder.data, title: 'Renamed folder' };
    const update = { ...incoming(folder.global_id, renamed), localId: folder.local_id, scope: 'local', expectedGuard: folder.guard };
    await f.apply([update]);
    const saved = (await f.service.readState()).items[0]; expect(saved.id).toBe(item.id); expect(saved.categoryName).toBe('Renamed folder'); expect(saved.categoryId).toBe(7);
    const next = await f.service.captureNearbyLocalRecords(), metadata = next.records.find(row => row.data.entry_type === 'folder')!;
    expect(metadata.global_id).toBe(folder.global_id); expect(metadata.local_id).toBe(folder.local_id);
    expect((metadata.data.payload as any).path[0].title).toBe('Renamed folder');
    await f.apply([{ ...incoming(folder.global_id, metadata.data, 2, true), localId: metadata.local_id, scope: 'local', expectedGuard: metadata.guard }]);
    const removed = await f.service.readState(); expect(removed.items[0].id).toBe(item.id); expect(removed.items[0].categoryId).toBeUndefined();
    expect(removed.localTransferFolders).toHaveLength(0);
    expect((await f.service.captureNearbyLocalRecords()).records.find(row => row.global_id === folder.global_id)?.deleted).toBe(true);
    await f.apply([incoming(folder.global_id, metadata.data, 3)]);
    expect((await f.service.readState()).localTransferFolders?.[0].categoryId).toBe(7);
    expect((await f.service.readState()).items[0].categoryId).toBeUndefined();
  });
  it('keeps metadata at the end of paginated application adoption without enlarging projects', async () => {
    const data = await nearbyLocalItemToWire(createLoginItem({ title: 'Page item' }), { folder: 'Same name', folder_path: childPath });
    const rows = [incoming(parent, folders[0]), ...Array.from({ length: 300 }, (_, i) => incoming(`item-${i}`, data)), incoming(child, folders[1])];
    const batches = groupNearbyPending(rows); expect(batches.map(batch => batch.length)).toEqual([200, 102]);
    expect(batches[1].slice(-2).map(row => row.id)).toEqual([parent, child]);
  });
  it('rejects stale metadata guards and type changes atomically', async () => {
    const f = await fixture(); await f.apply([incoming(parent, folders[0])]);
    const before = await f.service.nearbyLocalSnapshotHash(), metadata = (await f.service.captureNearbyLocalRecords()).records[0];
    await expect(f.apply([{ ...incoming(parent, { ...folders[0], title: 'Unsafe rename' }, 2), localId: metadata.local_id, scope: 'local', expectedGuard: '0'.repeat(64) }])).rejects.toThrow('metadata-binding-changed');
    await expect(f.apply([incoming(parent, folders[2], 2)])).rejects.toThrow('metadata-type-changed');
    expect(await f.service.nearbyLocalSnapshotHash()).toBe(before);
  });
  it('rejects corrupt metadata receipts instead of silently resetting portable identity', async () => {
    const f = await fixture(); await f.apply([incoming(parent, folders[0])]);
    const metadata = (await f.service.readState()).nearbyLocalMetadata!;
    expect(() => readNearbyLocalMetadata([...metadata, metadata[0]])).toThrow('metadata-identity');
    expect(() => readNearbyLocalMetadata([{ ...metadata[0], acknowledgement: { ...metadata[0].acknowledgement, localId: 'local:other' } }])).toThrow('metadata-receipt');
  });
  it('accepts Android empty folder tombstones and preserves their original identity for restore', async () => {
    const f = await fixture(); await f.apply([incoming(parent, folders[0])]);
    const before = (await f.service.captureNearbyLocalRecords()).records[0];
    const deletion = { id: parent, clockJson: '{"phone":2}', dataJson: '{}', deleted: true,
      localId: before.local_id, scope: 'local', expectedGuard: before.guard };
    const result = await f.apply([deletion]);
    expect((await f.service.readState()).localTransferFolders).toHaveLength(0);
    expect(await f.service.nearbySavedAcknowledgements([deletion], f.sessionId)).toEqual(result.acknowledgements);
    const deleted = (await f.service.captureNearbyLocalRecords()).records[0]; expect(deleted.deleted).toBe(true); expect(deleted.global_id).toBe(parent);
    await f.apply([incoming(parent, folders[0], 3)]); expect((await f.service.readState()).localTransferFolders).toHaveLength(1);
  });
  it('retains an unknown empty tombstone across restart and safely adopts its later resurrection', async () => {
    const f = await fixture(), record = { id: 'unknown-original', clockJson: '{"phone":2}', dataJson: '{}', deleted: true };
    await f.apply([record]); expect((await f.service.readState()).items).toEqual([]);
    const restarted = new SecureVaultService(f.storage, f.sessions, Date.now, f.keys);
    const tombstone = (await restarted.captureNearbyLocalRecords()).records[0];
    expect(tombstone.deleted).toBe(true); expect(tombstone.data).toEqual({});
    const data = await nearbyLocalItemToWire(createLoginItem({ title: 'Restored original', password: 'original secret' }), {});
    const restored = { ...incoming(record.id, data, 3), localId: tombstone.local_id, scope: 'local', expectedGuard: tombstone.guard };
    await restarted.adoptNearbyLocalTransaction({ providerId: f.providerId, sourceHash: await restarted.nearbyLocalSnapshotHash(), records: [restored], assets: [] }, f.sessionId);
    expect((await restarted.readState()).items).toHaveLength(1); expect((await restarted.readState()).nearbyLocalMetadata).toEqual([]);
    expect((await restarted.captureNearbyLocalRecords()).records[0].global_id).toBe(record.id);
  });
  it('applies an empty content tombstone to the authenticated original item', async () => {
    const item = createLoginItem({ title: 'Original content', password: 'retain in trash' }), f = await fixture([item]);
    const record = (await f.service.captureNearbyLocalRecords()).records[0];
    const deletion = { id: record.global_id, localId: record.local_id, scope: 'local', expectedGuard: record.guard, clockJson: '{"phone":1}', dataJson: '{}', deleted: true };
    await f.apply([deletion]); const saved = (await f.service.readState()).items[0];
    expect(saved.id).toBe(item.id); expect(saved.deletedAt).toBeDefined(); expect(saved.kind === 'login' && saved.password).toBe(item.password);
    expect(await f.service.nearbySavedAcknowledgements([deletion], f.sessionId)).toHaveLength(1);
  });
  it.each([true, false])('renames a folder after paginated reciprocal edits without rebinding original items (numeric=%s)', async numeric => {
    const items = Array.from({ length: 205 }, (_, i) => ({ ...createLoginItem({ title: `Original ${i}`, password: 'synthetic original' }),
      categoryId: numeric ? 7 : undefined, categoryName: 'Original folder' }));
    const f = await fixture(items), snapshot = await f.service.captureNearbyLocalRecords();
    const records = snapshot.records.map(row => ({ id: row.global_id, localId: row.local_id, scope: 'local', expectedGuard: row.guard,
      clockJson: '{"phone":1}', deleted: false, dataJson: JSON.stringify(row.data.entry_type === 'folder' ? { ...row.data, title: 'Remote rename' } : { ...row.data, notes: 'Remote edit' }) }));
    for (const batch of groupNearbyPending(records)) await f.apply(batch);
    const state = await f.service.readState(); expect(state.items.map(item => item.id).sort()).toEqual(items.map(item => item.id).sort());
    expect(new Set(state.items.map(item => item.categoryId)).size).toBe(1); expect(state.localTransferFolders).toHaveLength(1);
    expect(state.items.every(item => item.notes === 'Remote edit' && item.categoryName === 'Remote rename')).toBe(true);
    expect((await f.service.captureNearbyLocalRecords()).records.filter(row => row.data.entry_type === 'folder')).toHaveLength(1);
  });
  it('starts new replica replay history on portable restore while retaining original content and folder identities', async () => {
    const f = await fixture();
    const data = await nearbyLocalItemToWire(createLoginItem({ title: 'Original backed-up item', password: 'unchanged' }), { folder: 'Same name', folder_path: parentPath });
    await f.apply([incoming(parent, folders[0]), incoming(root, folders[2]), incoming('original-content', data)]);
    const before = await f.service.readState(), backup = await f.service.exportEncryptedBackup('Synthetic backup password');
    const restored = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore(), Date.now, new MemoryVaultDeviceKeyStore());
    await restored.restoreEncryptedBackup(backup, 'Synthetic backup password');
    const session = (await restored.passkeySessionId())!, snapshot = await restored.captureNearbyLocalRecords();
    const records = snapshot.records.map(row => ({ id: row.global_id, localId: row.local_id, scope: 'local', expectedGuard: row.guard,
      deleted: false, clockJson: '{"fresh-replica":1}', dataJson: JSON.stringify(row.data.entry_type === 'login' ? { ...row.data, notes: 'New device edit' } : row.data) }));
    for (const batch of groupNearbyPending(records)) await expect(restored.adoptNearbyLocalTransaction({ providerId: f.providerId,
      sourceHash: await restored.nearbyLocalSnapshotHash(), records: batch, assets: [] }, session)).resolves.toBeDefined();
    const result = await restored.readState(); expect(result.items[0].id).toBe(before.items[0].id); expect(result.items[0].notes).toBe('New device edit');
    expect(result.localTransferFolders).toEqual(before.localTransferFolders);
  });
  it('does not reuse a deleted folder identity for a newly received category', async () => {
    const f = await fixture(); await f.apply([incoming(parent, folders[0])]);
    const original = (await f.service.readState()).localTransferFolders![0].categoryId;
    await f.apply([{ id: parent, clockJson: '{"phone":2}', dataJson: '{}', deleted: true }]);
    const data = await nearbyLocalItemToWire(createLoginItem({ title: 'New folder item' }), { folder: 'New folder', folder_path: [{ id: child, title: 'New folder', parent: null }] });
    await f.apply([incoming('new-folder-item', data)]);
    const saved = await f.service.readState(); expect(saved.items[0].categoryId).not.toBe(original);
    const metadata = (await f.service.captureNearbyLocalRecords()).records.filter(row => row.data.entry_type === 'folder');
    expect(metadata).toHaveLength(2); expect(metadata.find(row => row.global_id === parent)!.deleted).toBe(true);
    expect(metadata.find(row => row.global_id === child)!.deleted).toBe(false);
  });
  it('keeps empty password-project tombstones together at a pagination boundary', async () => {
    const first = { ...createLoginItem({ title: 'Original group member' }), passwordGroupId: 'same-project' };
    const second = { ...first, id: crypto.randomUUID(), title: 'Second original group member' };
    const f = await fixture([first, second]), snapshot = await f.service.captureNearbyLocalRecords();
    const records = snapshot.records.map(row => ({ id: row.global_id, localId: row.local_id, scope: 'local', expectedGuard: row.guard, clockJson: '{"phone":1}', dataJson: '{}', deleted: true }));
    const ordinary = await nearbyLocalItemToWire(createLoginItem({ title: 'Independent' }), {});
    const padded = [...Array.from({ length: 199 }, (_, i) => incoming(`independent-${i}`, ordinary)), ...records];
    const groups = new Map(await f.service.nearbyPendingPasswordGroups(padded, f.sessionId));
    const batches = groupNearbyPending(padded, new Map(), groups);
    expect(batches.map(batch => batch.length)).toEqual([199, 2]);
    for (const batch of batches) await f.apply(batch);
    expect((await f.service.readState()).items.filter(item => [first.id, second.id].includes(item.id)).every(item => !!item.deletedAt)).toBe(true);
  });
});
