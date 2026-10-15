import { bytesToBase64 } from '../../security/encoding';
import { Mdbx2NativeHostError, type Mdbx2HostCapabilities, type Mdbx2WriteRevision } from './native-contract';
import type { Mdbx2NativeClient } from './native-client';

export type Mdbx2ContentCommand =
  | { kind: 'collection-create'; collectionId: string; title: string; parentId?: string | null }
  | { kind: 'collection-rename'; collectionId: string; title: string }
  | { kind: 'collection-move' | 'collection-restore'; collectionId: string; parentId?: string | null }
  | { kind: 'collection-delete'; collectionId: string }
  | { kind: 'collection-trash'; collectionId: string }
  | { kind: 'collection-profile-set'; collectionId: string; collectionTypeId: string; payloadSchemaVersion: number; allowedObjectTypeIds: readonly string[]; requiredCapabilityIds: readonly string[]; assetId: string }
  | { kind: 'collection-presentation'; collectionId: string; favorite: boolean; archived: boolean; iconRef: string | null }
  | { kind: 'object-create' | 'object-update'; objectId: string; collectionId: string; objectTypeId: string; title: string; payloadJson: string }
  | { kind: 'object-delete' | 'object-restore'; objectId: string; collectionId: string }
  | { kind: 'object-move'; objectId: string; collectionId: string; targetCollectionId: string }
  | { kind: 'label-create'; labelId: string; collectionId: string; name: string; payloadJson: string; payloadSchemaVersion: number }
  | { kind: 'label-update'; labelId: string; name: string; payloadJson: string; payloadSchemaVersion: number }
  | { kind: 'label-delete'; labelId: string }
  | { kind: 'label-assign'; assignmentId: string; objectId: string; labelId: string }
  | { kind: 'label-unassign'; assignmentId: string }
  | { kind: 'relation-create'; relationId: string; sourceObjectId: string; targetObjectId: string; relationKind: string; payloadJson: string; payloadSchemaVersion: number }
  | { kind: 'relation-update'; relationId: string; relationKind: string; payloadJson: string; payloadSchemaVersion: number }
  | { kind: 'relation-delete'; relationId: string };
export type Mdbx2ContentAttachment =
  | { kind: 'create'; attachmentId: string; collectionId: string; objectId?: string | null; fileName: string; mediaType?: string | null; assetId: string }
  | { kind: 'replace'; attachmentId: string; assetId: string }
  | { kind: 'rename'; attachmentId: string; fileName: string; mediaType?: string | null }
  | { kind: 'delete'; attachmentId: string };
export interface Mdbx2ContentWriteInput {
  operationId: string;
  writeRevision: Mdbx2WriteRevision;
  plan: { commands: readonly Mdbx2ContentCommand[]; attachments: readonly Mdbx2ContentAttachment[] };
  assets: readonly { id: string; bytes: Uint8Array }[];
}
export interface Mdbx2ContentWriteReceipt { operationId: string; commitId: string; alreadyCommitted: boolean }
export function requireMdbx2ContentWriteCapabilities(caps: Mdbx2HostCapabilities, retainedFolderTrash = false, collectionProfileWrite = false): void {
  if (!caps.supportsContentWrite || !caps.supportsVaultWriteRevision) throw new Mdbx2NativeHostError('content-write-host-update-required', '当前 MDBX 引擎不支持安全接收内容，请更新后重试。');
  if (retainedFolderTrash && !caps.supportsRetainedFolderTrash) throw new Mdbx2NativeHostError('content-write-host-update-required', '当前 MDBX 引擎不支持保留文件夹附件，请更新后重试。');
  if (collectionProfileWrite && !caps.supportsCollectionProfileWrite) throw new Mdbx2NativeHostError('content-write-host-update-required', '当前 MDBX 引擎不支持安全恢复文件夹配置，请更新后重试。');
}
export class Mdbx2ContentWriteOutcomeUnknownError extends Mdbx2NativeHostError {
  constructor(readonly operationId: string) {
    super('content-write-outcome-unknown', 'MDBX 写入结果尚未确认，请使用相同操作和原始数据重试以恢复回执。', true);
  }
}

