import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PasskeyItem } from '../core/model';
import { capabilityLabel, createPasskeyKeyInspector, inspectPasskeyKey, passkeyCapability } from './capability';
import { createAssertion } from './webauthn-core';
import { preservePasskeyCounterHistory } from './ownership-policy';
import { readAndroidBackup } from '../providers/webdav/android-backup-codec';
import { decodeMdbx2Object, encodeMdbx2Object } from '../providers/mdbx2/mdbx2-item-codec';
import { buildKeePassPasskeyFields, readKeePassPasskeyFields } from '../providers/keepass/keepass-passkey-codec';
import { strToU8, zipSync } from 'fflate';
import { MemoryVaultStorage } from '../security/vault-storage';
import { MemoryVaultSessionStore } from '../security/vault-session';
import { SecureVaultService } from '../security/secure-vault-service';

const material = generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'der',type:'pkcs8'}).toString('base64');
const base: PasskeyItem = {id:'test',kind:'passkey',title:'Synthetic',favorite:false,notes:'',createdAt:'2026-10-10T00:00:00Z',updatedAt:'2026-10-10T00:00:00Z',providerRefs:[],credentialId:'AQID',rpId:'example.com',rpName:'Example',userHandle:'dXNlcg',userName:'Synthetic',userDisplayName:'Synthetic',algorithm:-7,publicKey:'',privateKeyPkcs8:material,signCount:0,discoverable:true,sourceMode:'browser-local'};

describe('Passkey capability matches browser signing and Android transfer limits', () => {
  it.each([-7,-257,-37,-8])('accepts real COSE %s keys and separates browser support from transfer policy', async algorithm => {
    const pair = algorithm === -7 ? generateKeyPairSync('ec',{namedCurve:'prime256v1'}) : algorithm === -8 ? generateKeyPairSync('ed25519') : generateKeyPairSync('rsa',{modulusLength:2048});
    const privateKeyPkcs8 = pair.privateKey.export({format:'pem',type:'pkcs8'}).toString();
    const item = {...base,algorithm,privateKeyPkcs8};
    const result = passkeyCapability(item,await inspectPasskeyKey(privateKeyPkcs8,algorithm),[]);
    expect(result).toMatchObject({browser:'available',transfer:algorithm === -7?'portable':'restricted',localStorageOnly:true});
    const assertion = await createAssertion({origin:'https://example.com',challenge:Buffer.alloc(32,1).toString('base64url'),rpId:item.rpId,credentialId:item.credentialId,userHandle:item.userHandle,privateKeyPkcs8,algorithm,signCount:0,userVerified:true});
    expect(Buffer.from(assertion.response.authenticatorData,'base64url').readUInt32BE(33)).toBe(0);
  });
  it.each([
    [undefined,'missing'],['','missing'],['broken','invalid'],['monica-passkey-key-ref-v1:synthetic','device-reference'],
    [material.slice(0,-12),'invalid']
  ])('does not present unusable material as ready (%s)', async (value,expected) => {
    const key = await inspectPasskeyKey(value,-7);
    expect(key).toBe(expected);
    expect(capabilityLabel(passkeyCapability({...base,privateKeyPkcs8:value},key,[]))).toBe('浏览器不可用');
  });
  it('rejects algorithm/key mismatch and damaged inner DER',async () => {
    expect(await inspectPasskeyKey(material,-257)).toBe('invalid');
    const damaged=Buffer.from(material,'base64');damaged.fill(0,36,68);
    expect(await inspectPasskeyKey(damaged.toString('base64'),-7)).toBe('invalid');
  });
  it('lists independent restrictions without changing flags or counter',() => {
    const item={...base,backupEligible:false,backupState:false,signCount:5,algorithm:-257};
    const before=structuredClone(item),status=passkeyCapability(item,'usable',[]);
    expect(status).toMatchObject({browser:'available',transfer:'restricted',reasons:['backup-restricted','counter-history','algorithm-restricted']});
    expect(item).toEqual(before);
    expect(passkeyCapability({...item,backupState:true},'usable',[]).browser).toBe('unavailable');
    expect(passkeyCapability({...base,signCountHighWaterMark:8},'usable',[]).reasons).toContain('counter-invalid');
  });
  it('does not turn unknown or stale hints into usable or local-only claims',() => {
    expect(passkeyCapability(base,'unknown',[]).browser).toBe('unknown');
    expect(passkeyCapability({...base,keyMaterialHint:'device-reference'},'usable',[]).transfer).toBe('portable');
    expect(passkeyCapability({...base,privateKeyPkcs8:undefined,keyMaterialHint:'device-reference',sourceMode:'android-metadata-only'},'missing',[])).toMatchObject({browser:'unavailable',transfer:'original-device'});
  });
  it('reuses crypto inspection after unrelated edits and invalidates changed material or algorithm',async () => {
    const inspect=vi.fn(inspectPasskeyKey),cache=createPasskeyKeyInspector(inspect,2);
    await cache.inspect(base);await cache.inspect({...base,notes:'edit'} as PasskeyItem);
    expect(inspect).toHaveBeenCalledTimes(1);
    await cache.inspect({...base,privateKeyPkcs8:'broken'});await cache.inspect({...base,algorithm:-8});
    expect(inspect).toHaveBeenCalledTimes(3);
    cache.clear();await cache.inspect(base);expect(inspect).toHaveBeenCalledTimes(4);
    await cache.inspect({...base,id:'second'});await cache.inspect({...base,id:'third'});await cache.inspect(base);
    expect(inspect).toHaveBeenCalledTimes(7);
  });
  it('returns a completed label synchronously, refreshes stale results and cannot resurrect a cleared session',async () => {
    let now=0;
    const inspect=vi.fn(async () => 'usable' as const),cache=createPasskeyKeyInspector(inspect,2,()=>now);
    expect(cache.peek(base)).toBeUndefined();
    await cache.inspect(base);
    expect(cache.peek({...base})).toBe('usable');
    expect(cache.peek({...base,privateKeyPkcs8:'changed'})).toBeUndefined();
    now=300_001;
    expect(cache.peek(base)).toBe('usable');
    await cache.inspect(base);expect(inspect).toHaveBeenCalledTimes(2);
    cache.clear();expect(cache.peek(base)).toBeUndefined();
    const pending=cache.inspect(base);cache.clear();await pending;
    expect(cache.peek(base)).toBeUndefined();
  });
  it('carries only the device-reference hint through Android ZIP, MDBX and KDBX projections',() => {
    const reference='monica-passkey-key-ref-v1:synthetic';
    const raw={credentialId:base.credentialId,rpId:base.rpId,privateKeyAlias:reference,publicKeyAlgorithm:-7};
    const imported=readAndroidBackup(zipSync({'folders/_root/passkeys/passkey_test.json':strToU8(JSON.stringify(raw))}),'test',{allowPortablePasskeys:true}).items[0] as PasskeyItem;
    expect(imported).toMatchObject({keyMaterialHint:'device-reference',sourceMode:'android-metadata-only'});
    expect(imported.privateKeyPkcs8).toBeUndefined();
    const native=encodeMdbx2Object({...base,privateKeyPkcs8:reference})!;
    const decoded=decodeMdbx2Object({objectId:'test',collectionId:'vault',objectTypeId:native.objectTypeId,title:'Synthetic',payloadSchemaVersion:1,deleted:false,payloadJson:native.payloadJson},{headCommitId:'head',updatedAt:base.updatedAt},'native').item as PasskeyItem;
    expect(decoded).toMatchObject({keyMaterialHint:'device-reference',sourceMode:'android-metadata-only'});
    const fields=buildKeePassPasskeyFields({item:{...base,privateKeyPkcs8:undefined,sourceMode:'android-metadata-only'},existingFields:new Map([['MonicaPasskey', 'true'],['MonicaPasskeyData',JSON.stringify(raw)]])});
    expect(readKeePassPasskeyFields(fields)).toMatchObject({keyMaterialHint:'device-reference',sourceMode:'android-metadata-only'});
  });
});

