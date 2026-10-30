import type { PasskeyItem } from '../core/model';

export function assertPasskeyBackupFlags(item: Pick<PasskeyItem, 'backupEligible' | 'backupState'>): void {
  if (item.backupEligible === false && item.backupState === true) {
    throw new Error('Passkey 的备份标志冲突，请从可信来源恢复；原凭据未修改。');
  }
}

/** A stored legacy null/undefined value already signs as BE=true, just as Android does. */
export function mergePasskeyBackupFlags(existing: PasskeyItem, incoming: PasskeyItem): PasskeyItem {
  if (incoming.backupEligible !== undefined && incoming.backupEligible !== (existing.backupEligible !== false)) {
    throw new Error('同一 Passkey 的可备份属性发生冲突，已保留原凭据，请检查同步来源。');
  }
  const result = { ...incoming, backupEligible: incoming.backupEligible ?? existing.backupEligible,
    backupState: incoming.backupState ?? existing.backupState };
  assertPasskeyBackupFlags(result);
  return result;
}
