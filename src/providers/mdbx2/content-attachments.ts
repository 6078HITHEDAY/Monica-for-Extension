import { base64ToBytes, bytesToBase64 } from '../../security/encoding';
import { Mdbx2NativeHostError, type Mdbx2WriteRevision } from './native-contract';
import type { Mdbx2NativeClient } from './native-client';

const MAX_ITEMS = 10_000, MAX_CATALOG = 32 * 1024 * 1024, MAX_ASSET = 64 * 1024 * 1024;
const PAGE = 50, CHUNK = 256 * 1024, MAX_RESPONSE = 850 * 1024;
type Client = Pick<Mdbx2NativeClient, 'hello' | 'request'>;
export interface Mdbx2ContentAttachment {
  attachmentId: string; collectionId: string; objectId: string | null;
  fileName: string; mediaType: string | null; storageMode: string; contentHash: string;
  originalSize: number; storedSize: number; chunkCount: number;
  headCommitId: string; deleted: boolean; updatedAt: string;
}
export interface Mdbx2ContentAttachmentsInput { writeRevision: Mdbx2WriteRevision; collectionIds: readonly string[] }
export interface Mdbx2ContentAttachments { writeRevision: Mdbx2WriteRevision; attachments: Mdbx2ContentAttachment[] }
const FIELDS = 'attachmentId,collectionId,objectId,fileName,mediaType,storageMode,contentHash,originalSize,storedSize,chunkCount,headCommitId,deleted,updatedAt';
function invalid(): never { throw new Mdbx2NativeHostError('content-attachments-invalid', 'MDBX 附件目录或内容不完整，请重新读取。'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function shape(value: unknown, fields: string): Record<string, unknown> {
  const row = object(value), keys = fields.split(',');
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(row, key))) invalid();
  return row;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) invalid();
  return value;
}
function text(value: unknown, max: number): string { if (typeof value !== 'string' || value.length > max) invalid(); return value; }
function hash(value: unknown): string { const result = text(value, 64); if (!/^[a-f0-9]{64}$/.test(result)) invalid(); return result; }
function uint(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) invalid(); return value as number;
}
function revision(value: unknown): Mdbx2WriteRevision {
  const row = shape(value, 'vaultId,revisionSha256'); return { vaultId: uuid(row.vaultId), revisionSha256: hash(row.revisionSha256) };
}
function sameRevision(value: unknown, expected: Mdbx2WriteRevision): void {
  const actual = revision(value);
  if (actual.vaultId !== expected.vaultId || actual.revisionSha256 !== expected.revisionSha256) {
    throw new Mdbx2NativeHostError('content-attachments-stale', 'MDBX 已被修改，请重新读取附件目录。', true);
  }
}
function summary(value: unknown): Mdbx2ContentAttachment {
  const row = shape(value, FIELDS);
  if (typeof row.deleted !== 'boolean') invalid();
  return { attachmentId: uuid(row.attachmentId), collectionId: uuid(row.collectionId), objectId: row.objectId === null ? null : uuid(row.objectId),
    fileName: text(row.fileName, 64 * 1024), mediaType: row.mediaType === null ? null : text(row.mediaType, 64 * 1024),
    storageMode: text(row.storageMode, 128), contentHash: hash(row.contentHash), originalSize: uint(row.originalSize), storedSize: uint(row.storedSize),
    chunkCount: uint(row.chunkCount, 0xffff_ffff), headCommitId: uuid(row.headCommitId), deleted: row.deleted, updatedAt: text(row.updatedAt, 128) };
}
function response(value: unknown): unknown { if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_RESPONSE) invalid(); return value; }
function active(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('MDBX attachment read cancelled', 'AbortError'); }
async function supported(client: Client, handle: string, signal?: AbortSignal): Promise<void> {
  active(signal); const caps = await client.hello(5_000, handle); active(signal);
  if (!caps.supportsContentAttachments || !caps.supportsVaultWriteRevision) throw new Mdbx2NativeHostError(
    'content-attachments-host-update-required', '当前 MDBX 引擎不支持完整附件目录，请更新插件或本机助手。');
}

/** Metadata only. Includes folder-owned attachments and selected collections'
 * tombstones; never interprets a deleted attachment as an empty live asset. */
