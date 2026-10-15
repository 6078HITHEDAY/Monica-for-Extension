import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { projectNearbyNativeRecords, requireCompleteNearbyNativeProjection } from './native-records';
import type { NearbyNativeSource } from './native-source';

function fixture() {
  const root = randomUUID(), owner = randomUUID(), id = randomUUID(), assetId = randomUUID();
  const base = { headCommitId: randomUUID(), updatedAt: '2026-10-14T00:00:00Z', deleted: false };
  const summary = { ...base, objectId: id, collectionId: owner, objectTypeId: 'login', title: 'Password', payloadSchemaVersion: 1 };
  const payload = { username: 'alice', password: 'mdbx:must-not-rewrite-password', monica_password_encoding: 'plaintext-v1', custom_fields: [{ title: 'Extra', value: 'Original', is_protected: true }], password_history: [{ password: 'Older' }], device_sync_assets: [{ local_id: assetId, attachment_id: 'original-portable-attachment', image: true }] };
  const source: NearbyNativeSource = { providerId: randomUUID(), vaultHandle: randomUUID(), rootId: root, sourceHash: 'a'.repeat(64), writeRevision: { vaultId: randomUUID(), revisionSha256: 'b'.repeat(64) },
    collections: [root, owner].map(collectionId => ({ ...base, collectionId, title: collectionId === root ? '.monica-root' : 'Work', groupId: collectionId === root ? undefined : root, favorite: false, archived: false, attachmentCount: 0 })),
    objects: [{ summary, record: { ...summary, payloadJson: JSON.stringify(payload).replace('"alice"', '"alice","unknown":9007199254740993') } }],
    metadata: { writeRevision: { vaultId: randomUUID(), revisionSha256: 'b'.repeat(64) }, labels: [], assignments: [], relations: [] },
    attachments: [{ ...base, attachmentId: assetId, collectionId: owner, objectId: id, fileName: 'file.bin', mediaType: null, storageMode: 'embedded-inline', contentHash: 'c'.repeat(64), originalSize: 4, storedSize: 4, chunkCount: 1 }] };
  return { source, id, owner, root, assetId, payload };
}

it('does not silently drop version-one collection profiles with default presentation fields',async()=>{
  const f=fixture();Object.assign(f.source.collections[1],{collectionTypeId:'com.monica.passwords',profileSchemaVersion:1});
  const projection=await projectNearbyNativeRecords(f.source);
  expect(projection.blockers).toContainEqual({id:f.owner,reason:'native-folder-profile-archive-required'});
});

