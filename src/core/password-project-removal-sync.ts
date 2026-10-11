import type { ProviderAccount } from './model';
import { sameProviderBinding, type ProviderSyncContext } from './provider';
import { isPasswordProjectRemovalPending, readPasswordProjectRemovalJournal } from './password-project-removal-journal';

/** Ordinary sync cannot turn a persisted attachment proof into a fresh delete authorization. */
export function assertPasswordProjectRemovalSyncSafe(account: ProviderAccount, context: ProviderSyncContext): void {
  for (const record of readPasswordProjectRemovalJournal(context.passwordProjectRemovals)) {
    const binding = record.providerBindings.find(provider => provider.id === account.id);
    if (!binding || !isPasswordProjectRemovalPending(record)) continue;
    if (!sameProviderBinding(binding, account)) throw new Error('密码项目移除操作的密码源已变化，已停止同步。');
    if (record.status === 'deleting')
      throw new Error('密码项目移除需要重新校验远端附件，普通同步不能执行此删除。');
    if (record.bitwardenPasskeyPreservation || record.bitwardenPreparationRecovery)
      throw new Error('密码项目正在保留 Passkey，请先完成或处理恢复记录，再进行普通同步。');
    const ids = new Set([...record.retained, ...record.removed].map(row => row.id));
    if ([...ids].some(id => !context.localItems.some(row => row.id === id && !row.deletedAt))
      || context.pendingMutations?.some(mutation => mutation.providerId === account.id && ids.has(mutation.itemId) && mutation.operation === 'delete'))
      throw new Error('密码项目移除尚未完成附件校验，已停止同步删除。');
  }
}
