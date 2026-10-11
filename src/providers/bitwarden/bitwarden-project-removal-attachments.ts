import type { ProviderAccount } from '../../core/model';
import type { PasswordProjectRemovalProof } from '../../core/password-project-removal-journal';
import { sameProviderBinding } from '../../core/provider';
import type { SecureVaultService } from '../../security/secure-vault-service';
import { bitwardenProjectLocalSha256 } from '../../core/bitwarden-project-removal-local';
import { BitwardenClient, type BitwardenSessionConfig } from './bitwarden-client';
import { BitwardenAttachmentDownloadService } from './bitwarden-attachments';
import { BitwardenAttachmentMutationService } from './bitwarden-attachment-mutations';
import { resolveBitwardenOrganizationKeys } from './bitwarden-organization';
import type { BitwardenSymmetricKey } from './bitwarden-crypto';
import { PROVIDER_ATTACHMENT_CHUNK_BYTES, type ProviderAttachmentSummary } from '../attachments/attachment-contract';

/** Copies shared files with the real Bitwarden attachment recovery journal.
 * Listing sizes are encrypted lengths; only authenticated downloads provide
 * plaintext sizes. Source bytes and colliding target files are never replaced.
 */
export class BitwardenProjectRemovalAttachmentPreparation {
  private session: BitwardenSessionConfig;
  private organizationKeys = new Map<string, BitwardenSymmetricKey>();
  constructor(private readonly client: BitwardenClient, private readonly account: ProviderAccount,
    private readonly vault: SecureVaultService, private readonly downloads: BitwardenAttachmentDownloadService,
    private readonly mutations: BitwardenAttachmentMutationService, private readonly signal?: AbortSignal) {
    this.session = structuredClone(account.config) as BitwardenSessionConfig;
  }
  currentAccount(): ProviderAccount { return { ...this.account, config: structuredClone(this.session) }; }

