import { Mdbx2NativeHostError, type Mdbx2WriteRevision } from './native-contract';
import type { Mdbx2NativeClient } from './native-client';

export interface Mdbx2ContentWriteAnchor {
  writeRevision: Mdbx2WriteRevision;
  branches: { branchId: string; branchName: string; headCommitId: string }[];
}
const encoder = new TextEncoder();
function invalid(): never { throw new Mdbx2NativeHostError('content-write-anchor-invalid', 'MDBX 分步恢复的版本依据不完整，请重新读取。'); }
function shape(value: unknown, fields: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>, keys = fields.split(',');
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(row, key))) invalid();
  return row;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)) invalid();
  return value;
}
function revision(value: unknown): Mdbx2WriteRevision {
  const row = shape(value, 'vaultId,revisionSha256');
  if (typeof row.revisionSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.revisionSha256)) invalid();
  return { vaultId: uuid(row.vaultId), revisionSha256: row.revisionSha256 };
}
function snapshot(value: unknown): Mdbx2ContentWriteAnchor {
  const row = shape(value, 'writeRevision,branches');
  if (!Array.isArray(row.branches) || !row.branches.length || row.branches.length > 1024) invalid();
  const ids = new Set<string>();
  const branches = row.branches.map(value => {
    const branch = shape(value, 'branchId,branchName,headCommitId');
    const branchId = uuid(branch.branchId), headCommitId = uuid(branch.headCommitId), branchName = branch.branchName;
    if (typeof branchName !== 'string' || !branchName || branchName.length > 4096 || ids.has(branchId)) invalid();
    const bytes = encoder.encode(branchName);
    if (bytes.length > 4096 || new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) !== branchName) invalid();
    ids.add(branchId);
    return { branchId, branchName, headCommitId };
  });
  if (branches.filter(b => b.branchName === 'main').length !== 1) invalid();
  branches.sort((a, b) => a.branchId < b.branchId ? -1 : a.branchId > b.branchId ? 1 : 0);
  const result = { writeRevision: revision(row.writeRevision), branches };
  if (encoder.encode(JSON.stringify(result)).length > 512 * 1024) invalid();
  return result;
}
/** Exactly the native write_revision_hash encoding: length-prefixed UTF-8,
 * little-endian u64 lengths, and every branch ordered by its UUID. */
async function hash(anchor: Mdbx2ContentWriteAnchor): Promise<string> {
  const parts = ['monica-extension-write-revision-v1', anchor.writeRevision.vaultId,
    ...anchor.branches.flatMap(b => [b.branchId, b.branchName, b.headCommitId])].map(s => encoder.encode(s));
  const buffer = new Uint8Array(parts.reduce((n, b) => n + 8 + b.length, 0));
  let offset = 0;
  for (const bytes of parts) {
    new DataView(buffer.buffer).setBigUint64(offset, BigInt(bytes.length), true);
    buffer.set(bytes, offset + 8); offset += 8 + bytes.length;
  }
  try { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))).map(b => b.toString(16).padStart(2, '0')).join(''); }
  finally { buffer.fill(0); parts.forEach(b => b.fill(0)); }
}
export async function validateMdbx2ContentWriteAnchor(value: unknown): Promise<Mdbx2ContentWriteAnchor> {
  const result = snapshot(value);
  if (await hash(result) !== result.writeRevision.revisionSha256) invalid();
  return result;
}
export async function readMdbx2ContentWriteAnchor(client: Pick<Mdbx2NativeClient, 'hello' | 'request'>,
  vaultHandle: string, expected: Mdbx2WriteRevision, signal?: AbortSignal): Promise<Mdbx2ContentWriteAnchor> {
  const handle = uuid(vaultHandle), before = revision(expected);
  const active = () => { if (signal?.aborted) throw new DOMException('MDBX write anchor read cancelled', 'AbortError'); };
  active(); const caps = await client.hello(15_000, handle); active();
  if (!caps.supportsContentWriteAnchor || !caps.supportsContentWrite || !caps.supportsVaultWriteRevision)
    throw new Mdbx2NativeHostError('content-write-host-update-required', '当前 MDBX 引擎不支持安全分步恢复，请更新后重试。');
  const response = await client.request('content.write.anchor', { vaultHandle: handle }, 15_000); active();
  const anchor = await validateMdbx2ContentWriteAnchor(response); active();
  if (anchor.writeRevision.vaultId !== before.vaultId || anchor.writeRevision.revisionSha256 !== before.revisionSha256)
    throw new Mdbx2NativeHostError('content-write-stale', 'MDBX 已被其他操作修改，请重新读取内容后再同步。', true);
  return anchor;
}
/** Predict only the commit we just confirmed. Never read a newer live revision
 * to continue an interrupted sequence: that could accept and overwrite edits
 * made after the earlier step. Native writes still check this predicted hash. */
export async function advanceMdbx2ContentWriteAnchor(value: Mdbx2ContentWriteAnchor, commitId: string): Promise<Mdbx2ContentWriteAnchor> {
  const id = uuid(commitId), result = await validateMdbx2ContentWriteAnchor(value);
  const main = result.branches.find(b => b.branchName === 'main')!;
  main.headCommitId = id;
  result.writeRevision.revisionSha256 = await hash(result);
  return result;
}