export async function readMdbx2ContentAttachments(client: Client, vaultHandle: string, input: Mdbx2ContentAttachmentsInput, signal?: AbortSignal): Promise<Mdbx2ContentAttachments> {
  const handle = uuid(vaultHandle), expected = revision(input.writeRevision);
  if (!Array.isArray(input.collectionIds) || input.collectionIds.length > MAX_ITEMS) invalid();
  const owners = input.collectionIds.map(uuid), ownerSet = new Set(owners);
  if (owners.length !== ownerSet.size) invalid();
  await supported(client, handle, signal);
  const attachments: Mdbx2ContentAttachment[] = [], seen = new Set<string>();
  let count = 0, bytes = 0;
  // The native deleted query is global, paged just once. Charge all rows against
  // bounds, including rows outside the requested owner set, before filtering.
  for (const collectionId of owners.length ? [...owners, null] : []) {
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      active(signal);
      const page = shape(response(await client.request('content.attachments.list', { vaultHandle: handle, writeRevision: { ...expected }, collectionId, pageSize: PAGE, cursor }, 30_000)), 'collectionId,items,nextCursor,writeRevision');
      active(signal); sameRevision(page.writeRevision, expected);
      if (page.collectionId !== collectionId || !Array.isArray(page.items) || page.items.length > PAGE) invalid();
      count += page.items.length; bytes += new TextEncoder().encode(JSON.stringify(page.items)).length;
      if (count > MAX_ITEMS || bytes > MAX_CATALOG) invalid();
      for (const raw of page.items) {
        const row = summary(raw);
        if (row.deleted !== (collectionId === null) || (collectionId !== null && row.collectionId !== collectionId) || seen.has(row.attachmentId)) invalid();
        seen.add(row.attachmentId);
        if (ownerSet.has(row.collectionId)) attachments.push(row);
      }
      cursor = page.nextCursor === null ? null : text(page.nextCursor, 8192);
      if (cursor !== null) {
        if (!cursor || !page.items.length || cursors.has(cursor)) invalid(); cursors.add(cursor);
      }
    } while (cursor !== null);
  }
  active(signal); sameRevision(await client.request('vault.writeRevision', { vaultHandle: handle }, 15_000), expected); active(signal);
  return { writeRevision: expected, attachments };
}

/** Reads one selected live asset, with a revision-bound start and final revision
 * check. Caller owns returned bytes; failed/aborted reads clear temporary bytes. */
export async function readMdbx2ContentAttachmentBytes(client: Client, vaultHandle: string, input: { writeRevision: Mdbx2WriteRevision; attachment: Mdbx2ContentAttachment }, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const handle = uuid(vaultHandle), expected = revision(input.writeRevision), attachment = summary(input.attachment);
  if (attachment.deleted || attachment.storedSize > MAX_ASSET) invalid();
  await supported(client, handle, signal);
  let readHandle: string | undefined, buffer: Uint8Array<ArrayBuffer> | undefined, complete = false;
  try {
    const raw = object(await client.request('content.attachments.begin', { vaultHandle: handle, attachmentId: attachment.attachmentId, writeRevision: { ...expected } }, 120_000));
    // Capture a valid session handle before validating anything else (including
    // cancellation), so a bad envelope cannot strand a known native buffer.
    readHandle = uuid(raw.readHandle);
    active(signal);
    const begun = shape(response(raw), 'readHandle,attachmentId,fileName,mediaType,sizeBytes,maxChunkBytes,metadata,writeRevision');
    sameRevision(begun.writeRevision, expected);
    const metadata = summary(begun.metadata);
    if (FIELDS.split(',').some(key => metadata[key as keyof Mdbx2ContentAttachment] !== attachment[key as keyof Mdbx2ContentAttachment]) ||
      begun.attachmentId !== attachment.attachmentId || begun.fileName !== attachment.fileName || begun.mediaType !== attachment.mediaType || begun.sizeBytes !== attachment.storedSize || begun.maxChunkBytes !== CHUNK) invalid();
    buffer = new Uint8Array(attachment.storedSize);
    for (let offset = 0; offset < buffer.length;) {
      active(signal);
      const part = shape(response(await client.request('attachment.read.chunk', { readHandle, offset, maxBytes: CHUNK }, 30_000)), 'readHandle,attachmentId,fileName,mediaType,sizeBytes,offset,dataBase64,nextOffset,eof');
      active(signal);
      const next = Math.min(buffer.length, offset + CHUNK);
      if (part.readHandle !== readHandle || part.attachmentId !== attachment.attachmentId || part.fileName !== attachment.fileName || part.mediaType !== attachment.mediaType || part.sizeBytes !== buffer.length || part.offset !== offset || part.nextOffset !== next || part.eof !== (next === buffer.length)) invalid();
      let bytes: Uint8Array | undefined;
      try {
        bytes = base64ToBytes(text(part.dataBase64, 4 * Math.ceil(CHUNK / 3)));
        if (bytes.length !== next - offset || bytesToBase64(bytes) !== part.dataBase64) invalid();
        buffer.set(bytes, offset);
      } catch { invalid(); } finally { bytes?.fill(0); }
      offset = next;
    }
    const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    active(signal); if (actual !== attachment.contentHash) invalid();
    sameRevision(await client.request('vault.writeRevision', { vaultHandle: handle }, 15_000), expected); active(signal);
    complete = true; return buffer;
  } finally {
    if (readHandle) await client.request('attachment.read.release', { readHandle }, 5_000).catch(() => undefined);
    if (!complete || signal?.aborted) buffer?.fill(0);
    active(signal);
  }
}
