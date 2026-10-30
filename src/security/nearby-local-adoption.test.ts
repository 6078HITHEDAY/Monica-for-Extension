import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';
import { MemoryVaultDeviceKeyStore } from './vault-device-key';
import { bytesToBase64 } from './encoding';
import { createLoginItem, type PasskeyItem, type VaultItem } from '../core/model';
import { parseLosslessJson } from '../core/lossless-json';
import { resolveBoundNote } from '../core/bound-notes';
import { resolveSsoAccount } from '../core/sso-links';
import { nearbyLocalItemToWire } from '../nearby/application-codec';
import { nearbySha256 } from '../nearby/native-transport';
import { wireObject } from '../nearby/wire-shape';
import type { NearbyLocalBatch } from '../nearby/local-adoption';
import { captureNearbyLocalSnapshot } from '../nearby/local-adoption';

const now = '2026-10-15T00:00:00.000Z';
let key: PasskeyItem;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  key = { ...createLoginItem({ title: 'Existing key' }), kind: 'passkey', rpId: 'nearby.example.test', rpName: 'Nearby', userName: 'alice', userDisplayName: 'Alice',
    credentialId: 'AQIDBA', userHandle: 'dXNlcg', algorithm: -7, signCount: 19, discoverable: true, sourceMode: 'browser-local', createdAt: now, updatedAt: now,
    privateKeyPkcs8: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))), publicKey: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))) };
});

async function fixture(items: VaultItem[] = []) {
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore(), keys = new MemoryVaultDeviceKeyStore();
  const service = new SecureVaultService(storage, sessions, Date.now, keys);
  await service.setup('', items);
  const providerId = (await service.readState()).providers[0].id;
  return { storage, sessions, keys, service, providerId, sessionId: (await service.passkeySessionId())! };
}

