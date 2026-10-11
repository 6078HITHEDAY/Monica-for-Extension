import type { VaultState } from './model';
import { isLocalTransferItem, validateLocalAttachments, type LocalItemAttachment } from './local-transfer';
import { assertMdbx2TransferOperationId, mdbx2TransferOperationScope as hash } from '../providers/mdbx2/mdbx2-transfer-identity';
import type { ProviderAttachmentMutationResult, ProviderAttachmentSummary } from '../providers/attachments/attachment-contract';

export interface LocalAttachmentMutation {
  operationId: string;
  providerId: string;
  itemId: string;
  attachmentId: string;
  mode: 'create' | 'replace' | 'delete';
  expectedRevision?: string;
  attachment?: LocalItemAttachment;
}
export interface LocalAttachmentReceipt { operationId: string; fingerprint: string; result: ProviderAttachmentMutationResult }

/** Revision binds filename, type and contents; it is not merely the file's plaintext digest. */
export async function localAttachmentSummary(file: LocalItemAttachment): Promise<ProviderAttachmentSummary> {
  const { dataBase64: _body, ...metadata } = file;
  return { attachmentId: file.attachmentId, providerKind: 'local', fileName: file.fileName, mediaType: file.mediaType,
    sizeBytes: file.sizeBytes, protected: file.protected !== false, revision: await hash(metadata) };
}

export function localAttachmentOwner(state: VaultState, providerId: string, itemId: string) {
  const locals = state.providers.filter(row => row.kind === 'local');
  const provider = state.providers.find(row => row.id === providerId) || (providerId === 'local' && locals.length === 1 ? locals[0] : undefined);
  const item = state.items.find(row => row.id === itemId && !row.deletedAt);
  if (!provider?.enabled || provider.kind !== 'local' || !item || !isLocalTransferItem(item, state.providers)) throw new Error('本地附件项目不可用。');
  return item;
}

export async function applyLocalAttachmentMutation(state: VaultState, input: LocalAttachmentMutation) {
  assertMdbx2TransferOperationId(input.operationId);
  const fingerprint = await hash(input), receipts = state.localAttachmentReceipts || [];
  const old = receipts.find(row => row.operationId === input.operationId);
  if (old) {
    if (old.fingerprint !== fingerprint) throw new Error('附件操作 ID 已用于其他内容。');
    return { replayed: true, result: structuredClone(old.result) };
  }
  if (receipts.length >= 10_000) throw new Error('本地附件回执已达上限。');
  const owner = localAttachmentOwner(state, input.providerId, input.itemId);
  const files = (state.localItemAttachments || []).filter(row => row.itemId === owner.id);
  const current = files.find(row => row.attachmentId === input.attachmentId);
  if (input.mode === 'create') {
    if (current || input.expectedRevision) throw new Error('同一附件身份已存在，请重新选择文件。');
  } else if (input.mode === 'replace' || input.mode === 'delete') {
    if (!current || !input.expectedRevision || (await localAttachmentSummary(current)).revision !== input.expectedRevision)
      throw new Error('附件已变化，请刷新后重新操作。');
  } else throw new Error('附件操作无效。');
  const next = files.filter(row => row.attachmentId !== input.attachmentId);
  if (input.mode !== 'delete') {
    const file = input.attachment;
    if (!file || file.itemId !== owner.id || file.attachmentId !== input.attachmentId
      || next.some(row => row.fileName === file.fileName)) throw new Error('附件归属或文件名冲突。');
    next.push(structuredClone(file));
  } else if (input.attachment) throw new Error('删除附件请求不能包含新文件。');
  await validateLocalAttachments(next, owner.id);
  const result: ProviderAttachmentMutationResult = { changed: true,
    ...(input.attachment ? { attachment: await localAttachmentSummary(input.attachment) } : {}) };
  state.localItemAttachments = [...(state.localItemAttachments || []).filter(row => row.itemId !== owner.id), ...next];
  state.localAttachmentReceipts = [...receipts, { operationId: input.operationId, fingerprint, result }];
  owner.updatedAt = new Date(Math.max(Date.now(), Date.parse(owner.updatedAt) + 1 || 0)).toISOString();
  state.updatedAt = owner.updatedAt;
  return { replayed: false, result };
}
