import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as sourceApi from './native-source';
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
      readNearbyNativeJournal:vi.fn().mockResolvedValue(undefined),stageNearbyNativeIntent:vi.fn(),finishNearbyNativeIntent:vi.fn()};
    const client={hello:vi.fn().mockResolvedValue({supportsContentWrite:true,supportsVaultWriteRevision:true}),request:vi.fn(),readWriteRevision:vi.fn().mockResolvedValue(writeRevision)};
    const adapter=nativeNearbySource({store,client:client as unknown as Mdbx2NativeClient,providerId,replicaStorageId:randomUUID(),sessionId:randomUUID(),epoch:()=>'',assertActive:()=>{},signal:new AbortController().signal,exclusive:work=>work()});
    const row=(await projectNearbyNativeRecords(source)).records.find(row=>row.global_id===folder)!;
    const batch={providerId,sourceHash:source.sourceHash,records:[{id:folder,deleted:true,clockJson:'{"peer":1}',dataJson:JSON.stringify({...row.data,trashed:true}),localId:row.local_id,scope:row.scope,expectedGuard:row.guard}],assets:[]};
    return {adapter,batch,client,store,capture,source};
}
describe('native nearby capability preflight', () => {
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
