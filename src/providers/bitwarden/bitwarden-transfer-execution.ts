import { validateBitwardenCopyFiles, type BitwardenCipherCopyRecord, type BitwardenCopyProgress } from '../../core/bitwarden-transfer-journal';
import type { LocalItemAttachment } from '../../core/local-transfer';
import type { BitwardenSymmetricKey } from './bitwarden-crypto';
import type { ProviderAccount } from '../../core/model';
import type { BitwardenSessionConfig } from './bitwarden-client';
import { hasBitwardenTransferMarker, verifyBitwardenTransferCipher } from './bitwarden-transfer-cipher';
import { mdbx2TransferUuid } from '../mdbx2/mdbx2-transfer-identity';
import { parseLosslessJson } from '../../core/lossless-json';

export interface BitwardenCopyStore {
  /** Reads must require an unlocked vault and the original target binding. */
  read(copyId: string): Promise<BitwardenCipherCopyRecord>;
  advance(copyId: string, expectedRevision: number, patch: BitwardenCopyProgress): Promise<BitwardenCipherCopyRecord>;
}
export interface BitwardenCopySessionStore extends BitwardenCopyStore {
  account(copyId: string): Promise<ProviderAccount>;
  /** CAS only rotating tokens; must preserve newer credentials and unrelated settings. */
  saveSession(copyId: string, previous: ProviderAccount, next: BitwardenSessionConfig): Promise<ProviderAccount>;
}
export interface BitwardenCopyRemote {
  /** Full authenticated scan, including trash, never just a title search. */
  list(signal?: AbortSignal): Promise<Record<string, unknown>[]>;
  /** Organization keys are borrowed only for marker discovery, never target writes. */
  ownerKeyFor?(raw: Record<string, unknown>): BitwardenSymmetricKey;
  read(remoteId: string, signal?: AbortSignal): Promise<Record<string, unknown> | null>;
  create(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
  /** Must use the existing durable attachment journal for this operation ID. */
  upload(remoteId: string, operationId: string, file: LocalItemAttachment, signal?: AbortSignal): Promise<string>;
  /** A fresh authenticated download, not the upload buffer or cached expectation. */
  readFile(remoteId: string, attachmentId: string, signal?: AbortSignal): Promise<{ fileName: string; bytes: Uint8Array }>;
}

/** Execute a previously encrypted, immutable full-Cipher intent. It never
 * stages its own unreviewed plan, deletes a source, or claims whole-batch adoption. */
export async function executeBitwardenCipherCopy(copyId: string, store: BitwardenCopyStore, remote: BitwardenCopyRemote,
  targetOwnerKey: BitwardenSymmetricKey, signal?: AbortSignal): Promise<BitwardenCipherCopyRecord> {
  signal?.throwIfAborted(); let record = await store.read(copyId);
  if (record.stage === 'verified') return record;
  await validateBitwardenCopyFiles(record);
  const payload = parseLosslessJson(record.prepared.payloadJson) as Record<string, unknown>;
  await verifyBitwardenTransferCipher(record.prepared, { ...payload, id: `preflight-${copyId}`, revisionDate: '1970-01-01T00:00:00.000Z' }, targetOwnerKey);
  const check = async () => {
    signal?.throwIfAborted();
    const current = await store.read(copyId);
    if (current.revision !== record.revision) throw new Error('Bitwarden 迁移正在另一处恢复，请刷新后重试。');
  };
  const read = async (remoteId: string) => {
    await check();
    const raw = await remote.read(remoteId, signal);
    if (!raw || (raw.id ?? raw.Id) !== remoteId || raw.id !== undefined && raw.Id !== undefined)
      throw new Error('Bitwarden 迁移副本身份已变化或不可访问，已停止操作并保留来源。');
    return raw;
  };
  if (record.stage === 'prepared' || record.stage === 'attempted') {
    const matches: Record<string, unknown>[] = [];
    await check();
    const list = await remote.list(signal), ids = new Set<string>();
    if (!Array.isArray(list) || list.length > 50_000) throw new Error('Bitwarden 完整迁移清单超过上限或无效。');
    for (const raw of list) {
      signal?.throwIfAborted();
      const id = raw?.id ?? raw?.Id;
      if (typeof id !== 'string' || !id || id.length > 512 || ids.has(id) || raw.id !== undefined && raw.Id !== undefined)
        throw new Error('Bitwarden 迁移清单身份重复或无效。');
      ids.add(id);
      if (await hasBitwardenTransferMarker(record.prepared, raw, remote.ownerKeyFor?.(raw) ?? targetOwnerKey)) matches.push(raw);
      if (matches.length > 1) throw new Error('Bitwarden 迁移副本匹配不唯一，已停止再次创建；来源与副本均已保留。');
    }
    await check();
    let raw = matches[0];
    if (!raw) {
      if (record.stage === 'attempted') throw new Error('Bitwarden 上次迁移创建结果未知，已停止重试以避免重复记录。');
      record = await store.advance(copyId, record.revision, { stage: 'attempted', attachmentReceipts: [] });
      await check();
      raw = await remote.create(payload, signal);
    }
    await verifyBitwardenTransferCipher(record.prepared, raw, targetOwnerKey); await check();
    record = await store.advance(copyId, record.revision, { stage: 'created', remoteId: String(raw.id ?? raw.Id), attachmentReceipts: [] });
  }
  const remoteId = record.remoteId!;
  let raw = await read(remoteId);
  await verifyBitwardenTransferCipher(record.prepared, raw, targetOwnerKey); await check();
  const attachmentIds = new Set<string>();
  for (const file of record.files) {
    await check();
    const operationId = await mdbx2TransferUuid(copyId, `attachment:${file.attachmentId}`);
    const receipt = record.attachmentReceipts.find(row => row.sourceAttachmentId === file.attachmentId);
    const id = receipt?.targetAttachmentId ?? await remote.upload(remoteId, operationId, file, signal); await check();
    if (!id || attachmentIds.has(id)) throw new Error('Bitwarden 迁移附件返回了重复身份。');
    const actual = await remote.readFile(remoteId, id, signal);
    try {
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', actual.bytes as BufferSource))].map(n => n.toString(16).padStart(2, '0')).join('');
      if (actual.fileName !== file.fileName || actual.bytes.length !== file.sizeBytes || digest !== file.sha256)
        throw new Error('Bitwarden 迁移附件回读不一致，来源已保留。');
    } finally { actual.bytes.fill(0); }
    await check();
    attachmentIds.add(id);
    if (!receipt) record = await store.advance(copyId, record.revision, { stage: 'created', remoteId,
      attachmentReceipts: [...record.attachmentReceipts, { sourceAttachmentId: file.attachmentId, targetAttachmentId: id }] });
  }
  // Re-read the Cipher after file uploads: a peer may have edited its content.
  raw = await read(remoteId);
  const items = await verifyBitwardenTransferCipher(record.prepared, raw, targetOwnerKey); await check();
  const attachments = (raw.attachments ?? raw.Attachments ?? []) as unknown;
  if (!Array.isArray(attachments) || attachments.length !== attachmentIds.size
    || [...attachmentIds].some(id => !attachments.some(row => row && (row.id ?? row.Id) === id)))
    throw new Error('Bitwarden 迁移副本附件清单未确认，已保留恢复记录。');
  return store.advance(copyId, record.revision, { stage: 'verified', remoteId, verifiedItems: items, attachmentReceipts: record.attachmentReceipts });
}
