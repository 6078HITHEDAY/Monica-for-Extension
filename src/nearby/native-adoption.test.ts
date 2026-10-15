import { describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { normalizeNearbyNativeData, type NearbyWireData } from './wire-shape';
import { projectNearbyNativeRecords } from './native-records';
import { clearNearbyNativeAdoption, planNearbyNativeAdoption, type NearbyNativeBatch } from './native-adoption';
import type { NearbyNativeSource } from './native-source';
import type { NearbyIncomingRecord } from './local-adoption';
import { nearbyNativeObjectToWire } from './application-codec';
import { parseLosslessJson } from '../core/lossless-json';
import { nearbyJavaNameUuid } from './native-source';

function fixture() {
  const root = randomUUID(), folder = randomUUID(), other = randomUUID(), id = randomUUID();
  const base = { headCommitId: randomUUID(), updatedAt: '2026-10-14', deleted: false };
  const summary = { ...base, objectId: id, collectionId: folder, objectTypeId: 'note', title: 'Existing', payloadSchemaVersion: 1 };
  const revision = { vaultId: randomUUID(), revisionSha256: 'a'.repeat(64) };
  const source: NearbyNativeSource = { providerId: randomUUID(), vaultHandle: randomUUID(), rootId: root, sourceHash: 'b'.repeat(64), writeRevision: revision,
    collections: [root, folder, other].map(collectionId => ({ ...base, collectionId, title: collectionId === root ? '.monica-root' : collectionId === folder ? 'Folder' : 'Other', groupId: collectionId === root ? undefined : root, favorite: false, archived: false, attachmentCount: 0 })),
    objects: [{ summary, record: { ...summary, payloadJson: '{"item_data":"Existing text"}' } }],
    metadata: { writeRevision: revision, labels: [], assignments: [], relations: [] }, attachments: [] };
  const note = (title = 'Incoming'): NearbyWireData => ({ title, folder: '', entry_type: 'note', payload: { item_data: 'Original text' }, labels: [], relations: [], assets: [] });
  const incoming = (data: NearbyWireData, recordId: string = randomUUID()): NearbyIncomingRecord => ({ id: recordId, clockJson: '{"device":1}', dataJson: JSON.stringify(data), deleted: false });
  const bound = async (data: NearbyWireData, recordId = id) => {
    const row = (await projectNearbyNativeRecords(source)).records.find(row => row.global_id === id)!;
    return { ...incoming(data, recordId), localId: row.local_id, scope: row.scope, expectedGuard: row.guard };
  };
  const batch = (records: NearbyIncomingRecord[]): NearbyNativeBatch => ({ operationId: randomUUID(), sourceHash: source.sourceHash, records, assets: [] });
  const file = (bytes = Buffer.from('synthetic file')) => {
    const hash = createHash('sha256').update(bytes).digest('hex');
    return { bytes, descriptor: { id: hash, attachment_id: 'portable-file', file_name: 'old.bin', media_type: 'application/octet-stream', size: bytes.length, future: 'retained' }, supplied: { id: hash, dataBase64: bytes.toString('base64') } };
  };
  return { source, root, folder, other, id, note, incoming, bound, batch, file, base };
}

describe('atomic native nearby adoption', () => {
  it('plans retained folder trash without deleting its attachments',async()=>{
    const f=fixture(),file=f.file();f.source.attachments.push({...f.base,attachmentId:randomUUID(),collectionId:f.other,objectId:null,fileName:'file.bin',mediaType:'application/octet-stream',storageMode:'embedded-inline',contentHash:file.descriptor.id,originalSize:file.bytes.length,storedSize:file.bytes.length,chunkCount:1});
    const row=(await projectNearbyNativeRecords(f.source)).records.find(row=>row.global_id===f.other)!;
    const result=await planNearbyNativeAdoption(f.source,f.batch([{id:f.other,deleted:true,clockJson:'{"peer":1}',dataJson:JSON.stringify({...row.data,trashed:true}),localId:row.local_id,scope:row.scope,expectedGuard:row.guard}]));
    expect(result.write.plan.commands).toContainEqual({kind:'collection-trash',collectionId:f.other});
    expect(result.write.plan.attachments).toEqual([]);
  });
  it('rejects folder trash with active members before staging',async()=>{
    const f=fixture(),row=(await projectNearbyNativeRecords(f.source)).records.find(row=>row.global_id===f.folder)!;
    await expect(planNearbyNativeAdoption(f.source,f.batch([{id:f.folder,deleted:true,clockJson:'{"peer":1}',dataJson:JSON.stringify({...row.data,trashed:true}),localId:row.local_id,scope:row.scope,expectedGuard:row.guard}]))).rejects.toMatchObject({code:'native-folder-active-members'});
  });
  it('trashes nested folders child-first without dropping attachments or metadata',async()=>{
    const f=fixture();f.source.collections.find(row=>row.collectionId===f.other)!.groupId=f.folder;
    f.source.objects=[];
    const projection=await projectNearbyNativeRecords(f.source);
    const records=[f.folder,f.other].map(id=>{const row=projection.records.find(row=>row.global_id===id)!;return{id,deleted:true,clockJson:'{"peer":1}',dataJson:JSON.stringify({...row.data,trashed:true}),localId:row.local_id,scope:row.scope,expectedGuard:row.guard};});
    const result=await planNearbyNativeAdoption(f.source,f.batch(records));
    expect(result.write.plan.commands.filter(c=>c.kind==='collection-trash').map(c=>c.collectionId)).toEqual([f.other,f.folder]);
  });
  it('rejects restoring a child while its parent remains deleted before staging',async()=>{
    const f=fixture();f.source.objects=[];
    f.source.collections.find(row=>row.collectionId===f.other)!.groupId=f.folder;
    for(const row of f.source.collections)if(row.collectionId!==f.root)row.deleted=true;
    const row=(await projectNearbyNativeRecords(f.source)).records.find(row=>row.global_id===f.other)!;
    const restore={id:f.other,deleted:false,clockJson:'{"peer":2}',dataJson:JSON.stringify({...row.data,trashed:false}),localId:row.local_id,scope:row.scope,expectedGuard:row.guard};
    await expect(planNearbyNativeAdoption(f.source,f.batch([restore]))).rejects.toMatchObject({code:'native-folder-deleted'});
  });
  it('restores a nested family parent-first regardless of incoming record order',async()=>{
    const f=fixture();f.source.objects=[];
    f.source.collections.find(row=>row.collectionId===f.other)!.groupId=f.folder;
    for(const row of f.source.collections)if(row.collectionId!==f.root)row.deleted=true;
    const projection=await projectNearbyNativeRecords(f.source);
    const records=[f.other,f.folder].map(id=>{const row=projection.records.find(row=>row.global_id===id)!;return{id,deleted:false,clockJson:'{"peer":2}',dataJson:JSON.stringify({...row.data,trashed:false}),localId:row.local_id,scope:row.scope,expectedGuard:row.guard};});
    const plan=await planNearbyNativeAdoption(f.source,f.batch(records));
    expect(plan.write.plan.commands.flatMap(c=>c.kind==='collection-restore'?[c.collectionId]:[])).toEqual([f.folder,f.other]);
  });
  it.each(['folder', 'vault-metadata', 'note'] as const)('rejects duplicate portable attachment IDs in %s before returning an intent', async type => {
    const f=fixture(),id=randomUUID(),file=f.file();
    const data:NearbyWireData={title:'Incoming',folder:'',entry_type:type,payload:type==='folder'?{path:[{id,title:'Incoming',parent:null}],tags:[]}:type==='vault-metadata'?{tags:[]}:{item_data:'Note'},assets:[file.descriptor,{...file.descriptor,file_name:'different.bin'}]};
    const batch=f.batch([f.incoming(data,id)]);batch.assets=[file.supplied];
    await expect(planNearbyNativeAdoption(f.source,batch)).rejects.toMatchObject({code:'native-asset-identity'});
  });
  it.each(['folder', 'vault-metadata', 'note'] as const)('validates %s label JSON and refuses internal ownership markers', async type => {
    const f=fixture(),id=randomUUID();
    for(const payload of ['not JSON',JSON.stringify({kind:'monica-device-root-tags-v2',owner:f.root,deleted:true,data:{},tag_ids:[]})]){
      const data:NearbyWireData={title:'Incoming',folder:'',entry_type:type,payload:type==='folder'?{path:[{id,title:'Incoming',parent:null}],tags:[]}:type==='vault-metadata'?{tags:[]}:{item_data:'Note'},labels:[{name:'Untrusted',payload,version:1}]};
      await expect(planNearbyNativeAdoption(f.source,f.batch([f.incoming(data,id)]))).rejects.toMatchObject({code:payload==='not JSON'?'native-label-json':'native-reserved-label-kind'});
    }
  });
  it.each(['folder','vault-metadata','note'] as const)('rejects zero native label schema in %s before an intent can be staged',async type=>{
    const f=fixture(),id=randomUUID(),data:NearbyWireData={title:'Incoming',folder:'',entry_type:type,payload:type==='folder'?{path:[{id,title:'Incoming',parent:null}],tags:[]}:type==='vault-metadata'?{tags:[]}:{item_data:'Note'},labels:[{name:'Invalid version',payload:'{}',version:0}]};
    await expect(planNearbyNativeAdoption(f.source,f.batch([f.incoming(data,id)]))).rejects.toMatchObject({code:'native-payload-version'});
  });
  it('adopts two root owners with identical attachment content without sharing mutable file identities',async()=>{
    const f=fixture(),a=randomUUID(),b=randomUUID(),file=f.file();
    const rootData={title:'Root',folder:'',entry_type:'vault-metadata' as const,payload:{tags:[]},assets:[file.descriptor],labels:[{name:'Own label',payload:'{"exact":9007199254740993}',version:4}]};
    const batch=f.batch([f.incoming(rootData,a),f.incoming(rootData,b)]);batch.assets=[file.supplied];
    const plan=await planNearbyNativeAdoption(f.source,batch),creates=plan.write.plan.attachments.filter(row=>row.kind==='create');
    expect(creates).toHaveLength(2);expect(new Set(creates.map(row=>row.attachmentId)).size).toBe(2);
    expect(creates.every(row=>row.kind==='create'&&row.objectId===null&&row.collectionId===f.root)).toBe(true);
    const markers=plan.write.plan.commands.filter(row=>row.kind==='label-create'&&row.name==='monica-device-root-tags-v2');
    expect(markers).toHaveLength(2);
    for(const marker of markers){if(marker.kind!=='label-create')throw Error();const payload=JSON.parse(marker.payloadJson);expect(payload.device_sync_assets).toHaveLength(1);expect(payload.label_ids).toHaveLength(1);}
    expect(plan.write.assets).toHaveLength(1);
  });
  it('restores a disclosed trashed item atomically before applying an incoming restoration', async () => {
    const f = fixture(); f.source.objects[0].summary.deleted = true; f.source.objects[0].record!.deleted = true;
    const incoming = await f.bound(f.note()), result = await planNearbyNativeAdoption(f.source, f.batch([incoming]));
    const commands = result.write.plan.commands;
    expect(commands.findIndex(c=>c.kind==='object-restore')).toBeLessThan(commands.findIndex(c=>c.kind==='object-update'));
    expect(commands.some(c=>c.kind==='object-delete')).toBe(false);
  });
  it('creates a complete project with precise passwords, references, labels and verified attachment bytes', async () => {
    const f = fixture(), noteId = randomUUID(), loginId = randomUUID(), folderId = randomUUID(), file = f.file();
    const note = f.note(), login = normalizeNearbyNativeData({ password: 'mdbx:literal-password', username: 'alice', password_history: [{ password: 'Before' }], custom_fields: [{ title: 'Extra', value: 'secret', is_protected: true }], bound_note_entry_id: noteId }, 'Password', 'Project', 'login');
    login.folder_path = [{ id: folderId, title: 'Project', parent: null }]; login.labels = [{ name: 'Extra metadata', payload: '{"big":9007199254740993}', version: 7 }];
    login.relations = [{ target: noteId, kind: 'com.monica.reference', payload: '{"n":9007199254740993}', version: 3 }]; login.assets = [file.descriptor];
    const batch = f.batch([f.incoming(login, loginId), f.incoming(note, noteId)]); batch.assets = [file.supplied];
    const result = await planNearbyNativeAdoption(f.source, batch), commands = result.write.plan.commands;
    const created = commands.find(row => row.kind === 'object-create' && row.objectId === loginId);
    expect(created).toMatchObject({ collectionId: folderId });
    if (created?.kind !== 'object-create') throw Error('Missing password');
    expect(JSON.parse(created.payloadJson)).toMatchObject({ password_plain: 'mdbx:literal-password', bound_note_entry_id: noteId, password_history: [{ password: 'Before' }], custom_fields: [{ title: 'Extra', is_protected: true }] });
    expect(commands.some(row => row.kind === 'label-create' && row.payloadJson === '{"big":9007199254740993}')).toBe(true);
    expect(commands.findIndex(row => row.kind === 'relation-create')).toBeGreaterThan(commands.findIndex(row => row.kind === 'object-create' && row.objectId === noteId));
    expect(result.write.assets[0].bytes).toEqual(new Uint8Array(file.bytes));
    expect(await planNearbyNativeAdoption(f.source, batch)).toEqual(result);
    clearNearbyNativeAdoption(result); expect(result.write.assets[0].bytes.every(byte => byte === 0)).toBe(true); expect(file.bytes.some(byte => byte !== 0)).toBe(true);
  });
  it.each([0, 19])('retains an existing portable Passkey and counter %i when receiving its reference-only form', async counter => {
    const f = fixture(), pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const old = { credential_id: 'AQIDBA==', rp_id: 'example.test', user_id: 'dXNlcg==', public_key: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), public_key_algorithm: -7,
      private_key_alias: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), key_status: 'portable', sign_count: counter };
    f.source.objects[0].summary.objectTypeId = 'passkey'; f.source.objects[0].record = { ...f.source.objects[0].summary, payloadJson: JSON.stringify(old) };
    const data: NearbyWireData = { title: 'New title', folder: '', entry_type: 'passkey', payload: { ...old, credential_id: 'AQIDBA', user_id: 'dXNlcg', key_status: 'reference', private_key_alias: '', sign_count: 0 } };
    const result = await planNearbyNativeAdoption(f.source, f.batch([await f.bound(data)]));
    const update = result.write.plan.commands.find(row => row.kind === 'object-update'); if (update?.kind !== 'object-update') throw Error('Missing Passkey');
    expect(JSON.parse(update.payloadJson)).toMatchObject(old);
  });
  it('moves and replaces an existing asset while retaining its portable identity and original source', async () => {
    const f = fixture(), old = f.file(), next = f.file(Buffer.from('replacement file')), fileId = randomUUID();
    f.source.attachments.push({ ...f.base, attachmentId: fileId, collectionId: f.folder, objectId: f.id, fileName: old.descriptor.file_name, mediaType: old.descriptor.media_type, storageMode: 'embedded-inline', contentHash: old.descriptor.id, originalSize: old.bytes.length, storedSize: old.bytes.length, chunkCount: 1 });
    f.source.objects[0].record!.payloadJson = JSON.stringify({ item_data: '{"imagePath":"mdbx:' + fileId + '"}', device_sync_assets: [{ ...old.descriptor, local_id: fileId }] });
    const data = f.note('Moved'); data.folder = 'Other'; data.folder_path = [{ id: f.other, title: 'Other', parent: null }]; data.assets = [{ ...next.descriptor, file_name: 'renamed.bin', image: true }]; data.payload = { item_data: JSON.stringify({ imagePath: `device-asset:${next.descriptor.id}` }) };
    const batch = f.batch([await f.bound(data)]); batch.assets = [next.supplied]; const before = JSON.stringify(f.source);
    const result = await planNearbyNativeAdoption(f.source, batch);
    expect(result.write.plan.commands).toContainEqual({ kind: 'object-move', objectId: f.id, collectionId: f.folder, targetCollectionId: f.other });
    expect(result.write.plan.attachments).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'replace', attachmentId: fileId }), expect.objectContaining({ kind: 'rename', attachmentId: fileId, fileName: 'renamed.bin' })]));
    expect(result.write.plan.attachments.some(row => row.kind === 'delete' || row.kind === 'create')).toBe(false);
    const update = result.write.plan.commands.find(row => row.kind === 'object-update'); if (update?.kind !== 'object-update') throw Error('Missing update');
    expect(JSON.parse(update.payloadJson)).toMatchObject({ item_data: JSON.stringify({ imagePath: `mdbx:${fileId}` }), device_sync_assets: [{ attachment_id: 'portable-file', local_id: fileId, future: 'retained' }] });
    expect(JSON.stringify(f.source)).toBe(before);
  });
  it('keeps shared labels and unrelated assignments when replacing one object metadata', async () => {
    const f = fixture(), labelId = randomUUID(), otherId = randomUUID(), assignmentId = randomUUID();
    f.source.metadata.labels.push({ ...f.base, labelId, collectionId: f.folder, name: 'Shared', payloadJson: '{"shared":true}', payloadSchemaVersion: 1 });
    f.source.metadata.assignments.push({ ...f.base, assignmentId, objectId: f.id, labelId }, { ...f.base, assignmentId: randomUUID(), objectId: otherId, labelId });
    const result = await planNearbyNativeAdoption(f.source, f.batch([await f.bound(f.note())]));
    expect(result.write.plan.commands).toContainEqual({ kind: 'label-unassign', assignmentId });
    expect(result.write.plan.commands.some(row => row.kind === 'label-delete')).toBe(false);
    expect(result.write.plan.commands.filter(row => row.kind === 'label-unassign')).toHaveLength(1);
  });
  it('preserves omitted labels through a move and removes only their obsolete private copies', async () => {
    const f = fixture(), labelId = randomUUID(), assignmentId = randomUUID();
    f.source.metadata.labels.push({ ...f.base, labelId, collectionId: f.folder, name: 'Private', payloadJson: '{"large":9007199254740993}', payloadSchemaVersion: 7 });
    f.source.metadata.assignments.push({ ...f.base, assignmentId, objectId: f.id, labelId });
    const data = f.note(); delete data.labels; data.folder = 'Other'; data.folder_path = [{ id: f.other, title: 'Other', parent: null }];
    const result = await planNearbyNativeAdoption(f.source, f.batch([await f.bound(data)])), commands = result.write.plan.commands;
    expect(commands).toContainEqual(expect.objectContaining({ kind: 'label-create', collectionId: f.other, name: 'Private', payloadJson: '{"large":9007199254740993}', payloadSchemaVersion: 7 }));
    expect(commands).toContainEqual({ kind: 'label-unassign', assignmentId }); expect(commands).toContainEqual({ kind: 'label-delete', labelId });
  });
  it('preserves unchanged native attachment identity when the incoming record omits assets', async () => {
    const f = fixture(), file = f.file(), fileId = randomUUID();
    f.source.attachments.push({ ...f.base, attachmentId: fileId, collectionId: f.folder, objectId: f.id, fileName: file.descriptor.file_name, mediaType: file.descriptor.media_type, storageMode: 'embedded-inline', contentHash: file.descriptor.id, originalSize: 999, storedSize: file.bytes.length, chunkCount: 1 });
    const stored = [{ ...file.descriptor, local_id: fileId }]; f.source.objects[0].record!.payloadJson = JSON.stringify({ item_data: 'Existing', device_sync_assets: stored });
    const data = f.note(); delete data.assets; data.payload = { item_data: JSON.stringify({ imagePath: `device-asset:${file.descriptor.id}` }) };
    const result = await planNearbyNativeAdoption(f.source, f.batch([await f.bound(data)]));
    expect(result.write.assets).toEqual([]); expect(result.write.plan.attachments).toEqual([]);
    const update = result.write.plan.commands.find(row => row.kind === 'object-update'); if (update?.kind !== 'object-update') throw Error('Missing update');
    expect(JSON.parse(update.payloadJson)).toMatchObject({ device_sync_assets: stored, item_data: JSON.stringify({ imagePath: `mdbx:${fileId}` }) });
  });
  it('preserves unknown top-level wire fields without replacing known fields or rounding numbers', async () => {
    const f=fixture(),data=f.note();data.future=parseLosslessJson('{"big":9007199254740993,"decimal":1.00000000000000001}');
    const plan=await planNearbyNativeAdoption(f.source,f.batch([await f.bound(data)]));
    const update=plan.write.plan.commands.find(row=>row.kind==='object-update');if(update?.kind!=='object-update')throw Error('No update');
    const projected=await nearbyNativeObjectToWire({...f.source.objects[0].record!,payloadJson:update.payloadJson},{folder:''});
    expect(JSON.stringify(projected.future)).toBe('{"big":9007199254740993,"decimal":1.00000000000000001}');
    expect(projected.payload).not.toHaveProperty('device_sync_wire_extras');
  });
  it('persists a first-sync purge using root metadata and consumes it when the actual content arrives', async()=>{
    const f=fixture(),id=randomUUID(),record={id,deleted:true,dataJson:'{}',clockJson:'{"peer":1}'};
    const plan=await planNearbyNativeAdoption(f.source,f.batch([record]));
    const created=plan.write.plan.commands.find(row=>row.kind==='label-create');if(created?.kind!=='label-create')throw Error('No purge marker');
    expect(JSON.parse(created.payloadJson)).toMatchObject({owner:id,deleted:true,data:{},tag_ids:[]});
    expect(plan.write.plan.commands.some(row=>row.kind==='object-create')).toBe(false);
    f.source.metadata.labels.push({...f.base,labelId:created.labelId,collectionId:created.collectionId,name:created.name,payloadJson:created.payloadJson,payloadSchemaVersion:created.payloadSchemaVersion});
    const row=(await projectNearbyNativeRecords(f.source)).records.find(row=>row.global_id===id)!;expect(row.data).toEqual({});
    const data=normalizeNearbyNativeData({password:'restored-secret'},'Restored','','login');
    const restore=await planNearbyNativeAdoption(f.source,f.batch([{...f.incoming(data,id),localId:row.local_id,scope:row.scope,expectedGuard:row.guard}]));
    expect(restore.write.plan.commands).toContainEqual({kind:'label-delete',labelId:created.labelId});
    expect(restore.write.plan.commands.find(row=>row.kind==='object-create')).toMatchObject({objectTypeId:'login',objectId:id});
  });
  it('routes legacy title-only folders using the same deterministic identity as Android',async()=>{
    const f=fixture(),data=f.note();data.folder='Legacy folder';
    const plan=await planNearbyNativeAdoption(f.source,f.batch([f.incoming(data)]));
    expect(plan.write.plan.commands).toContainEqual({kind:'collection-create',collectionId:await nearbyJavaNameUuid(`device-folder:${f.root}:Legacy folder`),title:'Legacy folder',parentId:f.root});
  });
  it.each(['guard', 'scope', 'source', 'identity', 'reference', 'asset-hash', 'asset-size', 'type', 'clock'])('refuses %s before returning a writable plan', async problem => {
    const f = fixture(), data = f.note(), record: NearbyIncomingRecord = await f.bound(data), batch = f.batch([record]);
    if (problem === 'guard') record.expectedGuard = 'f'.repeat(64);
    if (problem === 'scope') record.scope = 'local';
    if (problem === 'source') batch.sourceHash = 'f'.repeat(64);
    if (problem === 'identity') { delete record.localId; delete record.scope; delete record.expectedGuard; }
    if (problem === 'reference') data.relations = [{ target: randomUUID(), kind: 'com.monica.reference', payload: '{}', version: 1 }];
    if (problem === 'asset-hash' || problem === 'asset-size') { const file = f.file(); data.assets = [{ ...file.descriptor, ...(problem === 'asset-size' ? { size: 999 } : {}) }]; batch.assets = [{ ...file.supplied, dataBase64: problem === 'asset-hash' ? Buffer.alloc(file.bytes.length).toString('base64') : file.supplied.dataBase64 }]; }
    if (problem === 'type') { data.entry_type = 'steam-mafile'; data.payload = { mafile_json: '{}' }; }
    if (problem === 'clock') record.clockJson = '{}';
    record.dataJson = JSON.stringify(data); await expect(planNearbyNativeAdoption(f.source, batch)).rejects.toThrow();
  });
  it('cancels without changing source data', async () => {
    const f = fixture(), abort = new AbortController(); abort.abort();
    await expect(planNearbyNativeAdoption(f.source, f.batch([f.incoming(f.note())]), abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('cannot overwrite an undisclosed deleted native payload', async () => {
    const f = fixture(), record = await f.bound(f.note()); f.source.objects[0].record = null; f.source.objects[0].summary.deleted = true;
    await expect(planNearbyNativeAdoption(f.source, f.batch([record]))).rejects.toThrow();
  });
  it('keeps retained trash content distinct from a purge', async () => {
    const f = fixture(), data = f.note(); data.trashed = true; const record = f.incoming(data); record.deleted = true;
    const result = await planNearbyNativeAdoption(f.source, f.batch([record]));
    const create = result.write.plan.commands.find(row => row.kind === 'object-create'); if (create?.kind !== 'object-create') throw Error('Missing trash content');
    expect(JSON.parse(create.payloadJson).item_data).toBe('Original text'); expect(result.write.plan.commands).toContainEqual({ kind: 'object-delete', objectId: record.id, collectionId: f.root });
  });
});