describe('Android-compatible immutable backup eligibility',() => {
  it.each([undefined,true,false])('preserves existing %s when a refresh omits flags',backupEligible => {
    const existing={...base,backupEligible,backupState:false};
    expect(preservePasskeyCounterHistory(existing,{...base,notes:'updated'})).toMatchObject({backupEligible,backupState:false,notes:'updated'});
  });
  it('rejects legacy-to-false and explicit flag changes, even when the key encoding changes',() => {
    expect(()=>preservePasskeyCounterHistory(base,{...base,backupEligible:false,privateKeyPkcs8:`\n${material}\n`})).toThrow('可备份属性');
    expect(()=>preservePasskeyCounterHistory({...base,backupEligible:false},{...base,backupEligible:true})).toThrow('可备份属性');
    expect(preservePasskeyCounterHistory(base,{...base,credentialId:'BAUG',backupEligible:false}).backupEligible).toBe(false);
  });
  it('keeps the encrypted stored credential intact on rejected sync and accepts a new false credential',async () => {
    const storage=new MemoryVaultStorage(),service=new SecureVaultService(storage,new MemoryVaultSessionStore());
    await service.setup('Synthetic capability acceptance');
    await service.upsertProvider({id:'file',kind:'monica-webdav',name:'Synthetic',enabled:true,isDefaultSaveTarget:false,config:{}});
    const original={...base,providerRefs:[{providerId:'file',remoteId:'test.json'}]};
    await service.applyProviderSync('file',[original]);
    await expect(service.applyProviderSync('file',[{...original,backupEligible:false,backupState:false}])).rejects.toThrow('可备份属性');
    expect(await service.listItems()).toEqual([original]);
    const fresh={...original,id:'new',credentialId:'BAUG',backupEligible:false,backupState:false};
    await service.applyProviderSync('file',[original,fresh]);
    expect(await service.listItems()).toContainEqual(fresh);
  });
});
