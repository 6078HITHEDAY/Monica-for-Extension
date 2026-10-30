import type { ProviderAccount, VaultItem } from '../../core/model';
import { bitwardenProjectCipherId } from '../../core/bitwarden-project-removal-local';
import { MDBX2_ATTACHMENT_MAX_BYTES, PROVIDER_ATTACHMENT_CHUNK_BYTES, type ProviderAttachmentSummary } from '../attachments/attachment-contract';
import type { TransferAttachmentSource } from '../attachments/transfer-attachment-source';
import type { BitwardenAttachmentDownloadService, BitwardenAttachmentVaultContext } from './bitwarden-attachments';
import type { BitwardenSessionConfig } from './bitwarden-client';

/** Reuses authenticated downloads for transfer, including parent-Cipher files
 * of Passkey/OTP projections. No decrypted file or key cache survives a call. */
export class BitwardenTransferAttachmentSource implements TransferAttachmentSource {
  constructor(
    private readonly downloads: Pick<BitwardenAttachmentDownloadService, 'listAttachments' | 'beginDownload' | 'readChunk' | 'release'>,
    private readonly context: (account: ProviderAccount, item: VaultItem) => Promise<BitwardenAttachmentVaultContext>,
    private readonly saveSession: (account: ProviderAccount, session: BitwardenSessionConfig) => Promise<void>
  ) {}

  async list(account: ProviderAccount, item: VaultItem): Promise<ProviderAttachmentSummary[]> {
    return this.withContext(account, item, async context => {
      const result: ProviderAttachmentSummary[] = [], cursors = new Set<string>(), ids = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await this.downloads.listAttachments(context, { cursor, pageSize: 50 });
        for (const attachment of page.items) {
          if (!attachment.attachmentId || ids.has(attachment.attachmentId) || result.length >= 512)
            throw new Error('Bitwarden 附件清单无效，来源项目已保留。');
          ids.add(attachment.attachmentId); result.push(attachment);
        }
        cursor = page.nextCursor;
        if (cursor && (!page.items.length || cursors.has(cursor))) throw new Error('Bitwarden 附件分页没有前进。');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      await this.saveSession(account, context.session);
      return result;
    });
  }

  async read(account: ProviderAccount, item: VaultItem,
    attachment: Pick<ProviderAttachmentSummary, 'attachmentId' | 'fileName'>): Promise<Uint8Array> {
    return this.withContext(account, item, async context => {
      const opened = await this.downloads.beginDownload({ ...context, attachmentId: attachment.attachmentId });
      let bytes: Uint8Array | undefined;
      try {
        if (opened.attachmentId !== attachment.attachmentId || opened.fileName !== attachment.fileName
          || !Number.isSafeInteger(opened.sizeBytes) || opened.sizeBytes < 0 || opened.sizeBytes > MDBX2_ATTACHMENT_MAX_BYTES)
          throw new Error('Bitwarden 附件已变化或明文超过 64 MiB 传输上限。');
        await this.saveSession(account, opened.session);
        bytes = new Uint8Array(opened.sizeBytes);
        let offset = 0;
        do {
          const chunk = this.downloads.readChunk(account.id, opened.readHandle, offset, PROVIDER_ATTACHMENT_CHUNK_BYTES);
          try {
            if (chunk.readHandle !== opened.readHandle || chunk.attachmentId !== attachment.attachmentId
              || chunk.fileName !== opened.fileName || chunk.sizeBytes !== opened.sizeBytes || chunk.offset !== offset
              || chunk.nextOffset !== offset + chunk.bytes.length || chunk.nextOffset > bytes.length
              || chunk.eof !== (chunk.nextOffset === bytes.length) || (!chunk.bytes.length && !chunk.eof))
              throw new Error('Bitwarden 附件读取边界或身份无效。');
            bytes.set(chunk.bytes, offset); offset = chunk.nextOffset;
          } finally { chunk.bytes.fill(0); }
        } while (offset < bytes.length);
        return bytes;
      } catch (error) { bytes?.fill(0); throw error; }
      finally { this.downloads.release(account.id, opened.readHandle); }
    });
  }

  private async withContext<T>(account: ProviderAccount, item: VaultItem,
    task: (context: BitwardenAttachmentVaultContext) => Promise<T>): Promise<T> {
    if (account.kind !== 'bitwarden' || !account.enabled || item.deletedAt) throw new Error('Bitwarden 附件来源不可用。');
    const ref = item.providerRefs.find(row => row.providerId === account.id);
    if (!ref?.remoteId || !ref.revision) throw new Error('Bitwarden 项目缺少已同步版本，请先同步后再传输。');
    const context = await this.context(account, item);
    try {
      const raw = context.rawCipher;
      const revision = raw.RevisionDate ?? raw.revisionDate;
      // The Cipher codec projects ISO timestamps to millisecond precision.
      const revisionTime = typeof revision === 'string' ? Date.parse(revision) : NaN;
      if (context.providerId !== account.id || context.itemId !== item.id
        || (raw.Id ?? raw.id) !== bitwardenProjectCipherId(ref.remoteId)
        || !Number.isFinite(revisionTime) || revisionTime !== Date.parse(ref.revision) || raw.DeletedDate || raw.deletedDate)
        throw new Error('Bitwarden 来源项目已变化，请同步后重新预览传输。');
      return await task({ ...context, requireReadableFileName: true });
    } finally {
      context.organizationKeys?.forEach(key => { key.encKey.fill(0); key.macKey.fill(0); });
    }
  }
}