const MAX_PLAN = 8 * 1024 * 1024, MAX_ASSETS = 64 * 1024 * 1024, CHUNK = 256 * 1024;
const encoder = new TextEncoder();
function invalid(): never { throw new Mdbx2NativeHostError('content-write-invalid', 'MDBX 写入数据或响应无效。'); }
function shape(value: unknown, required: string, optional = ''): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>, fields = required.split(','), allowed = [...fields, ...optional.split(',')];
  if (fields.some(key => !Object.prototype.hasOwnProperty.call(row, key)) || Object.keys(row).some(key => !allowed.includes(key))) invalid();
  return row;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) invalid();
  return value;
}
function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value) || value.length > maximum) invalid();
  const encoded = encoder.encode(value);
  try { if (encoded.length > maximum || new TextDecoder('utf-8', { ignoreBOM: true }).decode(encoded) !== value) invalid(); }
  finally { encoded.fill(0); }
  return value;
}
function integer(value: unknown, maximum: number, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid();
  return value as number;
}
const commands: Record<Mdbx2ContentCommand['kind'], [string, string?]> = {
  'collection-create': ['collectionId,title', 'parentId'], 'collection-rename': ['collectionId,title'],
  'collection-move': ['collectionId', 'parentId'], 'collection-restore': ['collectionId', 'parentId'], 'collection-delete': ['collectionId'],
  'collection-trash': ['collectionId'],
  'collection-profile-set': ['collectionId,collectionTypeId,payloadSchemaVersion,allowedObjectTypeIds,requiredCapabilityIds,assetId'],
  'collection-presentation': ['collectionId,favorite,archived,iconRef'],
  'object-create': ['objectId,collectionId,objectTypeId,title,payloadJson'], 'object-update': ['objectId,collectionId,objectTypeId,title,payloadJson'],
  'object-delete': ['objectId,collectionId'], 'object-restore': ['objectId,collectionId'], 'object-move': ['objectId,collectionId,targetCollectionId'],
  'label-create': ['labelId,collectionId,name,payloadJson,payloadSchemaVersion'], 'label-update': ['labelId,name,payloadJson,payloadSchemaVersion'],
  'label-delete': ['labelId'], 'label-assign': ['assignmentId,objectId,labelId'], 'label-unassign': ['assignmentId'],
  'relation-create': ['relationId,sourceObjectId,targetObjectId,relationKind,payloadJson,payloadSchemaVersion'],
  'relation-update': ['relationId,relationKind,payloadJson,payloadSchemaVersion'], 'relation-delete': ['relationId']
};
const attachments: Record<Mdbx2ContentAttachment['kind'], [string, string?]> = {
  create: ['attachmentId,collectionId,fileName,assetId', 'objectId,mediaType'], replace: ['attachmentId,assetId'],
  rename: ['attachmentId,fileName', 'mediaType'], delete: ['attachmentId']
};
function command(value: unknown, fields: Record<string, [string, string?]>): Record<string, unknown> {
  if (!value || typeof value !== 'object') invalid();
  const kind = text((value as Record<string, unknown>).kind, 32);
  if (!Object.prototype.hasOwnProperty.call(fields, kind)) invalid();
  const [required, optional] = fields[kind], row = shape(value, `kind,${required}`, optional), result: Record<string, unknown> = { kind };
  for (const key of [...required.split(','), ...(optional?.split(',') || [])]) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    const value = row[key];
    if ((key === 'parentId' || key === 'objectId' || key === 'mediaType') && optional?.split(',').includes(key) && value === null) result[key] = null;
    else if (key === 'favorite' || key === 'archived') { if (typeof value !== 'boolean') invalid(); result[key] = value; }
    else if (key === 'iconRef') result[key] = value === null ? null : text(value, 4096);
    else if (key === 'collectionTypeId') result[key] = text(value, 512);
    else if (key === 'allowedObjectTypeIds' || key === 'requiredCapabilityIds') {
      if (!Array.isArray(value) || value.length > (key === 'allowedObjectTypeIds' ? 256 : 128)) invalid();
      const values = value.map(v => text(v, 512)); if (new Set(values).size !== values.length) invalid(); result[key] = values;
    }
    else if (key === 'objectTypeId' || key === 'relationKind') result[key] = text(value, 128);
    else if (key.endsWith('Id')) result[key] = uuid(value);
    else if (key === 'payloadSchemaVersion') result[key] = integer(value, 0xffff_ffff, 1);
    else result[key] = text(value, key === 'payloadJson' ? 1024 * 1024 : key === 'fileName' || key === 'mediaType' ? 512 : 4096, key === 'title' || key === 'name' || key === 'mediaType');
  }
  return result;
}

/** Snapshot before awaiting. Never parse opaque payload JSON, including native
 * large numbers. A cancelled in-flight finish may commit: return a valid receipt
 * if received, otherwise require an identical retry with the same operation ID. */
