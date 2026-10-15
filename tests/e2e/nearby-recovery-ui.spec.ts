import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { SecureVaultService } from '../../src/security/secure-vault-service';
import { MemoryVaultStorage } from '../../src/security/vault-storage';
import { MemoryVaultSessionStore } from '../../src/security/vault-session';
import { MemoryVaultDeviceKeyStore } from '../../src/security/vault-device-key';
import { nearbyNativeIntent } from '../../src/nearby/native-journal';
import type { Mdbx2ContentWriteAnchor } from '../../src/providers/mdbx2/content-write-anchor';
import { encryptVaultState, importVaultKey } from '../../src/security/vault-crypto';

test('local Canvas renders the editable receive recovery design', async ({},info)=>{
  test.skip(process.platform!=='win32','Installed Edge');
  const run=info.outputPath('isolated');await mkdir(run,{recursive:true});
  const context=await launchEdgeContext(path.join(run,'profile'),{viewport:{width:1400,height:1050}});
  try{
    const page=await context.newPage();const doc=await readFile('docs/design/nearby-recovery-320.m3e.json','utf8');
    await page.goto('http://127.0.0.1:5186/#doc='+encodeURIComponent(doc));
    await expect(page.getByText('检查并继续接收',{exact:true}).first()).toBeVisible();
    await expect(page.getByText('接收内容已加密保留',{exact:true}).first()).toBeVisible();
    await page.screenshot({path:path.join(run,'canvas.png'),fullPage:true});
  }finally{await context.close();}
});

