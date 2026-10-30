import { base64ToBytes, bytesToBase64 } from '../../security/encoding';
import { Mdbx2NativeHostError, type Mdbx2CollectionSummary, type Mdbx2WriteRevision } from './native-contract';
import type { Mdbx2NativeClient } from './native-client';

export interface Mdbx2ContentProfile {
  collectionId: string; collectionTypeId: string; payloadSchemaVersion: number;
  allowedObjectTypeIds: string[]; requiredCapabilityIds: string[];
  createdAt: string; updatedAt: string; createdByDeviceId: string; updatedByDeviceId: string;
  headCommitId: string; deleted: boolean;
  /** Opaque bytes: profiles need not contain JSON or even UTF-8. */
  payloadBase64: string; sha256: string;
}
type Owner = Pick<Mdbx2CollectionSummary, 'collectionId' | 'collectionTypeId' | 'profileSchemaVersion' | 'headCommitId' | 'deleted'>;
export interface Mdbx2ContentProfilesInput { writeRevision: Mdbx2WriteRevision; collections: readonly Owner[] }
export interface Mdbx2ContentProfiles { writeRevision: Mdbx2WriteRevision; profiles: Mdbx2ContentProfile[] }
const MAX_PAYLOAD = 1024 * 1024, MAX_CATALOG = 32 * MAX_PAYLOAD, CHUNK = 256 * 1024;
const encoder = new TextEncoder();
function invalid(): never { throw new Mdbx2NativeHostError('content-profile-invalid', 'MDBX 文件夹配置不完整或已变化，请重新读取。'); }
function shape(value: unknown, fields: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>, keys = fields.split(',');
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(row,key))) invalid();
  return row;
}
function text(value: unknown, limit: number, empty = false): string {
  if (typeof value !== 'string' || !empty && !value || value.length > limit || encoder.encode(value).length > limit) invalid();
  return value;
}
function uuid(value: unknown): string { const id = text(value,36); if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) invalid(); return id; }
function digest(value: unknown): string { const hash=text(value,64); if (!/^[a-f0-9]{64}$/.test(hash)) invalid(); return hash; }
function integer(value: unknown, maximum: number, minimum = 0): number { if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid(); return value as number; }
function revision(value: unknown): Mdbx2WriteRevision { const row=shape(value,'vaultId,revisionSha256'); return {vaultId:uuid(row.vaultId),revisionSha256:digest(row.revisionSha256)}; }
function strings(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  const values=value.map(value=>text(value,512)); if (new Set(values).size !== values.length) invalid(); return values;
}
const fields='collectionId,collectionTypeId,payloadSchemaVersion,allowedObjectTypeIds,requiredCapabilityIds,createdAt,updatedAt,createdByDeviceId,updatedByDeviceId,headCommitId,deleted';
function metadata(value: unknown, owner: Owner): Omit<Mdbx2ContentProfile,'payloadBase64'|'sha256'> {
  const row=shape(value,fields);
  if (row.collectionId !== owner.collectionId || row.collectionTypeId !== owner.collectionTypeId || row.payloadSchemaVersion !== owner.profileSchemaVersion
    || row.headCommitId !== owner.headCommitId || row.deleted !== owner.deleted) invalid();
  return {collectionId:uuid(row.collectionId),collectionTypeId:text(row.collectionTypeId,512),payloadSchemaVersion:integer(row.payloadSchemaVersion,0xffff_ffff,1),
    allowedObjectTypeIds:strings(row.allowedObjectTypeIds,256),requiredCapabilityIds:strings(row.requiredCapabilityIds,128),
    createdAt:text(row.createdAt,128),updatedAt:text(row.updatedAt,128),createdByDeviceId:text(row.createdByDeviceId,512),updatedByDeviceId:text(row.updatedByDeviceId,512),
    headCommitId:uuid(row.headCommitId),deleted:row.deleted as boolean};
}

