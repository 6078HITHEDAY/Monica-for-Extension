import type { LocalItemAttachment } from '../../core/local-transfer';
import type { ProviderAccount } from '../../core/model';
import { base64ToBytes } from '../../security/encoding';
import { BitwardenClient, type BitwardenSessionConfig } from './bitwarden-client';
import { BitwardenAttachmentDownloadService } from './bitwarden-attachments';
import { BitwardenAttachmentMutationService } from './bitwarden-attachment-mutations';
import { resolveBitwardenOrganizationKeys } from './bitwarden-organization';
import type { BitwardenSymmetricKey } from './bitwarden-crypto';
import type { BitwardenCopyRemote, BitwardenCopySessionStore } from './bitwarden-transfer-execution';
import { verifyBitwardenTransferCipher } from './bitwarden-transfer-cipher';
import { PROVIDER_ATTACHMENT_CHUNK_BYTES } from '../attachments/attachment-contract';

/** Production client/attachment adapter. The caller holds the provider queue,
 * binds the abort signal to lock, and disposes keys in a finally block. */
export class BitwardenTransferRemote implements BitwardenCopyRemote {
  private keys = new Map<string, BitwardenSymmetricKey>();
  private ownerKey?: BitwardenSymmetricKey;
  constructor(private readonly copyId: string, private readonly store: BitwardenCopySessionStore,
    private readonly client: BitwardenClient, private readonly downloads: BitwardenAttachmentDownloadService,
    private readonly mutations: BitwardenAttachmentMutationService) {}

  dispose() {
    for (const key of [...this.keys.values(), ...(this.ownerKey ? [this.ownerKey] : [])]) { key.encKey.fill(0); key.macKey.fill(0); }
    this.keys.clear(); this.ownerKey = undefined;
  }

  private async account(signal?: AbortSignal) { signal?.throwIfAborted(); return this.store.account(this.copyId); }
  private async save(account: ProviderAccount, session: BitwardenSessionConfig, signal?: AbortSignal) {
    signal?.throwIfAborted(); return this.store.saveSession(this.copyId, account, session);
  }

  async list(signal?: AbortSignal) {
    const account = await this.account(signal);
    const result = await this.client.sync(account.config as BitwardenSessionConfig, signal);
    await this.save(account, result.session, signal);
    this.dispose(); this.ownerKey = this.client.vaultKey(result.session);
    this.keys = (await resolveBitwardenOrganizationKeys(result.payload, this.ownerKey)).keys;
    const list = result.payload.ciphers ?? result.payload.Ciphers;
    if (!Array.isArray(list) || list.length > 50_000 || result.payload.ciphers !== undefined && result.payload.Ciphers !== undefined)
      throw new Error('Bitwarden 完整迁移清单无效，不能将不完整同步视为空库。');
    // Keep trash and organization entries in the scan. A moved/trashed copy must
    // prevent a second create; an unreadable organization fails closed.
    return list as Record<string, unknown>[];
  }

  ownerKeyFor(raw: Record<string, unknown>): BitwardenSymmetricKey {
    const org = raw.organizationId ?? raw.OrganizationId;
    const key = org == null ? this.ownerKey : typeof org === 'string' ? this.keys.get(org) : undefined;
    if (!key) throw new Error('Bitwarden 迁移清单存在无法核对的组织记录，已停止再次创建。');
    return key;
  }

  async read(remoteId: string, signal?: AbortSignal) {
    const account = await this.account(signal), result = await this.client.getCipherDetails(account.config as BitwardenSessionConfig, remoteId, signal);
    await this.save(account, result.session, signal);
    if (result.payload && ((result.payload.id ?? result.payload.Id) !== remoteId || result.payload.id !== undefined && result.payload.Id !== undefined))
      throw new Error('Bitwarden 迁移回读身份不匹配。');
    return result.payload;
  }

  async create(payload: Record<string, unknown>, signal?: AbortSignal) {
    const record = await this.store.read(this.copyId);
    if (record.stage !== 'attempted' || JSON.stringify(payload) !== record.prepared.payloadJson)
      throw new Error('Bitwarden 迁移创建缺少已持久保存的原始计划。');
    const account = await this.account(signal);
    const result = await this.client.createCipherOnce(account.config as BitwardenSessionConfig, payload, signal);
    await this.save(account, result.session, signal); return result.payload;
  }

  private async context(remoteId: string, signal?: AbortSignal) {
    const record = await this.store.read(this.copyId);
    if (record.stage !== 'created' || record.remoteId !== remoteId) throw new Error('Bitwarden 附件迁移缺少已确认的副本。');
    const rawCipher = await this.read(remoteId, signal);
    if (!rawCipher) throw new Error('Bitwarden 迁移副本不可访问。');
    const account = await this.account(signal), session = account.config as BitwardenSessionConfig, key = this.client.vaultKey(session);
    try { await verifyBitwardenTransferCipher(record.prepared, rawCipher, key); }
    finally { key.encKey.fill(0); key.macKey.fill(0); }
    return { account, providerId: account.id, itemId: `bitwarden:${account.id}:${remoteId}`, session, rawCipher, requireReadableFileName: true };
  }

  async upload(remoteId: string, operationId: string, file: LocalItemAttachment, signal?: AbortSignal): Promise<string> {
    const context = await this.context(remoteId, signal), bytes = base64ToBytes(file.dataBase64);
    try {
      const result = await this.mutations.upload({ ...context, operationId, fileName: file.fileName, bytes, sha256: file.sha256, signal });
      await this.save(context.account, result.session, signal);
      if (!result.attachment?.attachmentId || result.attachment.fileName !== file.fileName) throw new Error('Bitwarden 迁移附件未确认。');
      return result.attachment.attachmentId;
    } finally { bytes.fill(0); }
  }

  async readFile(remoteId: string, attachmentId: string, signal?: AbortSignal) {
    const context = await this.context(remoteId, signal);
    const opened = await this.downloads.beginDownload({ ...context, attachmentId, signal });
    let bytes: Uint8Array | undefined;
    try {
      await this.save(context.account, opened.session, signal);
      if (opened.attachmentId !== attachmentId || !Number.isSafeInteger(opened.sizeBytes) || opened.sizeBytes < 0 || opened.sizeBytes > 16 * 1024 * 1024)
        throw new Error('Bitwarden 迁移附件身份或大小无效。');
      bytes = new Uint8Array(opened.sizeBytes); let offset = 0;
      do {
        signal?.throwIfAborted();
        const chunk = this.downloads.readChunk(context.providerId, opened.readHandle, offset, PROVIDER_ATTACHMENT_CHUNK_BYTES);
        try {
          if (chunk.readHandle !== opened.readHandle || chunk.attachmentId !== attachmentId || chunk.fileName !== opened.fileName
            || chunk.sizeBytes !== opened.sizeBytes || chunk.offset !== offset || chunk.nextOffset !== offset + chunk.bytes.length
            || chunk.nextOffset > bytes.length || chunk.eof !== (chunk.nextOffset === bytes.length) || !chunk.bytes.length && !chunk.eof)
            throw new Error('Bitwarden 迁移附件分块回读无效。');
          bytes.set(chunk.bytes, offset); offset = chunk.nextOffset;
        } finally { chunk.bytes.fill(0); }
      } while (offset < bytes.length);
      return { fileName: opened.fileName, bytes };
    } catch (error) { bytes?.fill(0); throw error; }
    finally { this.downloads.release(context.providerId, opened.readHandle); }
  }
}
