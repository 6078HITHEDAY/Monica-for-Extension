import { cloneLosslessJson } from '../core/lossless-json';
import type { Mdbx2ContentProfile } from '../providers/mdbx2/content-profiles';
import type { Mdbx2CollectionSummary } from '../providers/mdbx2/native-contract';
import { invalidNearby, wireInteger, wireObject, wireText, type NearbyWireData } from './wire-shape';

/** An opaque extra in Android's existing folder/root metadata. The bytes use
 * its existing authenticated asset channel, never an oversized JSON string. */
export const NATIVE_COLLECTION_ARCHIVE = 'monica_native_collection';
export interface NearbyCollectionArchive {
  version: 1;
  presentation: { favorite: boolean; archived: boolean; iconRef: string | null };
  profile: (Omit<Mdbx2ContentProfile, 'payloadBase64'> & { sizeBytes: number; assetIdentity: string }) | null;
}
const digest = /^[a-f0-9]{64}$/, uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
function text(value: unknown, max: number): string {
  const s=wireText(value); if (!s || new TextEncoder().encode(s).length>max) invalidNearby('native-profile-archive'); return s;
}
function exact(value: unknown, fields: string): Record<string, unknown> {
  const row=wireObject(value),names=fields.split(',');
  if(Object.keys(row).length!==names.length || names.some(key=>!Object.prototype.hasOwnProperty.call(row,key)))invalidNearby('native-profile-archive');
  return row;
}
function ids(value: unknown, limit: number): string[] {
  if(!Array.isArray(value)||value.length>limit)invalidNearby('native-profile-archive');
  const result=value.map(v=>text(v,512));if(new Set(result).size!==result.length)invalidNearby('native-profile-archive');return result;
}
export function readNearbyCollectionArchive(data: NearbyWireData): NearbyCollectionArchive | undefined {
  if (!['folder','vault-metadata'].includes(data.entry_type)) return undefined;
  const raw=wireObject(data.payload)[NATIVE_COLLECTION_ARCHIVE];if(raw===undefined)return undefined;
  const archive=exact(raw,'version,presentation,profile');if(archive.version!==1)invalidNearby('native-profile-archive-version');
  const p=exact(archive.presentation,'favorite,archived,iconRef');
  if(typeof p.favorite!=='boolean'||typeof p.archived!=='boolean')invalidNearby('native-profile-archive');
  const presentation={favorite:p.favorite,archived:p.archived,iconRef:p.iconRef===null?null:text(p.iconRef,4096)};
  let profile:NearbyCollectionArchive['profile']=null;
  if(archive.profile!==null){
    const row=exact(archive.profile,'collectionId,collectionTypeId,payloadSchemaVersion,allowedObjectTypeIds,requiredCapabilityIds,createdAt,updatedAt,createdByDeviceId,updatedByDeviceId,headCommitId,deleted,sha256,sizeBytes,assetIdentity');
    if(!uuid.test(text(row.collectionId,36))||!uuid.test(text(row.headCommitId,36))||!digest.test(text(row.sha256,64))||typeof row.deleted!=='boolean')invalidNearby('native-profile-archive');
    profile={collectionId:row.collectionId as string,collectionTypeId:text(row.collectionTypeId,512),
      payloadSchemaVersion:Number(wireInteger(row.payloadSchemaVersion,0xffff_ffffn,1n)),
      allowedObjectTypeIds:ids(row.allowedObjectTypeIds,256),requiredCapabilityIds:ids(row.requiredCapabilityIds,128),
      createdAt:text(row.createdAt,128),updatedAt:text(row.updatedAt,128),createdByDeviceId:text(row.createdByDeviceId,512),updatedByDeviceId:text(row.updatedByDeviceId,512),
      headCommitId:row.headCommitId as string,deleted:row.deleted,sha256:row.sha256 as string,
      sizeBytes:Number(wireInteger(row.sizeBytes,1024n*1024n)),assetIdentity:text(row.assetIdentity,4096)};
  }
  return {version:1,presentation,profile};
}
export function sameNearbyProfile(left: NearbyCollectionArchive['profile'] | Mdbx2ContentProfile | undefined, right: NearbyCollectionArchive['profile'] | Mdbx2ContentProfile | undefined): boolean {
  if(!left||!right)return !left&&!right;
  const set=(values:string[])=>JSON.stringify([...values].sort());
  return left.sha256===right.sha256 && left.collectionTypeId===right.collectionTypeId && left.payloadSchemaVersion===right.payloadSchemaVersion
    && set(left.allowedObjectTypeIds)===set(right.allowedObjectTypeIds) && set(left.requiredCapabilityIds)===set(right.requiredCapabilityIds);
}
export function profileAsset(profile: NonNullable<NearbyCollectionArchive['profile']>): Record<string,unknown> {
  return {id:profile.sha256,attachment_id:profile.assetIdentity,file_name:'monica-collection-profile.bin',media_type:'application/octet-stream',size:profile.sizeBytes};
}
/** Check identity as well as digest: ordinary attachments can share bytes with
 * a profile and must not be consumed or dropped as its virtual payload. */
