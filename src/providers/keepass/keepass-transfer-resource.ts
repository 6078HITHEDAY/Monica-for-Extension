import type { ProviderAccount, VaultItem, VaultState } from '../../core/model';
import { isLocalTransferItem, validateLocalAttachments } from '../../core/local-transfer';
import { readLocalTransferResource } from '../attachments/local-transfer-resource';
import type { Mdbx2TransferAttachmentService } from '../mdbx2/mdbx2-transfer-attachments';
import type { Mdbx2CollectionSummary } from '../mdbx2/native-contract';
import { isMdbx2RootCollection } from '../mdbx2/mdbx2-batch-transfer';
import type { KeePassProvider } from './keepass-provider';
import type { KeePassTransferRow } from './keepass-transfer-file';

export async function readKeePassTransferResource(state: VaultState, item: VaultItem, preserveCategories: boolean, dependencies: {
  provider: KeePassProvider;
  files: Pick<Mdbx2TransferAttachmentService, 'listSourceAttachments' | 'readSourceAttachment'>;
  prepare(account: ProviderAccount): Promise<Mdbx2CollectionSummary[] | undefined>;
}): Promise<KeePassTransferRow> {
  if (isLocalTransferItem(item, state.providers)) {
    const attachments = structuredClone((state.localItemAttachments || []).filter(row => row.itemId === item.id));
    await validateLocalAttachments(attachments, item.id);
    if (preserveCategories && item.categoryId != null && !item.categoryName?.trim()) throw new Error('来源本地文件夹名称缺失。');
    return { source: structuredClone(item), attachments,
      folder: preserveCategories && item.categoryName ? { identities: [item.categoryId == null ? `name:${item.categoryName}` : `id:${item.categoryId}`], segments: [item.categoryName] } : undefined };
  }
  const account = item.providerRefs.length === 1 && state.providers.find(row => row.id === item.providerRefs[0].providerId);
  if (!account || !account.enabled) throw new Error('来源密码库不可用或绑定不唯一。');
  if (account.kind === 'keepass') {
    await dependencies.prepare(account);
    return { source: structuredClone(item), nativeContentSha256: await dependencies.provider.transferNativeContentHash(account),
      folder: preserveCategories ? dependencies.provider.transferSourceFolder(account, item) : undefined };
  }
  let collections: Mdbx2CollectionSummary[] | undefined;
  const resource = await readLocalTransferResource(state, item, { files: dependencies.files,
    prepare: async account => (collections = await dependencies.prepare(account)) });
  let folder: KeePassTransferRow['folder'];
  if (preserveCategories) {
    if (!resource.folder) throw new Error('来源文件夹层级不完整，请取消保留分类或修复来源。');
    if (account.kind === 'mdbx2' && item.mdbxFolderId && item.mdbxFolderId !== 'root') {
      const byId = new Map((collections || []).map(row => [row.collectionId, row])), seen = new Set<string>();
      const identities: string[] = [], segments: string[] = [];
      let id: string | undefined = item.mdbxFolderId;
      while (id && id !== 'root') {
        if (seen.has(id) || seen.size >= 128) throw new Error('MDBX 来源文件夹层级无效。');
        seen.add(id);
        const row = byId.get(id);
        if (!row || row.deleted) throw new Error('MDBX 来源文件夹缺少父目录。');
        if (isMdbx2RootCollection(row)) break;
        identities.unshift(id); segments.unshift(row.title); id = row.groupId;
      }
      if (segments.length) folder = { identities, segments };
    } else if (resource.folder.label) folder = { identities: [resource.folder.identity], segments: [resource.folder.label] };
  }
  return { source: structuredClone(item), attachments: resource.attachments, folder };
}
