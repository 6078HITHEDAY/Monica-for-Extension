import {describe,it,expect} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {createEmptyVaultState} from '../core/model';
import {applyNearbyLocalBatch,captureNearbyLocalSnapshot} from './local-adoption';
import {projectNearbyNativeRecords,requireCompleteNearbyNativeProjection} from './native-records';
import {planNearbyNativeAdoption,clearNearbyNativeAdoption} from './native-adoption';
import {NATIVE_COLLECTION_ARCHIVE,readNearbyCollectionArchive,projectNearbyCollectionArchive} from './native-profiles';
import type {NearbyNativeSource} from './native-source';
import type {NearbyWireData} from './wire-shape';

const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function fixture(size=300_000){
  const root=randomUUID(),folder=randomUUID(),head=randomUUID(),revision={vaultId:randomUUID(),revisionSha256:'a'.repeat(64)},bytes=Buffer.from(Uint8Array.from({length:size},(_,i)=>i%256));
  const source:NearbyNativeSource={rootId:root,providerId:randomUUID(),vaultHandle:randomUUID(),sourceHash:'b'.repeat(64),writeRevision:revision,
    collections:[{collectionId:root,title:'.monica-root',favorite:false,archived:false,attachmentCount:0,headCommitId:head,deleted:false,updatedAt:'now'},
      {collectionId:folder,title:'Work',groupId:root,favorite:true,archived:true,iconRef:'key',collectionTypeId:'com.monica.passwords',profileSchemaVersion:1,attachmentCount:0,headCommitId:head,deleted:false,updatedAt:'now'}],
    profiles:[{collectionId:folder,collectionTypeId:'com.monica.passwords',payloadSchemaVersion:1,allowedObjectTypeIds:['login','passkey'],requiredCapabilityIds:[],
      createdAt:'created',updatedAt:'updated',createdByDeviceId:'source-device',updatedByDeviceId:'source-device',headCommitId:head,deleted:false,payloadBase64:bytes.toString('base64'),sha256:sha(bytes)}],
    metadata:{writeRevision:revision,labels:[],relations:[],assignments:[]},attachments:[],objects:[]};
  const empty=fixtureEmpty();
  const record=async()=>{const p=requireCompleteNearbyNativeProjection(await projectNearbyNativeRecords(source));return p.records.find(row=>row.global_id===folder)!;};
  const batch=async(data?:NearbyWireData)=>({operationId:randomUUID(),sourceHash:empty.sourceHash,records:[{id:folder,deleted:false,clockJson:'{"phone":1}',dataJson:JSON.stringify(data??(await record()).data)}],assets:[{id:sha(bytes),dataBase64:bytes.toString('base64')}]});
  return {root,folder,source,bytes,empty,record,batch};
}
function fixtureEmpty():NearbyNativeSource{
  const rootId=randomUUID(),writeRevision={vaultId:randomUUID(),revisionSha256:'e'.repeat(64)};
  return {rootId,providerId:randomUUID(),vaultHandle:randomUUID(),sourceHash:'d'.repeat(64),writeRevision,
    collections:[{collectionId:rootId,title:'.monica-root',favorite:false,archived:false,attachmentCount:0,headCommitId:randomUUID(),deleted:false,updatedAt:'now'}],
    profiles:[],objects:[],attachments:[],metadata:{writeRevision,labels:[],assignments:[],relations:[]}};
}
describe('portable native collection archives',()=>{
  it('retains an unapplied Android metadata/file archive when opening its native database',async()=>{
    const f=fixture(),data=(await f.record()).data as NearbyWireData,descriptor=(data.assets as Record<string,unknown>[])[0],file=randomUUID();
    f.source.profiles=[];const collection=f.source.collections[1];delete collection.collectionTypeId;delete collection.profileSchemaVersion;
    Object.assign(collection,{favorite:false,archived:false,iconRef:undefined});
    const marker={kind:'monica-device-folder-data-v1',data,device_sync_assets:[{...descriptor,local_id:file}],device_sync_images:{}};
    f.source.metadata.labels.push({labelId:randomUUID(),collectionId:f.folder,name:marker.kind,payloadJson:JSON.stringify(marker),payloadSchemaVersion:1,headCommitId:randomUUID(),deleted:false,updatedAt:'now'});
    f.source.attachments.push({attachmentId:file,collectionId:f.folder,objectId:null,fileName:descriptor.file_name as string,mediaType:descriptor.media_type as string,
      storageMode:'embedded-inline',contentHash:sha(f.bytes),originalSize:f.bytes.length,storedSize:f.bytes.length,chunkCount:1,headCommitId:randomUUID(),deleted:false,updatedAt:'now'});
    const p=requireCompleteNearbyNativeProjection(await projectNearbyNativeRecords(f.source));
    expect(p.records.find(r=>r.global_id===f.folder)!.data).toEqual(data);expect(p.profileAssets).toEqual([]);expect(p.assets[0].attachmentId).toBe(file);
    f.source.metadata.labels[0].payloadJson=JSON.stringify({...marker,device_sync_collection_applied:true});
    await expect(projectNearbyNativeRecords(f.source)).rejects.toThrow('native-profile-source-missing');
  });
  it('preserves unapplied presentation but reflects real local edits after native restoration',async()=>{
    const f=fixture(),data=(await f.record()).data as NearbyWireData;
    (data.payload as any)[NATIVE_COLLECTION_ARCHIVE].profile=null;
    const collection={...f.source.collections[1],favorite:false,archived:false,iconRef:undefined};
    expect(readNearbyCollectionArchive(projectNearbyCollectionArchive(data,collection,undefined))!.presentation.favorite).toBe(true);
    expect(readNearbyCollectionArchive(projectNearbyCollectionArchive(data,collection,undefined,true))!.presentation).toEqual({favorite:false,archived:false,iconRef:null});
  });
  it('requests splitting independent profile records before any write intent',async()=>{
    const f=fixture(16),data=(await f.record()).data as NearbyWireData;
    data.entry_type='vault-metadata';delete (data.payload as any).path;
    const batch=await f.batch(data);batch.records.push({...batch.records[0],id:randomUUID()});
    await expect(planNearbyNativeAdoption(f.empty,batch)).rejects.toMatchObject({code:'native-adoption-limit'});
  });
  it('rejects a profile/file combination above its native batch budget before staging',async()=>{
    const f=fixture(1024*1024),data=(await f.record()).data as NearbyWireData,extra=Buffer.alloc(1,7),extraHash=sha(extra);
    (data.assets as unknown[]).push({id:extraHash,attachment_id:'other',file_name:'other.bin',media_type:'application/octet-stream',size:1});
    const batch=await f.batch(data);batch.assets.push({id:extraHash,dataBase64:extra.toString('base64')});
    await expect(planNearbyNativeAdoption(f.empty,batch)).rejects.toMatchObject({code:'native-adoption-limit'});
  });
  it('projects a full 1MiB profile as a bounded descriptor and a separate native asset',async()=>{
    const f=fixture(1024*1024),p=requireCompleteNearbyNativeProjection(await projectNearbyNativeRecords(f.source)),row=p.records.find(r=>r.global_id===f.folder)!;
    expect(JSON.stringify(row.data).length).toBeLessThan(3000);expect(JSON.stringify(row.data)).not.toContain(f.bytes.toString('base64').slice(0,500));
    expect(readNearbyCollectionArchive(row.data as NearbyWireData)?.profile).toMatchObject({sha256:sha(f.bytes),sizeBytes:1024*1024,createdByDeviceId:'source-device'});
    expect(p.profileAssets).toEqual(f.source.profiles);expect(p.assets).toEqual([]);
  });
  it('preserves exact profiles and descriptor extras through local metadata forwarding and JSON restore',async()=>{
    const f=fixture(),row=await f.record(),data=row.data as NearbyWireData;
    (data.assets as any[])[0].future={keep:'opaque'};
    let state=createEmptyVaultState();const providerId=state.providers.find(p=>p.kind==='local')!.id;
    const local=await captureNearbyLocalSnapshot(state),batch=await f.batch(data);
    state=(await applyNearbyLocalBatch(state,{providerId,sourceHash:local.sourceHash,records:batch.records,assets:batch.assets},'2026-10-15T00:00:00Z')).state;
    const forwarded=await captureNearbyLocalSnapshot(JSON.parse(JSON.stringify(state)));
    expect(forwarded.records.find(r=>r.global_id===f.folder)!.data).toEqual(data);expect(forwarded.assets).toEqual(batch.assets);
    const plan=await planNearbyNativeAdoption(f.empty,{...batch,records:forwarded.records.map(r=>({id:r.global_id,deleted:r.deleted,clockJson:'{"phone":2}',dataJson:JSON.stringify(r.data)})),assets:forwarded.assets});
    expect(plan.write.plan.commands).toContainEqual(expect.objectContaining({kind:'collection-profile-set',collectionId:f.folder,collectionTypeId:'com.monica.passwords'}));
    expect(plan.write.plan.commands).toContainEqual({kind:'collection-presentation',collectionId:f.folder,favorite:true,archived:true,iconRef:'key'});
    expect(plan.write.plan.attachments).toEqual([]);expect(plan.write.assets).toHaveLength(1);expect(sha(plan.write.assets[0].bytes)).toBe(sha(f.bytes));
    const marker=plan.write.plan.commands.find(c=>c.kind==='label-create'&&c.name==='monica-device-folder-data-v1');
    expect(marker?.kind).toBe('label-create');if(marker?.kind!=='label-create')throw Error();
    const saved=JSON.parse(marker.payloadJson);expect(saved.data.assets[0].future).toEqual({keep:'opaque'});expect(saved.device_sync_assets).toEqual([]);
    // Simulate native-generated commit/device timestamps; semantic provenance
    // must still echo the received archive instead of manufacturing a new edit.
    const again=structuredClone(f.source);again.profiles![0].createdByDeviceId='target-device';again.profiles![0].updatedAt='later';again.profiles![0].headCommitId=randomUUID();
    again.metadata.labels.push({labelId:marker.labelId,collectionId:f.folder,name:marker.name,payloadJson:marker.payloadJson,payloadSchemaVersion:1,headCommitId:randomUUID(),deleted:false,updatedAt:'later'});
    expect((await projectNearbyNativeRecords(again)).records.find(r=>r.global_id===f.folder)!.data).toEqual(data);
    clearNearbyNativeAdoption(plan);expect(plan.write.assets[0].bytes.every(byte=>byte===0)).toBe(true);
  });
  it('keeps a foreign root profile as an owned file without changing target root policy or presentation',async()=>{
    const f=fixture(),data=(await f.record()).data as NearbyWireData;data.entry_type='vault-metadata';data.payload={...(data.payload as object),tags:[]};delete (data.payload as any).path;
    const batch=await f.batch(data),plan=await planNearbyNativeAdoption(f.empty,batch);
    expect(plan.write.plan.commands.some(c=>c.kind==='collection-profile-set'||c.kind==='collection-presentation')).toBe(false);
    expect(plan.write.plan.attachments).toEqual([expect.objectContaining({kind:'create',collectionId:f.empty.rootId,objectId:null})]);
    const marker=plan.write.plan.commands.find(c=>c.kind==='label-create'&&c.name==='monica-device-root-tags-v2');if(marker?.kind!=='label-create')throw Error();
    expect(JSON.parse(marker.payloadJson)).toMatchObject({owner:f.folder,data:{payload:{[NATIVE_COLLECTION_ARCHIVE]:readNearbyCollectionArchive(data)}}});
  });
  it.each(['unknown version','unknown profile field','missing asset','wrong digest','wrong size','duplicate asset','capability','clear profile'])('rejects %s before returning a native intent',async failure=>{
    const f=fixture(16),data=(await f.record()).data as NearbyWireData,archive=(data.payload as any)[NATIVE_COLLECTION_ARCHIVE];
    if(failure==='unknown version')archive.version=2;
    if(failure==='unknown profile field')archive.profile.overridePolicy='sky';
    if(failure==='missing asset')data.assets=[];
    if(failure==='wrong digest')(data.assets as any[])[0].id='f'.repeat(64);
    if(failure==='wrong size')(data.assets as any[])[0].size=17;
    if(failure==='duplicate asset')(data.assets as any[]).push(structuredClone((data.assets as any[])[0]));
    if(failure==='capability')archive.profile.requiredCapabilityIds=['com.monica.missing'];
    let batch=await f.batch(data),target=f.empty;
    if(failure==='clear profile'){
      archive.profile=null;data.assets=[];target=f.source;const row=await f.record();
      batch={...batch,sourceHash:target.sourceHash,assets:[],records:[{...batch.records[0],dataJson:JSON.stringify(data),localId:row.local_id,scope:row.scope,expectedGuard:row.guard} as any]};
    }
    await expect(planNearbyNativeAdoption(target,batch)).rejects.toThrow();
  });
  it('does not reactivate profiles requiring unknown capabilities when scanning native sources',async()=>{
    const f=fixture();f.source.profiles![0].requiredCapabilityIds=['com.monica.missing'];
    const projected=await projectNearbyNativeRecords(f.source);expect(projected.blockers).toContainEqual({id:f.folder,reason:'native-profile-capability-archive-required'});
    expect(()=>requireCompleteNearbyNativeProjection(projected)).toThrow();
  });
});
