import type { ProviderSyncActivity } from './provider-sync-activity';
import { sameProviderBinding } from '../core/provider';
import type { SecureVaultService } from '../security/secure-vault-service';
import type { PasswordProjectRemovalRunner } from './password-project-removal';

/** Caller holds ProviderOperationQueue. A supplied signal belongs to the active
 * sync; a manager action owns its own slot in the shared abort/busy registry. */
export class BitwardenProjectRemovalRuntime implements PasswordProjectRemovalRunner {
  constructor(private readonly vault: SecureVaultService, private readonly coordinator: PasswordProjectRemovalRunner,
    private readonly active: ProviderSyncActivity, private readonly invalidate: (providerId: string) => void) {}

  async resume(operationId: string, signal?: AbortSignal) {
    const record = (await this.vault.readPasswordProjectRemovals()).find(row => row.id === operationId);
    if (!record) throw new Error('找不到 Bitwarden 项目移除记录。');
    if (record.status === 'completed' || record.status === 'cancelled') return record;
    const bindings = record.providerBindings.filter(row => row.kind !== 'local');
    const binding = bindings[0];
    if (bindings.length !== 1 || binding.kind !== 'bitwarden') throw new Error('Bitwarden 项目移除仅支持一个外部来源。');
    const account = await this.vault.getProvider(binding.id);
    if (!account?.enabled || !sameProviderBinding(account, binding)) throw new Error('Bitwarden 项目来源已变化，请检查恢复记录。');
    const owner = signal ? undefined : new AbortController();
    if (owner && this.active.isBusy(binding.id)) throw new Error('此密码源正在处理其他操作，请稍后重试。');
    if (signal && !this.active.owns(binding.id, signal)) throw new Error('密码源恢复必须由当前同步操作执行。');
    if (owner) this.active.reserve(binding.id, owner);
    const operationSignal = signal || owner!.signal;
    try {
      operationSignal.throwIfAborted();
      this.invalidate(binding.id);
      return await this.coordinator.resume(operationId, operationSignal);
    } finally {
      // Copies/deletes can succeed remotely even if their response is lost.
      this.invalidate(binding.id);
      if (owner) this.active.release(binding.id, owner);
    }
  }
}