describe('native nearby application projection', () => {
  it('distinguishes retained trash from a proven purge marker', async () => {
    const f = fixture(); f.source.objects[0].summary.deleted = true; f.source.objects[0].record!.deleted = true;
    let result = requireCompleteNearbyNativeProjection(await projectNearbyNativeRecords(f.source));
    expect(result.records.find(row => row.global_id === f.id)).toMatchObject({deleted:true,data:{trashed:true,password_plain:f.payload.password}});
    f.source.objects[0].record!.payloadJson = JSON.stringify({...f.payload,deleted_at:0});
    result = requireCompleteNearbyNativeProjection(await projectNearbyNativeRecords(f.source));
    expect(result.records.find(row => row.global_id === f.id)).toMatchObject({deleted:true,data:{}});
  });
  it('maps expanded passwords, history, folders, precise values and attachment identity', async () => {
    const f = fixture(), result = requireCompleteNearbyNativeProjection(await projectNearbyNativeRecords(f.source));
    const row = result.records.find(row => row.global_id === f.id)!;
    expect(row.data).toMatchObject({ username: 'alice', password_plain: 'mdbx:must-not-rewrite-password', custom_fields: [{ title: 'Extra', is_protected: true }], password_history: [{ password: 'Older' }], folder: 'Work',
      assets: [{ id: 'c'.repeat(64), attachment_id: 'original-portable-attachment', image: true, size: 4 }] });
    expect(JSON.stringify(row.data)).toContain('9007199254740993'); expect(result.assets).toEqual(f.source.attachments);
  });
  it.each([0, 19])('preserves portable Passkey key material, counter %i and a verified matching public key', async counter => {
    const f = fixture(), key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), privateKey = key.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), publicKey = key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    f.source.objects[0].summary.objectTypeId = 'passkey'; f.source.objects[0].record!.objectTypeId = 'passkey';
    f.source.objects[0].record!.payloadJson = JSON.stringify({ credential_id: 'AQIDBA', rp_id: 'example.test', user_id: 'dXNlcg', public_key: publicKey, public_key_algorithm: -7, private_key_alias: privateKey, key_status: 'portable', sign_count: counter });
    const result = requireCompleteNearbyNativeProjection(await projectNearbyNativeRecords(f.source));
    expect(result.records.find(row => row.global_id === f.id)?.data).toMatchObject({ entry_type: 'passkey', payload: { private_key_alias: privateKey, credential_id: 'AQIDBA', sign_count: counter } });
  });
  it('remaps only declared image slots and preserves pending relations verbatim', async () => {
    const f = fixture(); f.source.objects[0].record!.payloadJson = JSON.stringify({ ...f.payload, custom_icon_type: 'UPLOADED', custom_icon_value: `mdbx:${f.assetId}`, device_sync_pending_relations: [{ target: 'portable-target', kind: 'com.monica.reference', payload: '{"unknown":9007199254740993}', version: 7 }] });
    const result = requireCompleteNearbyNativeProjection(await projectNearbyNativeRecords(f.source));
    expect(result.records.find(row => row.global_id === f.id)?.data).toMatchObject({ password_plain: f.payload.password, extensions: { custom_icon_value: `device-asset:${'c'.repeat(64)}` }, relations: [{ target: 'portable-target', version: 7 }] });
  });
  it.each(['bitwarden_mode', 'keepass_mode', 'device_sync_staging'])('records explicit %s exclusions without adopting the connector account', async key => {
    const f = fixture(); f.source.objects[0].record!.payloadJson = JSON.stringify({ ...f.payload, [key]: true });
    const result = await projectNearbyNativeRecords(f.source); expect(result.excluded).toEqual([{ id: f.id, reason: key === 'device_sync_staging' ? 'staging' : 'connector-owned' }]);
    expect(result.records.some(row => row.global_id === f.id)).toBe(false);
  });
  it.each(['folder','root'])('projects %s attachments and unassigned labels with their actual ownership',async owner=>{
    const f=fixture(),id=owner==='root'?f.root:f.owner;
    f.source.attachments[0].objectId=null;f.source.attachments[0].collectionId=id;
    f.source.metadata.labels.push({labelId:randomUUID(),collectionId:id,name:'Standalone',payloadSchemaVersion:3,payloadJson:'{"big":9007199254740993}',deleted:false,headCommitId:randomUUID(),updatedAt:''});
    const projection=requireCompleteNearbyNativeProjection(await projectNearbyNativeRecords(f.source));
    expect(projection.records.find(row=>row.global_id===id)?.data).toMatchObject({labels:[{name:'Standalone',payload:'{"big":9007199254740993}',version:3}],assets:[{id:'c'.repeat(64),attachment_id:f.assetId}]});
  });
  it.each(['deleted', 'schema', 'type', 'orphan-asset', 'folder-profile', 'unavailable-image', 'unavailable-icon'])('never authorizes an incomplete %s scan', async problem => {
    const f = fixture();
    if (problem === 'deleted') { f.source.objects[0].record = null; f.source.objects[0].summary.deleted = true; }
    if (problem === 'schema') f.source.objects[0].record!.payloadSchemaVersion = 9;
    if (problem === 'type') f.source.objects[0].record!.objectTypeId = 'unknown';
    if (problem === 'orphan-asset') f.source.attachments[0].objectId = randomUUID();
    if (problem === 'folder-profile') f.source.collections[1].favorite = true;
    if (problem === 'unavailable-image') f.source.objects[0].record!.payloadJson = JSON.stringify({ ...f.payload, custom_icon_value: 'content://unavailable-image' });
    if (problem === 'unavailable-icon') f.source.objects[0].record!.payloadJson = JSON.stringify({ ...f.payload, custom_icon_type: 'UPLOADED', custom_icon_value: 'android-internal-icon.png' });
    const result = await projectNearbyNativeRecords(f.source); expect(result.blockers.length).toBeGreaterThan(0); expect(() => requireCompleteNearbyNativeProjection(result)).toThrow('native-projection-incomplete');
  });
  it('does not mutate the source while deriving a snapshot', async () => {
    const f = fixture(), before = JSON.stringify(f.source); await projectNearbyNativeRecords(f.source); expect(JSON.stringify(f.source)).toBe(before);
  });
  it('uses current content length after native replacement retains the original creation size', async () => {
    const f = fixture(); f.source.attachments[0].originalSize = 900;
    const projection = requireCompleteNearbyNativeProjection(await projectNearbyNativeRecords(f.source));
    expect(projection.records.find(row => row.global_id === f.id)?.data).toMatchObject({ assets: [{ size: 4 }] });
    expect(projection.assets[0]).toMatchObject({ originalSize: 900, storedSize: 4 });
  });
});
