import type { ProviderAccount, VaultState } from './model';
import { sameProviderBinding } from './provider';
import { mdbx2TransferDependencies } from '../providers/mdbx2/mdbx2-transfer-dependencies';
import { assertMdbx2TransferOperationId, mdbx2TransferOperationScope as hash } from '../providers/mdbx2/mdbx2-transfer-identity';
import type { Mdbx2BatchTransferRequest, Mdbx2BatchTransferPlanResult, Mdbx2BatchTransferExecuteResult } from '../providers/mdbx2/mdbx2-batch-transfer-coordinator';
import { validateKeePassDurableMutationReceipt, type KeePassDurableMutationReceipt } from '../providers/keepass/keepass-working-copy-store';
import { readPasswordProjectRemovalJournal, isPasswordProjectRemovalPending } from './password-project-removal-journal';
import { readMdbx2MoveJournal } from './mdbx2-move-journal';

export type KeePassTransferRequest = Omit<Mdbx2BatchTransferRequest, 'confirmed' | 'operationId' | 'operationCreatedAt'> & {
  operationId: string; operationCreatedAt: string;
};

/** Encrypted vault journal. File contents and attachment payloads live in the
 * KDBX transaction, not a second plaintext draft in this journal. */
export interface KeePassTransferIntent {
  version: 1;
  request: KeePassTransferRequest;
  requestHash: string;
  plan: Mdbx2BatchTransferPlanResult;
  target: ProviderAccount;
  sourceAccounts: ProviderAccount[];
  snapshotHash: string;
  fileIntentSha256: string;
  inputSha256: string;
  inputContentSha256: string;
  status: 'writing' | 'completed' | 'cancelled';
  result?: Mdbx2BatchTransferExecuteResult;
}

export function normalizeKeePassTransferRequest(input: Mdbx2BatchTransferRequest): KeePassTransferRequest {
  if (!input || !Array.isArray(input.itemIds) || !input.itemIds.length || input.itemIds.length > 200
    || input.itemIds.some(id => typeof id !== 'string' || !id || id.length > 1024) || new Set(input.itemIds).size !== input.itemIds.length
    || typeof input.targetProviderId !== 'string' || !input.targetProviderId || !['copy', 'move'].includes(input.action)
    || typeof input.preserveCategories !== 'boolean' || input.targetCollectionId !== undefined && typeof input.targetCollectionId !== 'string'
    || input.operationCreatedAt !== undefined && (typeof input.operationCreatedAt !== 'string' || !Number.isFinite(Date.parse(input.operationCreatedAt))))
    throw new Error('KeePass 传输请求无效。');
  return { itemIds: [...input.itemIds].sort(), action: input.action, targetProviderId: input.targetProviderId,
    targetCollectionId: input.targetCollectionId || undefined, preserveCategories: input.preserveCategories,
    operationId: assertMdbx2TransferOperationId(input.operationId || crypto.randomUUID()),
    operationCreatedAt: input.operationCreatedAt || new Date().toISOString() };
}

export function readKeePassTransfers(value: unknown): KeePassTransferIntent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000) throw new Error('KeePass 传输恢复记录无效或超过上限。');
  const seen = new Set<string>();
  return value.map(raw => {
    const row = raw as KeePassTransferIntent;
    const request = normalizeKeePassTransferRequest(row?.request);
    if (row.version !== 1 || !row.request.operationId || !row.request.operationCreatedAt || seen.has(request.operationId)
      || !['writing', 'completed', 'cancelled'].includes(row.status) || row.target?.kind !== 'keepass' || row.target.id !== request.targetProviderId
      || !Array.isArray(row.sourceAccounts) || row.sourceAccounts.length > 200
      || [row.requestHash, row.snapshotHash, row.fileIntentSha256, row.inputSha256, row.inputContentSha256].some(v => !/^[a-f0-9]{64}$/.test(v))
      || !row.plan || row.plan.operationId !== request.operationId || row.plan.targetProviderId !== request.targetProviderId
      || row.plan.operationCreatedAt !== request.operationCreatedAt || row.plan.action !== request.action
      || row.plan.targetCollectionId !== request.targetCollectionId || row.plan.preserveCategories !== request.preserveCategories
      || !Array.isArray(row.plan.items) || !row.plan.items.length || row.plan.items.length > 200
      || row.plan.items.some(item => !item || typeof item.sourceItemId !== 'string' || !item.sourceItemId || item.effectiveAction !== request.action
        || typeof item.title !== 'string' || typeof item.pathIncomplete !== 'boolean'
        || !Array.isArray(item.sourcePath) || !Array.isArray(item.targetPath)
        || [...item.sourcePath, ...item.targetPath].some(part => typeof part !== 'string')
        || item.blockedReason !== undefined && (typeof item.blockedReason !== 'string' || !item.blockedReason))
      || new Set(row.plan.items.map(item => item.sourceItemId)).size !== row.plan.items.length
      || request.itemIds.some(id => !row.plan.items.some(item => item.sourceItemId === id))
      || row.plan.items.filter(item => !item.blockedReason).length !== row.plan.transferableCount
      || row.plan.items.filter(item => item.blockedReason).length !== row.plan.blockedCount
      || row.plan.requiresMoveConfirmation !== (request.action === 'move' && row.plan.transferableCount > 0)
      || !Array.isArray(row.plan.warnings) || row.plan.warnings.some(warning => typeof warning !== 'string')
      || row.status !== 'completed' && row.result !== undefined
      || row.status === 'completed' && (!row.result || row.result.operationId !== request.operationId || row.result.failedCount !== 0
        || row.result.action !== request.action || row.result.targetProviderId !== request.targetProviderId
        || row.result.completedCount !== row.plan.transferableCount || row.result.blockedCount !== row.plan.blockedCount
        || !Array.isArray(row.result.items) || row.result.items.length !== row.plan.items.length
        || row.result.items.some((item, index) => !item || item.sourceItemId !== row.plan.items[index].sourceItemId
          || item.effectiveAction !== request.action || item.status !== (row.plan.items[index].blockedReason ? 'blocked' : 'completed')
          || item.status === 'completed' && (typeof item.targetItemId !== 'string' || !item.targetItemId))))
      throw new Error('KeePass 传输恢复记录无效。');
    seen.add(request.operationId);
    return structuredClone(row);
  });
}

