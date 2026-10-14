import { md5 } from 'hash-wasm';
import { cloneLosslessJson } from '../core/lossless-json';
import type { Mdbx2NativeClient } from '../providers/mdbx2/native-client';
import type { Mdbx2CollectionSummary, Mdbx2ObjectRecord, Mdbx2ObjectSummary, Mdbx2WriteRevision } from '../providers/mdbx2/native-contract';
import type { Mdbx2ContentMetadata } from '../providers/mdbx2/content-metadata';
import type { Mdbx2ContentAttachment } from '../providers/mdbx2/content-attachments';
import { mdbx2TransferOperationScope as hash } from '../providers/mdbx2/mdbx2-transfer-identity';
import { invalidNearby } from './wire-shape';

export type NearbyNativeClient = Pick<Mdbx2NativeClient, 'readWriteRevision' | 'listCollections' | 'listObjects' | 'revealObject' | 'readContentMetadata' | 'readContentAttachments'>;
export interface NearbyNativeObject { summary: Mdbx2ObjectSummary; record: Mdbx2ObjectRecord | null }
/** Complete source inventory, not a scan batch. A null record explicitly means
 * native deleted-content policy prevented disclosure; it is NOT a purge. */
export interface NearbyNativeSource {
  providerId: string; vaultHandle: string; rootId: string; sourceHash: string;
  writeRevision: Mdbx2WriteRevision;
  collections: Mdbx2CollectionSummary[]; objects: NearbyNativeObject[];
  metadata: Mdbx2ContentMetadata; attachments: Mdbx2ContentAttachment[];
}
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export function nativeId(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalidNearby('native-identity'); return value; }
export function nativeActive(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('Native nearby catalog cancelled', 'AbortError'); }
function revision(value: Mdbx2WriteRevision): Mdbx2WriteRevision {
  nativeId(value.vaultId); if (!/^[a-f0-9]{64}$/.test(value.revisionSha256)) invalidNearby('native-revision'); return { ...value };
}
export function assertNativeRevision(actual: Mdbx2WriteRevision, expected: Mdbx2WriteRevision): void {
  revision(actual); if (actual.vaultId !== expected.vaultId || actual.revisionSha256 !== expected.revisionSha256) invalidNearby('native-source-changed');
}

/** Matches Java UUID.nameUUIDFromBytes, without a namespace prefix. MD5 here
 * derives an Android routing identity, never a security digest or key. */
export async function nearbyNativeRootId(vaultId: string): Promise<string> {
  const digest = await md5(`monica-root:${nativeId(vaultId)}`);
  const bytes = Uint8Array.from({ length: 16 }, (_, i) => parseInt(digest.slice(i * 2, i * 2 + 2), 16));
  bytes[6] = (bytes[6] & 15) | 0x30; bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Read all owners first, then metadata/attachment catalogs at the SAME content
 * revision. Never enumerate user-facing cached VaultItems as native authority. */
export async function captureNearbyNativeSource(client: NearbyNativeClient, input: { providerId: string; vaultHandle: string }, signal?: AbortSignal): Promise<NearbyNativeSource> {
  const providerId = input.providerId, handle = nativeId(input.vaultHandle);
  if (typeof providerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(providerId)) invalidNearby('native-provider');
  nativeActive(signal);
  const expected = revision(await client.readWriteRevision(handle)); nativeActive(signal);
  const rootId = await nearbyNativeRootId(expected.vaultId); nativeActive(signal);
  const collections: Mdbx2CollectionSummary[] = [], objects: NearbyNativeObject[] = [];
  const owners = new Set<string>(), objectIds = new Set<string>();
  let bytes = 0;
  const charge = (value: unknown) => { bytes += new TextEncoder().encode(JSON.stringify(value)).length; if (bytes > 32 * 1024 * 1024) invalidNearby('native-catalog-limit'); };
  const pages = async <T>(read: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>, accept: (row: T) => Promise<void>) => {
    let cursor: string | undefined; const seen = new Set<string>();
    do {
      nativeActive(signal); const page = await read(cursor); nativeActive(signal);
      if (!Array.isArray(page.items) || page.items.length > 200) invalidNearby('native-catalog-page');
      for (const row of page.items) { charge(row); await accept(row); nativeActive(signal); }
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (typeof cursor !== 'string' || !cursor || cursor.length > 8192 || !page.items.length || seen.has(cursor)) invalidNearby('native-catalog-cursor');
        seen.add(cursor);
      }
    } while (cursor !== undefined);
  };
  for (const deleted of [false, true]) await pages(cursor => client.listCollections(handle, { deleted, excludeRoot: false, pageSize: 200, cursor }), async row => {
    nativeId(row.collectionId); nativeId(row.headCommitId); if (row.groupId !== undefined) nativeId(row.groupId);
    if (row.deleted !== deleted || owners.has(row.collectionId) || owners.size >= 10_000) invalidNearby('native-collection-catalog');
    if (row.collectionId === rootId && (row.deleted || row.groupId !== undefined)) invalidNearby('native-root-state');
    owners.add(row.collectionId); collections.push({ ...row });
  });
  for (const owner of collections) for (const deleted of [false, true]) await pages(cursor => client.listObjects(handle, owner.collectionId, { deleted, pageSize: 200, cursor }), async row => {
    nativeId(row.objectId); nativeId(row.headCommitId);
    if (row.collectionId !== owner.collectionId || row.deleted !== deleted || objectIds.has(row.objectId) || objectIds.size >= 10_000) invalidNearby('native-object-catalog');
    objectIds.add(row.objectId);
    const record = deleted ? null : await client.revealObject(handle, row.objectId); nativeActive(signal);
    if (record) {
      if (record.objectId !== row.objectId || record.collectionId !== row.collectionId || record.objectTypeId !== row.objectTypeId || record.title !== row.title || record.deleted !== row.deleted || record.payloadSchemaVersion !== row.payloadSchemaVersion || record.headCommitId !== undefined && record.headCommitId !== row.headCommitId) invalidNearby('native-source-changed');
      if (new TextEncoder().encode(record.payloadJson).length > 1024 * 1024) invalidNearby('native-payload-limit');
      charge(record);
    }
    objects.push({ summary: { ...row }, record: record ? { ...record } : null });
  });
  const metadata = await client.readContentMetadata(handle, { writeRevision: { ...expected }, collectionIds: [...owners], objectIds: [...objectIds] }, signal);
  nativeActive(signal); assertNativeRevision(metadata.writeRevision, expected); charge(metadata);
  const assets = await client.readContentAttachments(handle, { writeRevision: { ...expected }, collectionIds: [...owners] }, signal);
  nativeActive(signal); assertNativeRevision(assets.writeRevision, expected); charge(assets);
  assertNativeRevision(await client.readWriteRevision(handle), expected); nativeActive(signal);
  const sourceHash = await hash({ providerId, handle, writeRevision: expected }); nativeActive(signal);
  return { providerId, vaultHandle: handle, rootId, sourceHash, writeRevision: expected, collections: collections.sort((a, b) => a.collectionId < b.collectionId ? -1 : 1),
    objects: objects.sort((a, b) => a.summary.objectId < b.summary.objectId ? -1 : 1), metadata: cloneLosslessJson(metadata), attachments: cloneLosslessJson(assets.attachments) };
}