async function batch(service: SecureVaultService, providerId: string): Promise<NearbyLocalBatch> {
  const one = createLoginItem({ title: 'Project one', username: 'alice', password: 'synthetic nearby password' });
  one.passwordGroupId = 'project-one'; one.customFields = [{ name: 'duplicate', value: 'one', protected: true }, { name: 'duplicate', value: 'two', protected: true }];
  one.addressLine = 'Synthetic street'; one.appPackageName = 'nearby.synthetic'; one.passwordHistory = [{ password: 'old synthetic password', lastUsedAt: now }];
  const two = { ...one, id: crypto.randomUUID(), title: 'Project two', password: 'second synthetic password' };
  const note: VaultItem = { ...createLoginItem({ title: 'Related note' }), kind: 'secure-note', content: 'synthetic private note' };
  const account = createLoginItem({ title: 'SSO', password: 'sso synthetic password' });
  const otp: VaultItem = { ...createLoginItem({ title: 'Authenticator' }), kind: 'totp', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', period: 30, digits: 6 };
  const bytes = new Uint8Array(600000).fill(41), id = await nearbySha256(bytes);
  const records = await Promise.all([one, two, note, account, otp].map(async (item, index) => {
    const data = await nearbyLocalItemToWire(item, { folder: 'Personal', folder_path: [{ id: '11111111-1111-4111-8111-111111111111', title: 'Personal', parent: null }],
      assets: index === 0 ? [{ id, size: bytes.length, file_name: 'synthetic.bin', media_type: 'application/octet-stream' }] : [] });
    if (index === 0) Object.assign(wireObject(data.extensions), { bound_note_entry_id: 'record-2', sso_ref_entry_id: 'record-3', opaque: parseLosslessJson('{"n":9007199254740993,"decimal":1.00000000000000001}') });
    if (index === 4) wireObject(data.payload).bound_password_entry_id = 'record-0';
    return { id: `record-${index}`, dataJson: JSON.stringify(data), clockJson: '{"android":9007199254740993}', deleted: false };
  }));
  return { providerId, sourceHash: await service.nearbyLocalSnapshotHash(), records, assets: [{ id, dataBase64: bytesToBase64(bytes) }] };
}

describe('encrypted nearby application adoption', () => {
  it('adopts a replacement attachment received with retained trash instead of keeping stale bytes',async()=>{
    const f=await fixture([]),data=await nearbyLocalItemToWire(createLoginItem({title:'Trash file'}),{});
    const oldBytes=new Uint8Array([1,2,3]),newBytes=new Uint8Array([4,5,6,7]);
    const oldHash=await nearbySha256(oldBytes),newHash=await nearbySha256(newBytes);
    data.assets=[{id:oldHash,size:oldBytes.length,file_name:'file.bin',media_type:'application/octet-stream'}];
    await f.service.adoptNearbyLocalTransaction({providerId:f.providerId,sourceHash:await f.service.nearbyLocalSnapshotHash(),records:[{id:'remote-trash',deleted:false,dataJson:JSON.stringify(data),clockJson:'{"remote":1}'}],assets:[{id:oldHash,dataBase64:bytesToBase64(oldBytes)}]},f.sessionId);
    const snapshot=await f.service.captureNearbyLocalRecords(),original=snapshot.records.find(row=>row.global_id==='remote-trash')!;
    const update={...original.data,trashed:true,assets:[{id:newHash,size:newBytes.length,file_name:'changed.bin',media_type:'application/octet-stream'}]};
    await f.service.adoptNearbyLocalTransaction({providerId:f.providerId,sourceHash:snapshot.sourceHash,records:[{id:'remote-trash',deleted:true,dataJson:JSON.stringify(update),clockJson:'{"remote":2}',localId:original.local_id,scope:original.scope,expectedGuard:original.guard}],assets:[{id:newHash,dataBase64:bytesToBase64(newBytes)}]},f.sessionId);
    const state=await f.service.readState();expect(state.localItemAttachments).toMatchObject([{fileName:'changed.bin',sha256:newHash,dataBase64:bytesToBase64(newBytes)}]);
    expect((await f.service.captureNearbyLocalRecords()).assets.map(a=>a.id)).toContain(newHash);
  });
  it('retains original guards across batches that normalize legacy local source scopes', async () => {
    const one = createLoginItem({ title: 'First legacy item' });
    const two = createLoginItem({ title: 'Later legacy item' });
    const f = await fixture([one, two]), snapshot = await f.service.captureNearbyLocalRecords();
    let sourceHash = snapshot.sourceHash;
    for (const original of snapshot.records) {
      const records = [{ id: original.global_id, deleted: false, clockJson: '{"remote":1}', dataJson: JSON.stringify({ ...original.data, notes: 'remote edit' }),
        localId: original.local_id, scope: original.scope, expectedGuard: original.guard }];
      sourceHash = (await f.service.adoptNearbyLocalTransaction({ providerId: f.providerId, sourceHash, records, assets: [] }, f.sessionId)).sourceHash;
    }
    const state = await f.service.readState();
    expect(state.items.map(item => item.id).sort()).toEqual([one.id, two.id].sort());
    expect(state.items.every(item => item.notes === 'remote edit')).toBe(true);
  });
  it('updates the original local binding and resolves an unchanged local dependency without duplicates', async () => {
    const note: VaultItem = { ...createLoginItem({ title: 'Original note' }), kind: 'secure-note', content: 'original note content' };
    const login = { ...createLoginItem({ title: 'Original login', password: 'original secret' }), boundNoteEntryId: `note:${note.id}` };
    const f = await fixture([login, note]), snapshot = await f.service.captureNearbyLocalRecords();
    const original = snapshot.records.find(row => row.local_id === `local:${login.id}`)!;
    const dependency = snapshot.records.find(row => row.local_id === `local:${note.id}`)!;
    const data = { ...original.data, notes: 'changed on remote device' };
    const records = [{ id: original.global_id, deleted: false, clockJson: '{"remote":1}', dataJson: JSON.stringify(data),
      localId: original.local_id, scope: original.scope, expectedGuard: original.guard }];
    const result = await f.service.adoptNearbyLocalTransaction({ providerId: f.providerId, sourceHash: snapshot.sourceHash, records, assets: [],
      references: [{ id: dependency.global_id, localId: dependency.local_id }] }, f.sessionId);
    const state = await f.service.readState(); expect(state.items).toHaveLength(2);
    const changed = state.items.find(item => item.id === login.id)!;
    expect(changed).toMatchObject({ password: login.password, notes: 'changed on remote device', boundNoteEntryId: login.boundNoteEntryId });
    expect(resolveBoundNote(changed as typeof login, state.items)?.id).toBe(note.id);
    expect(result.acknowledgements[0].localId).toBe(original.local_id);
    expect(await f.service.nearbyLocalSnapshotHash()).toBe(result.sourceHash);
    expect(await f.service.nearbySavedAcknowledgements(records, f.sessionId)).toEqual(result.acknowledgements);
    const before = await f.storage.read();
    await expect(f.service.adoptNearbyLocalRecords({ providerId: f.providerId, sourceHash: result.sourceHash, records: [{ ...records[0], clockJson: '{"remote":2}' }], assets: [] }, f.sessionId)).rejects.toThrow('local-binding-changed');
    expect(await f.storage.read()).toEqual(before);
  });
  it('excludes live external providers and retains archival source data', async () => {
    const f = await fixture([createLoginItem({ title: 'Local' })]), state = await f.service.readState();
    state.providers.push({ id: 'external', kind: 'bitwarden', enabled: true, name: 'External', config: {}, isDefaultSaveTarget: false });
    state.items.push({ ...createLoginItem({ title: 'External' }), providerRefs: [{ providerId: 'external' }] });
    expect((await captureNearbyLocalSnapshot(state)).records.map(row => row.data.title)).toEqual(['Local']);
    state.localItemOrigins = [{ itemId: state.items[0].id, records: [{ providerId: 'old', remoteId: 'native', format: 'future', encoding: 'json', payload: '{"future":true}', contentHash: 'old' }] }];
    const copied = await captureNearbyLocalSnapshot(state);
    expect(JSON.stringify(copied.records[0].data.labels)).toContain('future');
    expect(copied.records).toHaveLength(1);
  });
  it('saves complete projects, note/SSO/OTP associations, raw fields and attachments in one encrypted write', async () => {
    const f = await fixture(), incoming = await batch(f.service, f.providerId), write = vi.spyOn(f.storage, 'write');
    const acks = await f.service.adoptNearbyLocalRecords(incoming, f.sessionId);
    expect(write).toHaveBeenCalledOnce(); expect(acks).toHaveLength(5);
    const restored = await new SecureVaultService(f.storage, f.sessions, Date.now, f.keys).readState();
    expect(restored.items).toHaveLength(5);
    const one = restored.items.find(item => item.title === 'Project one')!;
    expect(one).toMatchObject({ kind: 'login', passwordGroupId: 'project-one', addressLine: 'Synthetic street', appPackageName: 'nearby.synthetic', categoryName: 'Personal' });
    if (one.kind !== 'login') throw Error('missing login');
    expect(resolveBoundNote(one, restored.items)?.title).toBe('Related note'); expect(resolveSsoAccount(one, restored.items)?.title).toBe('SSO');
    expect(restored.items.find(item => item.id === one.boundTotpItemId)?.kind).toBe('totp');
    expect(restored.localItemAttachments?.[0]).toMatchObject({ itemId: one.id, sizeBytes: 600000, dataBase64: incoming.assets[0].dataBase64 });
    expect(restored.nearbyLocalReceipts?.[0].dataJson).toContain('9007199254740993'); expect(restored.nearbyLocalReceipts?.[0].dataJson).toContain('1.00000000000000001');
    expect(acks[0].clockJson).toBe('{"android":9007199254740993}');
    const captured = await f.service.captureNearbyLocalRecords();
    const exported = captured.records.find(row => row.data.title === 'Project one')!;
    expect(JSON.stringify(exported.data)).toContain('1.00000000000000001');
    expect(wireObject(exported.data.extensions).bound_note_entry_id).toBe('record-2');
    expect(wireObject(exported.data.extensions).sso_ref_entry_id).toBe('record-3');
    expect(captured.assets[0].dataBase64).toBe(incoming.assets[0].dataBase64);
    const stored = JSON.stringify(await f.storage.read()); for (const secret of ['synthetic nearby password', 'old synthetic password', 'synthetic private note', incoming.assets[0].dataBase64]) expect(stored).not.toContain(secret);
  });

  it.each(['storage', 'asset', 'reference', 'clock', 'source', 'session'] as const)('does not partially adopt or acknowledge when %s fails', async fault => {
    const f = await fixture(), incoming = await batch(f.service, f.providerId);
    if (fault === 'storage') vi.spyOn(f.storage, 'write').mockRejectedValue(new Error('synthetic quota failure'));
    if (fault === 'asset') incoming.assets[0].dataBase64 = 'AQID';
    if (fault === 'reference') incoming.records = incoming.records.filter(row => row.id !== 'record-2');
    if (fault === 'clock') incoming.records[4].clockJson = '{"android":-1}';
    if (fault === 'source') await f.service.upsertItem(createLoginItem({ title: 'Later edit' }));
    if (fault === 'session') await f.service.lock();
    const before = await f.storage.read();
    await expect(f.service.adoptNearbyLocalRecords(incoming, f.sessionId)).rejects.toThrow();
    expect(await f.storage.read()).toEqual(before);
    if (fault !== 'session') expect((await f.service.readState()).items).toHaveLength(fault === 'source' ? 1 : 0);
  });

  it('recovers a lost commit response after restart without replacing later edits or rewriting the envelope', async () => {
    const f = await fixture(), incoming = await batch(f.service, f.providerId), write = f.storage.write.bind(f.storage);
    vi.spyOn(f.storage, 'write').mockImplementationOnce(async envelope => { await write(envelope); throw Error('stored reply lost'); });
    await expect(f.service.adoptNearbyLocalRecords(incoming, f.sessionId)).rejects.toThrow('stored reply lost');
    const service = new SecureVaultService(f.storage, f.sessions, Date.now, f.keys), state = await service.readState();
    await service.upsertItem({ ...state.items[0], notes: 'later user edit' });
    const before = await f.storage.read();
    expect(await service.adoptNearbyLocalRecords(incoming, f.sessionId)).toEqual(state.nearbyLocalReceipts!.map(row => row.acknowledgement));
    expect(await f.storage.read()).toEqual(before); expect((await service.readState()).items[0].notes).toBe('later user edit');
    const modified = structuredClone(incoming); modified.records[0].dataJson = modified.records[0].dataJson.replace('Project one', 'Overwritten');
    modified.sourceHash = await service.nearbyLocalSnapshotHash();
    await expect(service.adoptNearbyLocalRecords(modified, f.sessionId)).rejects.toMatchObject({ code: 'adoption-clock-conflict' });
    expect(await f.storage.read()).toEqual(before);
  });

  async function retainedFixture() {
    const item = createLoginItem({ title: 'Purging item', username: 'alice', password: 'synthetic purge password' });
    const f = await fixture([item]);
    await f.service.nearbySessionPreferences(f.sessionId);
    const bytes = new Uint8Array([7, 8, 9]), sha256 = await nearbySha256(bytes);
    await f.service.mutateLocalAttachment({ operationId: crypto.randomUUID(), providerId: f.providerId, itemId: item.id, attachmentId: 'retained-file',
      mode: 'create', attachment: { itemId: item.id, attachmentId: 'retained-file', fileName: 'retained.bin', mediaType: 'application/octet-stream',
        sizeBytes: bytes.length, sha256, dataBase64: bytesToBase64(bytes), protected: true } }, f.sessionId);
    const original = (await f.service.captureNearbyLocalRecords()).records.find(row => row.local_id === `local:${item.id}`)!;
    await f.service.deleteItem(item.id);
    expect(await f.service.emptyLocalTrash()).toMatchObject({ removed: 1, retained: 0 });
    expect((await f.service.readState()).nearbyRetainedLocals).toEqual([`local:${item.id}`]);
    return { f, item, original };
  }

  it('revives a purged item under a new local identity when the peer sends live content for its retired binding', async () => {
    const { f, item, original } = await retainedFixture();
    const data = await nearbyLocalItemToWire({ ...item, notes: 'revived remotely' }, {});
    const record = { id: original.global_id, deleted: false, clockJson: '{"remote":1}', dataJson: JSON.stringify(data),
      localId: original.local_id, scope: original.scope, expectedGuard: original.guard };
    const result = await f.service.adoptNearbyLocalTransaction({ providerId: f.providerId, sourceHash: await f.service.nearbyLocalSnapshotHash(), records: [record], assets: [] }, f.sessionId);
    const revivedId = `nearby-${original.global_id}`;
    expect(result.acknowledgements).toMatchObject([{ recordId: original.global_id, localId: `local:${revivedId}` }]);
    const state = await f.service.readState();
    expect(state.items.map(row => row.id)).toEqual([revivedId]);
    expect(state.items[0]).toMatchObject({ title: item.title, notes: 'revived remotely', password: item.password });
    expect(state.nearbyRetainedLocals).toEqual([]);
    expect(state.localItemAttachments).toEqual([]);
    const saved = await new SecureVaultService(f.storage, f.sessions, Date.now, f.keys).readState();
    expect(saved.items.map(row => row.id)).toEqual([revivedId]);
    expect(saved.nearbyRetainedLocals).toEqual([]);
    const captured = await f.service.captureNearbyLocalRecords();
    expect(captured.retained).toEqual([]);
    expect(captured.records.map(row => row.local_id)).toEqual([`local:${revivedId}`]);
  });

  it('acknowledges a peer deletion of a purged item without reviving it or rewriting local state', async () => {
    const { f, original } = await retainedFixture();
    const before = await f.storage.read(), write = vi.spyOn(f.storage, 'write');
    const dataJson = JSON.stringify({ ...original.data, trashed: true }), sourceHash = await f.service.nearbyLocalSnapshotHash();
    const record = { id: original.global_id, deleted: true, clockJson: '{"remote":2}', dataJson,
      localId: original.local_id, scope: original.scope, expectedGuard: original.guard };
    const result = await f.service.adoptNearbyLocalTransaction({ providerId: f.providerId, sourceHash, records: [record], assets: [] }, f.sessionId);
    expect(write).not.toHaveBeenCalled();
    expect(result.sourceHash).toBe(sourceHash);
    expect(result.acknowledgements).toEqual([{ recordId: original.global_id, clockJson: '{"remote":2}', localId: original.local_id,
      scope: 'local', guard: '0'.repeat(64), dataJson }]);
    expect(await f.storage.read()).toEqual(before);
    const state = await f.service.readState();
    expect(state.items).toEqual([]);
    expect(state.nearbyRetainedLocals).toEqual([original.local_id]);
    expect(state.localItemAttachments).toHaveLength(1);
  });

  it('merges metadata into the existing local Passkey without changing its identity, private bytes or positive counter', async () => {
    const f = await fixture([key]), data = await nearbyLocalItemToWire({ ...key, signCount: 0 }, {});
    const payload = wireObject(data.payload); payload.private_key_alias = ''; payload.key_status = 'reference'; payload.notes = 'incoming metadata';
    const incoming: NearbyLocalBatch = { providerId: f.providerId, sourceHash: await f.service.nearbyLocalSnapshotHash(), assets: [], records: [{ id: 'passkey-record',
      clockJson: '{"peer":1}', dataJson: JSON.stringify(data), deleted: false }] };
    await f.service.adoptNearbyLocalRecords(incoming, f.sessionId);
    expect((await f.service.readState()).items).toMatchObject([{ id: key.id, credentialId: key.credentialId, privateKeyPkcs8: key.privateKeyPkcs8, publicKey: key.publicKey, signCount: 19, signCountHighWaterMark: 19, notes: 'incoming metadata' }]);
    const before = await f.storage.read(); incoming.sourceHash = await f.service.nearbyLocalSnapshotHash(); incoming.records[0].clockJson = '{"peer":2}';
    payload.public_key = 'broken'; incoming.records[0].dataJson = JSON.stringify(data);
    await expect(f.service.adoptNearbyLocalRecords(incoming, f.sessionId)).rejects.toThrow(); expect(await f.storage.read()).toEqual(before);
  });
});
