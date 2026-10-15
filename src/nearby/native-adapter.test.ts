import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as sourceApi from './native-source';
import * as adoptionApi from './native-adoption';
import { nativeNearbySource } from './native-adapter';
import { projectNearbyNativeRecords } from './native-records';
import type { Mdbx2NativeClient } from '../providers/mdbx2/native-client';

afterEach(() => vi.restoreAllMocks());

async function fixture() {
    const providerId=randomUUID(),vaultHandle=randomUUID(),rootId=randomUUID(),folder=randomUUID();
    const writeRevision={vaultId:randomUUID(),revisionSha256:'a'.repeat(64)};
    const source:sourceApi.NearbyNativeSource={providerId,vaultHandle,rootId,sourceHash:'b'.repeat(64),writeRevision,
      collections:[rootId,folder].map(collectionId=>({collectionId,title:collectionId===rootId?'.monica-root':'Folder',groupId:collectionId===rootId?undefined:rootId,favorite:false,archived:false,attachmentCount:0,headCommitId:randomUUID(),deleted:false,updatedAt:''})),
      objects:[],attachments:[],metadata:{writeRevision,labels:[],assignments:[],relations:[]}};
    const capture=vi.spyOn(sourceApi,'captureNearbyNativeSource').mockResolvedValue(source);
    const store={getProvider:vi.fn().mockResolvedValue({id:providerId,enabled:true,kind:'mdbx2',config:{vaultHandle}}),
      readNearbyNativeJournal:vi.fn().mockResolvedValue(undefined),stageNearbyNativeIntent:vi.fn(),advanceNearbyNativeIntent:vi.fn(),finishNearbyNativeIntent:vi.fn()};
    const client={hello:vi.fn().mockResolvedValue({supportsContentWrite:true,supportsVaultWriteRevision:true}),request:vi.fn(),readWriteRevision:vi.fn().mockResolvedValue(writeRevision)};
    const adapter=nativeNearbySource({store,client:client as unknown as Mdbx2NativeClient,providerId,replicaStorageId:randomUUID(),sessionId:randomUUID(),epoch:()=>'',assertActive:()=>{},signal:new AbortController().signal,exclusive:work=>work()});
    const row=(await projectNearbyNativeRecords(source)).records.find(row=>row.global_id===folder)!;
    const batch={providerId,sourceHash:source.sourceHash,records:[{id:folder,deleted:true,clockJson:'{"peer":1}',dataJson:JSON.stringify({...row.data,trashed:true}),localId:row.local_id,scope:row.scope,expectedGuard:row.guard}],assets:[]};
    return {adapter,batch,client,store,capture,source};
}
describe('native nearby capability preflight', () => {
  it('checks capabilities required by later steps before persisting any sequence', async () => {
    const f=await fixture(),operationId=randomUUID();
    vi.spyOn(adoptionApi,'planNearbyNativeAdoption').mockResolvedValue({providerId:f.source.providerId,vaultHandle:f.source.vaultHandle,sourceHash:f.source.sourceHash,
      write:{operationId,writeRevision:f.source.writeRevision,plan:{commands:[{kind:'collection-create',collectionId:randomUUID(),title:'Synthetic sequence'}],attachments:[]},assets:[]},
      remainingWrites:[{operationId:randomUUID(),plan:{commands:[{kind:'collection-presentation',collectionId:randomUUID(),favorite:true,archived:false,iconRef:null}],attachments:[]},assets:[]}],bindings:[]});
    await expect(f.adapter.adopt(f.batch)).rejects.toMatchObject({code:'content-write-host-update-required'});
    expect(f.store.stageNearbyNativeIntent).not.toHaveBeenCalled();expect(f.client.request).not.toHaveBeenCalled();
  });
  it('reauthorizes each profile asset read instead of returning captured plaintext',async()=>{
    const f=await fixture(),folder=f.source.collections[1],hash='f'.repeat(64);
    Object.assign(folder,{collectionTypeId:'com.monica.passwords',profileSchemaVersion:1});
    const profile={collectionId:folder.collectionId,collectionTypeId:'com.monica.passwords',payloadSchemaVersion:1,allowedObjectTypeIds:['login'],requiredCapabilityIds:[],
      payloadBase64:'AP+A',sha256:hash,createdAt:'created',updatedAt:'updated',createdByDeviceId:'synthetic',updatedByDeviceId:'synthetic',headCommitId:folder.headCommitId,deleted:false};
    f.source.profiles=[profile];
    const read=vi.fn().mockResolvedValue({writeRevision:f.source.writeRevision,profiles:[profile]});Object.assign(f.client,{readContentProfiles:read});
    const captured=await f.adapter.capture();expect(await captured.readAsset(hash)).toEqual(Uint8Array.of(0,255,128));
    expect(read).toHaveBeenCalledWith(f.source.vaultHandle,{writeRevision:f.source.writeRevision,collections:[{
      collectionId:folder.collectionId,collectionTypeId:'com.monica.passwords',profileSchemaVersion:1,headCommitId:folder.headCommitId,deleted:false}]},expect.any(AbortSignal));
    read.mockRejectedValueOnce(Error('synthetic locked or changed policy'));
    await expect(captured.readAsset(hash)).rejects.toThrow('synthetic locked');expect(read).toHaveBeenCalledTimes(2);
  });
  it('rejects an older engine before persisting folder trash or blocking later synchronization', async () => {
    const {adapter,batch,client,store}=await fixture();
    await expect(adapter.adopt(batch)).rejects.toMatchObject({code:'content-write-host-update-required'});
    expect(store.stageNearbyNativeIntent).not.toHaveBeenCalled();expect(client.request).not.toHaveBeenCalled();
    expect(await adapter.recover()).toEqual([]);
  });
  it('reuses a scanned revision only for planning and always rereads outgoing data',async()=>{
    const f=await fixture();await f.adapter.capture();
    await expect(f.adapter.adopt(f.batch)).rejects.toMatchObject({code:'content-write-host-update-required'});
    expect(f.capture).toHaveBeenCalledTimes(1);expect(f.client.readWriteRevision).toHaveBeenCalledTimes(1);
    await f.adapter.capture();expect(f.capture).toHaveBeenCalledTimes(2);
  });
  it('discards the planning snapshot when the native revision changes before adoption',async()=>{
    const f=await fixture();await f.adapter.capture();
    const revision={...f.source.writeRevision,revisionSha256:'c'.repeat(64)};
    f.client.readWriteRevision.mockResolvedValue(revision);f.capture.mockResolvedValue({...f.source,writeRevision:revision,sourceHash:'d'.repeat(64)});
    await expect(f.adapter.adopt(f.batch)).rejects.toMatchObject({code:'native-source-changed'});
    expect(f.capture).toHaveBeenCalledTimes(2);expect(f.store.stageNearbyNativeIntent).not.toHaveBeenCalled();
  });
});
