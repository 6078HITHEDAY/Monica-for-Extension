import type { VaultItem, VaultState, ProviderAccount } from '../../core/model';
import type { LocalTransferResource } from '../../core/local-transfer';
import { LOCAL_ATTACHMENT_MAX_BYTES } from '../../core/local-transfer';
import type { Mdbx2TransferAttachmentService } from '../mdbx2/mdbx2-transfer-attachments';
import type { Mdbx2CollectionSummary } from '../mdbx2/native-contract';
import { sourceCategoryPath } from '../mdbx2/mdbx2-batch-transfer';
import { bytesToBase64 } from '../../security/encoding';

export async function readLocalTransferResource(state: VaultState, item: VaultItem, dependencies: {
  files: Pick<Mdbx2TransferAttachmentService, 'listSourceAttachments' | 'readSourceAttachment'>;
  prepare(account: ProviderAccount): Promise<Mdbx2CollectionSummary[] | undefined>;
}): Promise<LocalTransferResource> {
  const account = item.providerRefs.length === 1 && state.providers.find(row => row.id === item.providerRefs[0].providerId);
  if (!account || !account.enabled || !['mdbx2', 'keepass', 'bitwarden', 'monica-webdav'].includes(account.kind)) throw new Error('来源密码库不可用或绑定不唯一。');
  const collections = await dependencies.prepare(account), path = sourceCategoryPath(item, { collections });
  // A missing display name must not silently turn an unresolved folder into root.
  if (!item.mdbxFolderId && !item.keepassGroupPath && !item.categoryName?.trim()
    && (item.categoryId != null || (account.kind === 'bitwarden' && item.providerRefs[0].remoteFolderId))) path.complete = false;
  const catalog = await dependencies.files.listSourceAttachments(account, item);
  if (catalog.length > 512 || new Set(catalog.map(file => file.attachmentId)).size !== catalog.length) throw new Error('来源附件清单重复或超过上限。');
  const attachments: LocalTransferResource['attachments'] = [];
  let total = 0;
  for (const file of catalog) {
    const bytes = await dependencies.files.readSourceAttachment(account, item, file);
    try {
      total += bytes.length;
      if (total > LOCAL_ATTACHMENT_MAX_BYTES) throw new Error('本地传输附件合计超过 16 MiB 上限。');
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
      attachments.push({ ...file, itemId: item.id, sizeBytes: bytes.length,
        sha256: [...digest].map(byte => byte.toString(16).padStart(2, '0')).join(''), dataBase64: bytesToBase64(bytes) });
    } finally { bytes.fill(0); }
  }
  if (JSON.stringify(await dependencies.files.listSourceAttachments(account, item)) !== JSON.stringify(catalog)) throw new Error('读取期间来源附件清单已变化，请重新预览。');
  const identity = item.keepassGroupUuid || item.mdbxFolderId || item.providerRefs[0].remoteFolderId
    || (item.categoryId == null ? item.categoryName : `id:${item.categoryId}`) || path.segments.join('/');
  return { expected: structuredClone(item), account: structuredClone(account), attachments,
    folder: path.complete ? { identity: path.segments.length ? identity : '', label: path.segments.join(' / ') } : undefined };
}