test('production settings show retained conflict and legacy recovery without exposing inputs', async ({},info)=>{
  test.skip(process.platform!=='win32','Installed Edge');test.setTimeout(90000);
  const run=info.outputPath('isolated');await mkdir(run,{recursive:true});
  const storage=new MemoryVaultStorage(),sessions=new MemoryVaultSessionStore();
  const service=new SecureVaultService(storage,sessions,Date.now,new MemoryVaultDeviceKeyStore());
  const password='Synthetic recovery UI password', secret='synthetic recovery private attachment';
  await service.setup(password);const sessionId=(await service.passkeySessionId())!;
  const providerId=randomUUID(),vaultId=randomUUID(),collectionId=randomUUID(),assetId=randomUUID();
  // The journal is synthetic; bind its provider to a real isolated browser
  // vault below before opening settings so normal startup checks are valid.
  await service.upsertProvider({id:providerId,kind:'mdbx2',enabled:true,isDefaultSaveTarget:false,name:'Synthetic recovery vault',config:{vaultHandle:randomUUID(),runtimeBackend:'browser'}});
  const initial=await service.nearbySessionPreferences(sessionId);await service.updateNearbyPreferences({kind:'source',providerId},initial.epoch,sessionId);
  const preferences=await service.nearbySessionPreferences(sessionId);
  const anchor:Mdbx2ContentWriteAnchor={writeRevision:{vaultId,revisionSha256:''},branches:[{branchId:randomUUID(),branchName:'main',headCommitId:randomUUID()}]};
  const digest=createHash('sha256');
  for(const text of ['monica-extension-write-revision-v1',vaultId,...anchor.branches.flatMap(b=>[b.branchId,b.branchName,b.headCommitId])]){
    const bytes=Buffer.from(text),length=Buffer.alloc(8);length.writeBigUInt64LE(BigInt(bytes.length));digest.update(length).update(bytes);
  }
  anchor.writeRevision.revisionSha256=digest.digest('hex');
  const intent=await nearbyNativeIntent({providerId,vaultHandle:randomUUID(),sourceHash:'a'.repeat(64),
    write:{operationId:randomUUID(),writeRevision:anchor.writeRevision,plan:{commands:[],attachments:[{kind:'create',collectionId,attachmentId:randomUUID(),fileName:'synthetic.bin',assetId}]},assets:[{id:assetId,bytes:Buffer.from(secret)}]},
    remainingWrites:[{operationId:randomUUID(),plan:{commands:[{kind:'collection-rename',collectionId,title:'Received folder'}],attachments:[]},assets:[]}],
    bindings:[{recordId:'synthetic-record',clockJson:'{"syntheticPeer":1}',localId:`mdbx:${providerId}:folder:${collectionId}`,deleted:false,dataJson:'{"title":"Synthetic"}'}]
  },preferences.replicaStorageId,anchor);
  await service.stageNearbyNativeIntent(intent,preferences.epoch,sessionId,()=>{});
  const next=await service.advanceNearbyNativeIntent(intent.operationId,randomUUID(),sessionId,()=>{});
  await expect(service.finishNearbyNativeIntent(next.operationId,sessionId,()=>{},true)).rejects.toMatchObject({code:'native-sequence-conflict'});
  const envelope=(await storage.read())!;expect(JSON.stringify(envelope)).not.toContain(Buffer.from(secret).toString('base64'));
  const extension=path.resolve('dist'),data=path.join(run,'appdata');await mkdir(data,{recursive:true});
  const context=await launchEdgeContext(path.join(run,'profile'),{locale:'zh-CN',colorScheme:'dark',viewport:{width:420,height:930},
    env:{...process.env,APPDATA:data,LOCALAPPDATA:data},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const evidence:Record<string,unknown>={status:'failed',productionUi:true,syntheticEncryptedJournal:true,actualNativeRecovery:false};
  try{
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    const seed=async(value:typeof envelope)=>page.evaluate(envelope=>new Promise<void>((resolve,reject)=>{
      const open=indexedDB.open('monica-extension-secure-vault',1);
      open.onupgradeneeded=()=>{if(!open.result.objectStoreNames.contains('vault'))open.result.createObjectStore('vault');};
      open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('vault','readwrite');tx.objectStore('vault').put(envelope,'primary');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};
    }),value);
    await seed(envelope);
    const unlock=await page.evaluate(masterPassword=>chrome.runtime.sendMessage({type:'VAULT_UNLOCK',masterPassword}),password);expect(unlock.ok).toBe(true);
    const created=await page.evaluate(()=>chrome.runtime.sendMessage({type:'MDBX2_VAULT_CREATE',input:{name:'Synthetic UI native vault',password:'Synthetic UI native password'}}));
    expect(created.ok).toBe(true);
    const provider=(await service.readState()).providers.find(p=>p.id===providerId)!;
    await service.upsertProvider({...provider,config:created.data.account.config});
    const boundEnvelope=(await storage.read())!;
    const legacyState=await service.readState();delete legacyState.nearbyNativeJournal!.intent!.sequence!.completed;
    const legacyEnvelope=await encryptVaultState(legacyState,await importVaultKey((await sessions.read())!.rawKey),boundEnvelope.kdf);
    expect((await page.evaluate(()=>chrome.runtime.sendMessage({type:'VAULT_LOCK'}))).ok).toBe(true);
    await seed(boundEnvelope);
    expect((await page.evaluate(masterPassword=>chrome.runtime.sendMessage({type:'VAULT_UNLOCK',masterPassword}),password)).ok).toBe(true);
    const openSettings=async()=>{
      await page.reload();
      const more=page.getByRole('button',{name:'更多',exact:true});await expect(more).toBeVisible();
      if(await more.getAttribute('aria-expanded')!=='true')await more.click();
      await page.getByRole('button',{name:'设置与备份',exact:true}).click({timeout:10000});await page.locator('[data-settings-entry="wifi-sync"]').click();
    };
    await openSettings();
    const recovery=page.locator('[data-nearby-recovery]');await expect(recovery).toContainText('已保存 1 步，剩余 1 步');
    await expect(recovery).toContainText('密码库有新的修改');await expect(recovery).toContainText('本次接收的保存内容和附件副本仍加密保留');
    await expect(page.getByRole('button',{name:'检查并继续接收',exact:true})).toBeEnabled();
    expect(await page.locator('body').innerText()).not.toContain(secret);expect(await page.locator('body').innerText()).not.toContain(intent.operationId);
    const closeNavigation=page.getByRole('button',{name:'关闭导航',exact:true});if(await closeNavigation.isVisible())await closeNavigation.click();
    await recovery.scrollIntoViewIfNeeded();expect(await recovery.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
    await page.screenshot({path:path.join(run,'recovery-dark.png'),fullPage:true});
    await page.getByRole('button',{name:'稍后处理',exact:true}).click();await expect(recovery).toHaveCount(0);
    await page.getByRole('button',{name:'重新连接',exact:true}).click();await expect(recovery).toContainText('已保存 1 步，剩余 1 步');
    const locked=await page.evaluate(()=>chrome.runtime.sendMessage({type:'VAULT_LOCK'}));expect(locked.ok).toBe(true);
    await expect(recovery).toHaveCount(0);await seed(legacyEnvelope);
    expect((await page.evaluate(masterPassword=>chrome.runtime.sendMessage({type:'VAULT_UNLOCK',masterPassword}),password)).ok).toBe(true);
    await openSettings();
    await expect(recovery).toContainText('这是旧版创建的接收日志，仅保留剩余步骤');
    await expect(recovery).not.toContainText('本次接收的保存内容和附件副本仍加密保留');
    evidence.status='passed';evidence.edgeVersion=context.browser()?.version();evidence.cancelReconnectRetainsJournal=true;evidence.narrowLayout=true;evidence.legacyRetentionLabel=true;evidence.lockClosesRecovery=true;
  }finally{await context.close();await writeFile(path.join(run,'evidence.json'),JSON.stringify(evidence,null,2));}
});