export function requireNearbyProfileAsset(data: NearbyWireData, profile: NonNullable<NearbyCollectionArchive['profile']>): Record<string,unknown> {
  if(!Array.isArray(data.assets)||data.assets.length>64)invalidNearby('native-profile-asset-missing');
  const found=data.assets.map(wireObject).filter(a=>a.attachment_id===profile.assetIdentity);
  if(found.length!==1 || found[0].id!==profile.sha256 || Number(wireInteger(found[0].size,1024n*1024n))!==profile.sizeBytes)invalidNearby('native-profile-asset-mismatch');
  text(found[0].file_name,512);if(new TextEncoder().encode(wireText(found[0].media_type)).length>512)invalidNearby('native-profile-asset-mismatch');
  for(const field of ['image','icon'])if(found[0][field]!==undefined&&typeof found[0][field]!=='boolean')invalidNearby('native-profile-asset-mismatch');
  return found[0];
}

/** Preserve the received provenance when native semantics still match it.
 * Native commits/device timestamps differ after adoption; echoing those would
 * manufacture an edit on every round trip, including pure trash/restore. */
export function projectNearbyCollectionArchive(data: NearbyWireData, collection: Mdbx2CollectionSummary,
  profile: Mdbx2ContentProfile | undefined, applied=false): NearbyWireData {
  const output=cloneLosslessJson(data), saved=readNearbyCollectionArchive(output);
  // Android can retain this archive as metadata plus an ordinary file without
  // activating the profile. Opening that database must keep the archive intact.
  if(saved&&!profile&&!applied)return output;
  if(saved?.profile&&!profile&&applied)invalidNearby('native-profile-source-missing');
  if(!saved&&!profile&&!collection.favorite&&!collection.archived&&!collection.iconRef)return output;
  let archived:NearbyCollectionArchive['profile']=null;
  if(profile){
    if(saved?.profile && sameNearbyProfile(saved.profile,profile))archived=saved.profile;
    else {
      const {payloadBase64,...metadata}=profile;
      const size=payloadBase64.length/4*3-(payloadBase64.endsWith('==')?2:payloadBase64.endsWith('=')?1:0);
      if(!Number.isSafeInteger(size)||size<0||size>1024*1024)invalidNearby('native-profile-archive');
      archived={...metadata,sizeBytes:size,assetIdentity:saved?.profile?.assetIdentity??`monica-profile:${profile.collectionId}`};
    }
  }
  wireObject(output.payload)[NATIVE_COLLECTION_ARCHIVE]={version:1,presentation:{favorite:collection.favorite,archived:collection.archived,iconRef:collection.iconRef??null},profile:archived};
  return output;
}