export async function writeMdbx2Content(
  client: Pick<Mdbx2NativeClient, 'hello' | 'request'>, vaultHandle: string, input: Mdbx2ContentWriteInput, signal?: AbortSignal
): Promise<Mdbx2ContentWriteReceipt> {
  const handle = uuid(vaultHandle), inputRow = shape(input, 'operationId,writeRevision,plan,assets'), operationId = uuid(inputRow.operationId);
  const revision = shape(inputRow.writeRevision, 'vaultId,revisionSha256');
  const writeRevision = { vaultId: uuid(revision.vaultId), revisionSha256: text(revision.revisionSha256, 64) };
  if (!/^[a-f0-9]{64}$/.test(writeRevision.revisionSha256)) invalid();
  const rawPlan = shape(inputRow.plan, 'commands,attachments');
  if (!Array.isArray(rawPlan.commands) || !Array.isArray(rawPlan.attachments) || rawPlan.commands.length > 128 || rawPlan.attachments.length > 64 || !(rawPlan.commands.length + rawPlan.attachments.length)) invalid();
  const plan = { commands: rawPlan.commands.map(row => command(row, commands)), attachments: rawPlan.attachments.map(row => command(row, attachments)) };
  if (!Array.isArray(inputRow.assets) || inputRow.assets.length > 64) invalid();
  let total = 0;
  const sources = inputRow.assets.map(value => {
    const row = shape(value, 'id,bytes'), id = uuid(row.id);
    if (!(row.bytes instanceof Uint8Array)) invalid();
    total += row.bytes.byteLength; if (total > MAX_ASSETS) invalid();
    return { id, bytes: row.bytes };
  });
  const byId = new Map(sources.map(row => [row.id, row]));
  if (byId.size !== sources.length) invalid();
  const used = new Set<string>(); let copies = 0, profileCopies = 0;
  for (const row of [...plan.commands, ...plan.attachments]) if (row.assetId) {
    const id = row.assetId as string, source = byId.get(id); if (!source) invalid();
    if (row.kind === 'collection-profile-set') { profileCopies += source.bytes.byteLength; if (source.bytes.byteLength > 1024 * 1024 || profileCopies > 8 * 1024 * 1024) invalid(); }
    used.add(id); copies += source.bytes.byteLength; if (copies > MAX_ASSETS) invalid();
  }
  if (used.size !== sources.length) invalid();
  const planBytes = encoder.encode(JSON.stringify(plan));
  const parts: { id: string; bytes: Uint8Array }[] = [{ id: 'plan', bytes: planBytes }];
  let writeHandle: string | undefined, finishSent = false, confirmed = false;
  const active = () => { if (signal?.aborted) throw new DOMException('MDBX content write cancelled before commit', 'AbortError'); };
  try {
    if (planBytes.length > MAX_PLAN) invalid();
    for (const source of sources) parts.push({ id: source.id, bytes: new Uint8Array(source.bytes) });
    active();
    const caps = await client.hello(15_000, handle); active();
    requireMdbx2ContentWriteCapabilities(caps, plan.commands.some(row => row.kind === 'collection-trash'), plan.commands.some(row => row.kind === 'collection-profile-set' || row.kind === 'collection-presentation'));
    const descriptors = [];
    for (const part of parts) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', part.bytes as Uint8Array<ArrayBuffer>)); active();
      descriptors.push({ id: part.id, sizeBytes: part.bytes.length, sha256: [...digest].map(n => n.toString(16).padStart(2, '0')).join('') });
    }
    const { id: _plan, ...descriptor } = descriptors[0];
    const begun = shape(await client.request('content.write.begin', { vaultHandle: handle, operationId, writeRevision, plan: descriptor, assets: descriptors.slice(1) }, 30_000), 'writeHandle,maxChunkBytes');
    writeHandle = uuid(begun.writeHandle); const limit = integer(begun.maxChunkBytes, CHUNK, 1); active();
    for (const part of parts) for (let offset = 0; offset < part.bytes.length; offset += limit) {
      active(); const end = Math.min(offset + limit, part.bytes.length);
      const response = shape(await client.request('content.write.chunk', { vaultHandle: handle, writeHandle, partId: part.id, offset, dataBase64: bytesToBase64(part.bytes.subarray(offset, end)) }, 30_000), 'writeHandle,partId,nextOffset,repeated');
      if (response.writeHandle !== writeHandle || response.partId !== part.id || response.nextOffset !== end || typeof response.repeated !== 'boolean') invalid();
      active();
    }
    active(); finishSent = true;
    const result = shape(await client.request('content.write.finish', { vaultHandle: handle, writeHandle }, 120_000), 'operationId,commitId,alreadyCommitted');
    if (uuid(result.operationId) !== operationId || typeof result.alreadyCommitted !== 'boolean') invalid();
    const receipt = { operationId, commitId: uuid(result.commitId), alreadyCommitted: result.alreadyCommitted };
    confirmed = true; return receipt;
  } catch (error) {
    // Only this exact native error proves the transaction guard rejected the
    // operation before applying it. Transport/storage failures remain ambiguous.
    if (finishSent && error instanceof Mdbx2NativeHostError && error.code === 'content-write-stale') {
      throw new Mdbx2NativeHostError('content-write-stale', 'MDBX 已被其他操作修改，请重新读取内容后再同步。', true);
    }
    if (finishSent) throw new Mdbx2ContentWriteOutcomeUnknownError(operationId);
    if (error instanceof Mdbx2NativeHostError || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    throw new Mdbx2NativeHostError('content-write-staging-failed', 'MDBX 内容暂存失败，请重试。');
  } finally {
    for (const part of parts) part.bytes.fill(0);
    if (writeHandle && !confirmed) await client.request('content.write.abort', { vaultHandle: handle, writeHandle }, 5_000).catch(() => undefined);
  }
}