export function assertKeePassTransferBindings(state: VaultState, intent: { target: ProviderAccount; sourceAccounts: ProviderAccount[] }) {
  for (const expected of [intent.target, ...intent.sourceAccounts]) {
    const current = state.providers.find(row => row.id === expected.id);
    if (!current?.enabled || !sameProviderBinding(expected, current) || current.config.databaseId !== expected.config.databaseId)
      throw new Error('传输涉及的密码源已变化，请重新预览。');
  }
}

/** Snapshot only the selected graph and target, so unrelated local edits survive. */
export async function keePassTransferSnapshotHash(state: VaultState, request: KeePassTransferRequest): Promise<string> {
  const selected = mdbx2TransferDependencies(request.itemIds, state.items, request.action).selectedIds;
  if (selected.length > 200) throw new Error('包含关联项目后超过单次 200 项上限。');
  const ids = new Set(selected), providerIds = new Set([request.targetProviderId]);
  for (const item of state.items) if (ids.has(item.id)) item.providerRefs.forEach(ref => providerIds.add(ref.providerId));
  const relevant = (itemId: string, providerId?: string) => ids.has(itemId) || providerId === request.targetProviderId;
  if (state.items.some(row => ids.has(row.id) && row.deletedAt)
    || state.mutationQueue.some(row => relevant(row.itemId, row.providerId))
    || state.providerConflicts.some(row => relevant(row.itemId, row.providerId))
    || readPasswordProjectRemovalJournal(state.passwordProjectRemovals).some(row => isPasswordProjectRemovalPending(row)
      && [...row.retained, ...row.removed].some(item => ids.has(item.id) || item.providerRefs.some(ref => ref.providerId === request.targetProviderId)))
    || readMdbx2MoveJournal(state.mdbx2MoveFinalizations).some(row => row.status !== 'completed' && row.entries.some(entry => ids.has(entry.expected.id))))
    throw new Error('来源或目标仍有未完成的修改、冲突或移动，请先完成同步与恢复。');
  return hash({ selected, items: state.items.filter(row => ids.has(row.id) || row.providerRefs.some(ref => ref.providerId === request.targetProviderId)),
    records: state.sourceRecords.filter(row => providerIds.has(row.providerId)),
    attachments: (state.localItemAttachments || []).filter(row => ids.has(row.itemId)) });
}

export function keePassTransferResult(intent: KeePassTransferIntent, input: KeePassDurableMutationReceipt): Mdbx2BatchTransferExecuteResult {
  const receipt = validateKeePassDurableMutationReceipt(input);
  if (receipt.kind !== 'batch-transfer' || receipt.result.type !== 'batch-transfer' || receipt.operationId !== intent.request.operationId
    || receipt.providerId !== intent.target.id || receipt.intentSha256 !== intent.fileIntentSha256 || receipt.result.inputSha256 !== intent.inputSha256)
    throw new Error('KeePass 传输回执与确认的计划不一致。');
  const entries = receipt.result.entries;
  const accepted = intent.plan.items.filter(row => !row.blockedReason);
  if (entries.length !== accepted.length || accepted.some(row => !entries.some(entry => entry.sourceItemId === row.sourceItemId)))
    throw new Error('KeePass 传输回执缺少完整项目。');
  return { operationId: receipt.operationId, action: intent.request.action, targetProviderId: intent.target.id,
    items: intent.plan.items.map(row => ({ sourceItemId: row.sourceItemId, title: row.title, kind: row.kind, effectiveAction: intent.request.action,
      status: row.blockedReason ? 'blocked' : 'completed', retryable: false, error: row.blockedReason,
      targetItemId: entries.find(entry => entry.sourceItemId === row.sourceItemId)?.targetItemId })),
    completedCount: entries.length, blockedCount: intent.plan.blockedCount, failedCount: 0, warnings: intent.plan.warnings };
}