/** Read only listed profiles at the exact catalog revision. Every chunk is
 * independently authorized natively; incomplete results never leave this API. */
export async function readMdbx2ContentProfiles(client: Pick<Mdbx2NativeClient,'hello'|'request'>, vaultHandle: string,
  input: Mdbx2ContentProfilesInput, signal?: AbortSignal): Promise<Mdbx2ContentProfiles> {
  const handle=uuid(vaultHandle), expected=revision(input.writeRevision);
  if (!Array.isArray(input.collections) || input.collections.length > 10_000) invalid();
  const owners=input.collections.map(row=>({collectionId:uuid(row.collectionId),collectionTypeId:text(row.collectionTypeId,512),
    profileSchemaVersion:integer(row.profileSchemaVersion,0xffff_ffff,1),headCommitId:uuid(row.headCommitId),deleted:row.deleted}));
  if (new Set(owners.map(row=>row.collectionId)).size !== owners.length || owners.some(row=>typeof row.deleted !== 'boolean')) invalid();
  const active=()=>{if(signal?.aborted)throw new DOMException('MDBX profile read cancelled','AbortError');};
  const sameRevision=(value: unknown)=>{const actual=revision(value);if(actual.vaultId!==expected.vaultId||actual.revisionSha256!==expected.revisionSha256)invalid();};
  active();
  if (!owners.length) return {writeRevision:expected,profiles:[]};
  const caps=await client.hello(5_000,handle);active();
  if (!caps.supportsContentProfiles || !caps.supportsVaultWriteRevision) throw new Mdbx2NativeHostError('content-profile-host-update-required','当前 MDBX 引擎不支持完整文件夹配置读取，请更新后重试。');
  const profiles:Mdbx2ContentProfile[]=[];let total=0;
  for(const owner of owners){
    let buffer:Uint8Array<ArrayBuffer>|undefined, offset=0, hash:string|undefined, details:ReturnType<typeof metadata>|undefined;
    try {
      for(;;){
        active();const result=await client.request('content.metadata.read',{vaultHandle:handle,kind:'collection-profile',id:owner.collectionId,
          writeRevision:{...expected},offset,limit:CHUNK},30_000);active();
        if(encoder.encode(JSON.stringify(result)).length>850*1024)invalid();
        const row=shape(result,'kind,id,metadata,sizeBytes,sha256,offset,nextOffset,done,dataBase64,writeRevision');sameRevision(row.writeRevision);
        if(row.kind!=='collection-profile'||row.id!==owner.collectionId||row.offset!==offset)invalid();
        const info=metadata(row.metadata,owner), size=integer(row.sizeBytes,MAX_PAYLOAD), foundHash=digest(row.sha256);
        if(!buffer){total+=size+encoder.encode(JSON.stringify(info)).length;if(total>MAX_CATALOG)invalid();buffer=new Uint8Array(size);hash=foundHash;details=info;}
        else if(size!==buffer.length||foundHash!==hash||JSON.stringify(info)!==JSON.stringify(details))invalid();
        const encoded=text(row.dataBase64,4*Math.ceil(CHUNK/3),true);let bytes:Uint8Array|undefined;
        try{bytes=base64ToBytes(encoded);if(bytesToBase64(bytes)!==encoded||bytes.length>CHUNK||offset+bytes.length>size)invalid();
          const next=integer(row.nextOffset,size);if(next!==offset+bytes.length||row.done!==(next===size)||!bytes.length&&next<size)invalid();
          buffer.set(bytes,offset);offset=next;
        }finally{bytes?.fill(0);}
        if(row.done)break;
      }
      const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))).map(byte=>byte.toString(16).padStart(2,'0')).join('');active();
      if(actual!==hash)invalid();profiles.push({...details!,payloadBase64:bytesToBase64(buffer),sha256:hash!});
    }finally{buffer?.fill(0);}
  }
  sameRevision(await client.request('vault.writeRevision',{vaultHandle:handle},15_000));active();
  return {writeRevision:expected,profiles};
}