  async prepare(operationId: string): Promise<PasswordProjectRemovalProof[]> {
    const initial = await this.vault.inspectPasswordProjectRemoval(operationId);
    const binding = initial.record.providerBindings.find(row => row.kind === 'bitwarden');
    if (!binding || !sameProviderBinding(binding, this.account)) throw new Error('Bitwarden 附件准备来源已变化。');
    if (!initial.record.ownerTransfer) return [];
    const synced = await this.client.sync(this.session, this.signal); this.session = synced.session;
    const key = this.client.vaultKey(this.session);
    try { this.organizationKeys = (await resolveBitwardenOrganizationKeys(synced.payload, key)).keys; }
    finally { key.encKey.fill(0); key.macKey.fill(0); }
    const { sourceItemId, targetItemId } = initial.record.ownerTransfer;
    const row = (id: string) => initial.items.find(row => row.id === id)!;
    const context = async (itemId: string) => {
      this.signal?.throwIfAborted();
      await this.vault.inspectPasswordProjectRemoval(operationId);
      const current = await this.vault.getProvider(this.account.id);
      if (!current?.enabled || !sameProviderBinding(current, this.account)) throw new Error('Bitwarden 附件准备来源已变化。');
      const id = row(itemId).providerRefs.find(ref => ref.providerId === this.account.id)?.remoteId;
      if (!id || /[:#]/.test(id)) throw new Error('Bitwarden 附件准备缺少原始记录。');
      const result = await this.client.getCipherDetails(this.session, id, this.signal); this.session = result.session;
      if (!result.payload || result.payload.deletedDate || result.payload.DeletedDate) throw new Error('Bitwarden 附件所属密码已删除或不可访问。');
      return { providerId: this.account.id, itemId, session: this.session, rawCipher: result.payload, organizationKeys: this.organizationKeys };
    };
    const list = async (itemId: string) => {
      const ctx = await context(itemId), all: ProviderAttachmentSummary[] = [], cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await this.downloads.listAttachments(ctx, { cursor }); all.push(...page.items);
        if (all.length > 512 || new Set(all.map(row => row.attachmentId)).size !== all.length) throw new Error('Bitwarden 附件清单无效。');
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('Bitwarden 附件分页重复。');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return all.sort((a, b) => a.attachmentId.localeCompare(b.attachmentId));
    };
    const read = async (itemId: string, attachment: ProviderAttachmentSummary) => {
      const opened = await this.downloads.beginDownload({ ...await context(itemId), attachmentId: attachment.attachmentId, signal: this.signal });
      this.session = opened.session;
      let bytes: Uint8Array<ArrayBuffer> | undefined;
      try {
        if (opened.fileName !== attachment.fileName || opened.sizeBytes > 64 * 1024 * 1024) throw new Error('Bitwarden 附件已变化或超出项目移除大小上限。');
        bytes = new Uint8Array(opened.sizeBytes); let offset = 0;
        while (offset < bytes.length) {
          this.signal?.throwIfAborted();
          const chunk = this.downloads.readChunk(this.account.id, opened.readHandle, offset, Math.min(PROVIDER_ATTACHMENT_CHUNK_BYTES, bytes.length - offset));
          try { bytes.set(chunk.bytes, offset); offset = chunk.nextOffset; } finally { chunk.bytes.fill(0); }
        }
        const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
        return { bytes, sha256 };
      } catch (cause) { bytes?.fill(0); throw cause; }
      finally { this.downloads.release(this.account.id, opened.readHandle); }
    };
    try {
      const sources = await list(sourceItemId), proof: PasswordProjectRemovalProof = { providerId: this.account.id, sourceItemId, targetItemId, attachments: [] };
      const used = new Set<string>();
      for (const source of sources) {
        const plain = await read(sourceItemId, source);
        try {
          const collisions = (await list(targetItemId)).filter(row => row.fileName === source.fileName);
          let target: ProviderAttachmentSummary | undefined;
          for (const candidate of collisions.filter(row => !used.has(row.attachmentId) && row.protected === source.protected && row.mediaType === source.mediaType)) {
            const other = await read(targetItemId, candidate);
            try { if (other.bytes.length === plain.bytes.length && other.sha256 === plain.sha256) { target = candidate; break; } }
            finally { other.bytes.fill(0); }
          }
          if (!target && collisions.length) throw new Error('保留密码存在不同内容的同名附件，原密码尚未移除。');
          const digest = await bitwardenProjectLocalSha256([operationId, this.account.id, sourceItemId, targetItemId, source.attachmentId, plain.sha256]);
          const copyId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
          // If an earlier response was lost, finish the existing attachment
          // receipt even when the successfully copied file is already listed.
          const recovery = (await this.mutations.listRecoveryRecords(this.account.id)).find(row => row.operationId === copyId);
          if (!target || recovery && recovery.stage !== 'completed') {
            const copied = await this.mutations.upload({ ...await context(targetItemId), operationId: copyId, fileName: source.fileName,
              bytes: plain.bytes, sha256: plain.sha256, signal: this.signal });
            this.session = copied.session; target = copied.attachment;
          }
          if (!target || used.has(target.attachmentId)) throw new Error('Bitwarden 附件副本未确认。');
          const confirmed = await read(targetItemId, target);
          try { if (confirmed.bytes.length !== plain.bytes.length || confirmed.sha256 !== plain.sha256) throw new Error('Bitwarden 附件副本内容不一致。'); }
          finally { confirmed.bytes.fill(0); }
          used.add(target.attachmentId);
          proof.attachments.push({ sourceAttachmentId: source.attachmentId, targetAttachmentId: target.attachmentId,
            fileName: source.fileName, mediaType: source.mediaType, sizeBytes: plain.bytes.length, sha256: plain.sha256 });
        } finally { plain.bytes.fill(0); }
      }
      if (JSON.stringify(await list(sourceItemId)) !== JSON.stringify(sources)) throw new Error('复制期间来源附件已变化，原密码尚未移除。');
      await this.vault.inspectPasswordProjectRemoval(operationId);
      return [proof];
    } finally { this.organizationKeys.forEach(key => { key.encKey.fill(0); key.macKey.fill(0); }); this.organizationKeys.clear(); }
  }
}
