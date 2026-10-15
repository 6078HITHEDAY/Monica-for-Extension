import {describe,it,expect,vi} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {readMdbx2ContentProfiles,type Mdbx2ContentProfilesInput} from './content-profiles';
import type {Mdbx2NativeClient} from './native-client';

function fixture(size=300000){
  const handle=randomUUID(),owner={collectionId:randomUUID(),collectionTypeId:'com.monica.passwords',profileSchemaVersion:1,headCommitId:randomUUID(),deleted:false};
  const revision={vaultId:randomUUID(),revisionSha256:'a'.repeat(64)},bytes=Buffer.from(Array.from({length:size},(_,i)=>i%256));
  const info={collectionId:owner.collectionId,collectionTypeId:owner.collectionTypeId,payloadSchemaVersion:owner.profileSchemaVersion,
    allowedObjectTypeIds:['login','passkey'],requiredCapabilityIds:['com.monica.private'],createdAt:'2026-10-15T00:00:00Z',updatedAt:'2026-10-15T00:00:00Z',
    createdByDeviceId:'original-device',updatedByDeviceId:'original-device',headCommitId:owner.headCommitId,deleted:false};
  const input:Mdbx2ContentProfilesInput={writeRevision:{...revision},collections:[owner]};
  const response=(params:Record<string,any>)=>{const end=Math.min(params.offset+params.limit,bytes.length);return {kind:'collection-profile',id:owner.collectionId,metadata:structuredClone(info),
    sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),offset:params.offset,nextOffset:end,done:end===bytes.length,
    dataBase64:bytes.subarray(params.offset,end).toString('base64'),writeRevision:{...revision}};};
  const client={hello:vi.fn(async()=>({supportsContentProfiles:true,supportsVaultWriteRevision:true})),
    request:vi.fn(async(method:string,params:Record<string,any>)=>method==='vault.writeRevision'?{...revision}:response(params))};
  return {client,owner,bytes,input,info,revision,response,read:(signal?:AbortSignal)=>readMdbx2ContentProfiles(client as unknown as Mdbx2NativeClient,handle,input,signal)};
}
describe('native encrypted collection profile disclosure',()=>{
  it.each([0,300000])('retains %i opaque bytes and exact declarations across bounded chunks',async size=>{
    const f=fixture(size),result=await f.read();expect(result.profiles).toEqual([{...f.info,payloadBase64:f.bytes.toString('base64'),sha256:createHash('sha256').update(f.bytes).digest('hex')}]);
    expect(result.writeRevision).toEqual(f.revision);expect(f.client.request).toHaveBeenCalledTimes((size?2:1)+1);
  });
  it('snapshots caller identities before asynchronous capability checks',async()=>{
    const f=fixture();f.client.hello.mockImplementationOnce(async()=>{f.input.collections=[];f.input.writeRevision.revisionSha256='d'.repeat(64);return{supportsContentProfiles:true,supportsVaultWriteRevision:true};});
    expect((await f.read()).profiles).toHaveLength(1);
  });
  it('rejects engines without profile disclosure before requesting any payload',async()=>{
    const f=fixture();f.client.hello.mockResolvedValue({supportsContentProfiles:false,supportsVaultWriteRevision:true});
    await expect(f.read()).rejects.toMatchObject({code:'content-profile-host-update-required'});expect(f.client.request).not.toHaveBeenCalled();
  });
  it.each(['identity','metadata','revision','offset','length','hash','done','base64','unknown','second-metadata','final-revision'])('rejects %s corruption without returning partial profiles',async problem=>{
    const f=fixture();f.client.request.mockImplementation(async(method,params)=>{
      if(method==='vault.writeRevision')return{...f.revision,...(problem==='final-revision'?{revisionSha256:'c'.repeat(64)}:{})};
      const r=f.response(params) as any;
      if(problem==='identity')r.id=randomUUID();if(problem==='metadata')r.metadata.collectionTypeId='wrong';if(problem==='revision')r.writeRevision.revisionSha256='d'.repeat(64);
      if(problem==='offset')r.offset++;if(problem==='length')r.nextOffset--;if(problem==='hash')r.sha256='b'.repeat(64);if(problem==='done')r.done=!r.done;
      if(problem==='base64')r.dataBase64+='\n';if(problem==='unknown')r.extra=true;if(problem==='second-metadata'&&params.offset)r.metadata.requiredCapabilityIds=[];
      return r;
    });await expect(f.read()).rejects.toThrow();
  });
  it('propagates native denial and stops after cancellation of a chunk',async()=>{
    const f=fixture();f.client.request.mockRejectedValueOnce(Error('native policy denied'));await expect(f.read()).rejects.toThrow('native policy denied');
    const abort=new AbortController();f.client.request.mockImplementationOnce(async(_method,params)=>{abort.abort();return f.response(params);});
    await expect(f.read(abort.signal)).rejects.toMatchObject({name:'AbortError'});
  });
  it('rejects duplicate declarations and owners or excessive payload lengths',async()=>{
    const f=fixture();f.info.allowedObjectTypeIds=['login','login'];await expect(f.read()).rejects.toThrow();
    f.input.collections=[f.owner,f.owner];await expect(f.read()).rejects.toThrow();
    const large=fixture(1024*1024+1);await expect(large.read()).rejects.toThrow();
  });
});
