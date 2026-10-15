import {test,expect,type BrowserContext} from '@playwright/test';
import {build} from 'esbuild';
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {launchEdgeContext} from './fixtures/edge';
import type {NearbyNativeSource} from '../../src/nearby/native-source';

test('bundled engine reads and atomically writes opaque profiles across encrypted import and browser restart',async({},info)=>{
  test.skip(process.platform!=='win32','Installed Edge and native fixture');test.setTimeout(180000);
  const run=path.resolve(info.outputPath('isolated')),extension=path.join(run,'extension'),fixture=path.join(run,'native');
  await mkdir(extension,{recursive:true});
  const seed=await promisify(execFile)('cargo',['test','--locked','--manifest-path','native/mdbx2-host/Cargo.toml','runtime::tests::content_profile_preserves_opaque_bytes_revision_and_restart','--','--exact'],
    {cwd:path.resolve('.'),env:{...process.env,MONICA_PROFILE_FIXTURE_DIR:fixture},windowsHide:true,maxBuffer:1024*1024});
  await writeFile(path.join(run,'native-fixture.log'),seed.stdout+seed.stderr);
  const expected=JSON.parse(await readFile(path.join(fixture,'expected.json'),'utf8')),bytes=await readFile(path.join(fixture,'native-profile.mdbx'));
  await writeFile(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Synthetic native profiles',version:'1.0.0',
    background:{service_worker:'background.js'},content_security_policy:{extension_pages:"script-src 'self' 'wasm-unsafe-eval'; object-src 'none'"}}));
  await writeFile(path.join(extension,'background.js'),'chrome.runtime.onInstalled.addListener(()=>{});');
  await writeFile(path.join(extension,'index.html'),'<script src="harness.js"></script>');
  await writeFile(path.join(extension,'harness.js'),`const worker=new Worker('./worker.js',{type:'module'}),pending=new Map();worker.onmessage=({data})=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.error?p.reject(Error(data.error.code)):p.resolve(data.result);};window.probe=(op,data)=>new Promise((resolve,reject)=>{const id=crypto.randomUUID();pending.set(id,{resolve,reject});worker.postMessage({id,op,data});});`);
  for(const name of ['engine.js','monica_mdbx2_browser.wasm'])await copyFile(path.resolve('native/mdbx2-browser/pkg',name),path.join(extension,name));
  await build({entryPoints:['tests/e2e/fixtures/mdbx-browser-worker.ts'],outfile:path.join(extension,'worker.js'),bundle:true,format:'esm',target:'chrome130',external:['./engine.js'],alias:{crypto:path.resolve('scripts/stubs/node-crypto.js')}});
  let context:BrowserContext|undefined;const evidence:Record<string,unknown>={status:'failed',androidApplicationAcceptance:false,profileAdoption:false};
  try{
    const launch=async()=>{
      context=await launchEdgeContext(path.join(run,'profile'),{args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});evidence.edgeVersion=context.browser()?.version();
      const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
      return(op:string,data?:unknown):Promise<any>=>page.evaluate(({op,data})=>(window as any).probe(op,data),{op,data});
    };
    let call=await launch();const database=`synthetic-profiles-${randomUUID()}`,providerId=randomUUID();
    const rpc=async(method:string,params:Record<string,unknown>={})=>{const r=await call('rpc',{protocol:2,requestId:randomUUID(),method,params});if(!r.ok)throw Error(r.error.code);return r.result;};
    await call('open',{name:database});
    const transfer=await rpc('transfer.begin',{direction:'extension-to-host',purpose:'vault-bootstrap',sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
    for(let offset=0;offset<bytes.length;offset+=262144)await rpc('transfer.chunk',{transferId:transfer.transferId,offset,dataBase64:bytes.subarray(offset,offset+262144).toString('base64')});
    const finished=await rpc('transfer.finish',{transferId:transfer.transferId}),password='synthetic profile password';
    const handle=(await rpc('vault.open',{source:{kind:'file',handle:finished.fileHandle},credential:{method:'password',password}})).vaultHandle;
    const capture=():Promise<NearbyNativeSource>=>call('nearby-native-source',{providerId,vaultHandle:handle});
    const first=await capture();expect(first.profiles).toHaveLength(1);expect(first.profiles![0]).toMatchObject({...expected.metadata,sha256:expected.sha256});
    const payload=Buffer.from(first.profiles![0].payloadBase64,'base64');expect(payload.length).toBe(expected.sizeBytes);expect(payload.every((byte,index)=>byte===index%256)).toBe(true);
    const projection=await call('nearby-native-project',first);expect(projection.blockers).toEqual([]);expect(projection.profileAssets).toHaveLength(1);
    const replacement=Buffer.from(Uint8Array.from({length:1024*1024},(_,index)=>(index*37+17)%256)),assetId=randomUUID();
    const write={handle,input:{operationId:randomUUID(),writeRevision:first.writeRevision,plan:{commands:[
      {kind:'collection-profile-set',collectionId:expected.collectionId,collectionTypeId:first.profiles![0].collectionTypeId,payloadSchemaVersion:1,
        allowedObjectTypeIds:first.profiles![0].allowedObjectTypeIds,requiredCapabilityIds:first.profiles![0].requiredCapabilityIds,assetId},
      {kind:'collection-presentation',collectionId:expected.collectionId,favorite:true,archived:true,iconRef:'key'}],attachments:[]},
      assets:[{id:assetId,base64:replacement.toString('base64')}]}};
    const invalid=structuredClone(write);invalid.input.plan.commands[0].collectionTypeId='com.monica.incompatible';
    await expect(call('content-write',invalid)).rejects.toThrow();expect((await capture()).writeRevision).toEqual(first.writeRevision);
    const receipt=await call('content-write',write),after=await capture();expect(receipt.alreadyCommitted).toBe(false);
    expect(Buffer.from(after.profiles![0].payloadBase64,'base64').equals(replacement)).toBe(true);
    expect(after.profiles![0].createdAt).toBe(first.profiles![0].createdAt);
    expect(after.collections.find(row=>row.collectionId===expected.collectionId)).toMatchObject({favorite:true,archived:true,iconRef:'key',headCommitId:receipt.commitId});
    expect(after.objects).toEqual(first.objects);
    await call('scan',[password,'snapshot-test-secret',first.profiles![0].payloadBase64.slice(0,512)]);
    await rpc('vault.lock',{vaultHandle:handle});await expect(capture()).rejects.toThrow();
    await call('close');await context!.close();context=undefined;call=await launch();await call('open',{name:database});
    await rpc('vault.open',{source:{kind:'vault',handle},credential:{method:'password',password}});
    const restored=await capture();expect(restored.profiles).toEqual(after.profiles);expect(restored.writeRevision).toEqual(after.writeRevision);
    const replay=await call('content-write',write);expect(replay).toMatchObject({alreadyCommitted:true,commitId:receipt.commitId});
    expect((await capture()).writeRevision).toEqual(after.writeRevision);
    await call('close');Object.assign(evidence,{status:'passed',binaryBytes:payload.length,writeBytes:replacement.length,atomicProfileWrite:true,presentation:true,
      typeConflictRollback:true,unchangedObjects:true,identicalReplayAfterRestart:true,exactBytes:true,lockedDenial:true,realBrowserRestart:true,encryptedStorageScan:true,versionOneNoSilentLoss:true});
  }finally{await context?.close();await writeFile(path.join(run,'evidence.json'),JSON.stringify(evidence,null,2));}
});
