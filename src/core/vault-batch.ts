import type { VaultItem } from './model';
import { passwordGroupMembers } from './password-groups';

export const VAULT_SELECTION_LIMIT = 200;
export type VaultBatchAction = 'favorite' | 'unfavorite' | 'trash';
export interface VaultBatchRequest {
  anchorIds: string[];
  expected: Record<string, string>;
  action: VaultBatchAction;
  confirmed?: true;
}

/** The display representative always stands for its complete credential project. */
export function vaultSelectionMembers(anchorIds: readonly string[], items: readonly VaultItem[]): VaultItem[] {
  const byId = new Map(items.map(item => [item.id, item]));
  const members = new Map<string, VaultItem>();
  for (const id of anchorIds) {
    const item = byId.get(id);
    if (!item || item.deletedAt || item.archivedAt || item.kind === 'opaque') throw new Error('所选项目已变化，请重新选择。');
    for (const member of item.kind === 'login' ? passwordGroupMembers(item, [...items]) : [item]) members.set(member.id, member);
  }
  return [...members.values()];
}

export function validateVaultBatch(request: VaultBatchRequest, items: readonly VaultItem[]): VaultItem[] {
  if (!request || !['favorite', 'unfavorite', 'trash'].includes(request.action)
    || !Array.isArray(request.anchorIds) || !request.anchorIds.length || request.anchorIds.length > VAULT_SELECTION_LIMIT
    || request.anchorIds.some(id => typeof id !== 'string' || !id || id.length > 1024)
    || new Set(request.anchorIds).size !== request.anchorIds.length
    || !request.expected || typeof request.expected !== 'object' || Array.isArray(request.expected)) throw new Error('批量操作参数无效。');
  if (request.action === 'trash' && request.confirmed !== true) throw new Error('请先确认移到回收站的范围。');
  const members = vaultSelectionMembers(request.anchorIds, items);
  const expectedIds = Object.keys(request.expected);
  if (members.length > 10000 || expectedIds.length !== members.length
    || members.some(item => !Object.prototype.hasOwnProperty.call(request.expected, item.id) || request.expected[item.id] !== item.updatedAt)) {
    throw new Error('所选项目已变化，请重新选择。');
  }
  return members;
}
