import type { ProviderAccount, VaultItem } from '../core/model';
import { sameProviderBinding } from '../core/provider';
import { isPasswordProjectRemovalPending, type PasswordProjectRemovalRecord } from '../core/password-project-removal-journal';
import type { Mdbx2RestoreRecord } from '../core/mdbx2-restore-journal';
import type { SecureVaultService } from '../security/secure-vault-service';
import { ProviderOperationQueue } from './provider-operation-queue';

export type PasswordProjectRemovalRequest = Parameters<SecureVaultService['stagePasswordProjectRemoval']>[0];
/** Only emitted after the source queue has settled and the encrypted journal proves no stage. */
export class PasswordProjectRemovalNotStagedError extends Error {
  readonly code = 'password-project-removal-not-staged';
}
/** Manager presentation contains no passwords, original payloads or provider credentials. */
export interface PasswordProjectRemovalStatus {
  operationId: string;
  title: string;
  status: PasswordProjectRemovalRecord['status'] | 'restoring';
  providerId?: string;
  retainedItemIds: string[];
  removedItemIds: string[];
  pendingRestoreItemIds: string[];
  canCancel: boolean;
  supported: boolean;
  preparationRecovery?: boolean;
  passkeyPreservation?: { total: number; verified: number; uncertain: number };
}

export interface PasswordProjectRemovalRunner {
  resume(operationId: string, signal?: AbortSignal): Promise<PasswordProjectRemovalRecord>;
}

export class PasswordProjectRemovalWorkflow {
  constructor(private readonly vault: SecureVaultService,
    private readonly removal: { resume(operationId: string): Promise<PasswordProjectRemovalRecord> },
    private readonly restore: { restore(itemId: string): Promise<VaultItem> },
    private readonly queue: ProviderOperationQueue,
    private readonly changed: () => void = () => undefined,
    private readonly bitwarden?: PasswordProjectRemovalRunner) {}

  private account(providers: ProviderAccount[]) { return supportedAccount(providers, Boolean(this.bitwarden)); }
  private describe(record: PasswordProjectRemovalRecord, restores: Mdbx2RestoreRecord[]) {
    return describe(record, restores, Boolean(this.bitwarden));
  }
  private runner(account: ProviderAccount): PasswordProjectRemovalRunner {
    return account.kind === 'bitwarden' ? this.bitwarden! : this.removal;
  }

  async pending(operationId?: string): Promise<PasswordProjectRemovalStatus[]> {
    if (operationId !== undefined && (typeof operationId !== 'string' || !operationId || operationId.length > 512))
      throw new Error('移除操作标识无效。');
    const [records, restores] = await Promise.all([this.vault.readPasswordProjectRemovals(), this.vault.readMdbx2Restores()]);
    return records
      .filter(row => operationId !== undefined ? row.id === operationId : isPasswordProjectRemovalPending(row) || linkedRestores(row, restores).length)
      .map(row => this.describe(row, restores));
  }

  async stage(input: PasswordProjectRemovalRequest): Promise<PasswordProjectRemovalStatus> {
    if (!Array.isArray(input?.items) || !input.items.length || input.items.some(row => !Array.isArray(row?.providerRefs)))
      throw new Error('密码项目草稿无效。');
    const state = await this.vault.readState();
    const ids = new Set(input.items.flatMap(row => [...row.providerRefs, ...(state.items.find(item => item.id === row.id)?.providerRefs || [])].map(ref => ref.providerId)));
    const removesExisting = Array.isArray(input.removedItemIds) && state.items.some(row => input.removedItemIds.includes(row.id));
    const accounts = [...ids].map(id => state.providers.find(row => row.id === id));
    if (accounts.some(row => !row?.enabled)) throw new Error('密码源已变化或不可用。');
    const account = this.account(accounts as ProviderAccount[]);
    const sessionId = await this.vault.passkeySessionId();
    return this.queue.run(account?.id || 'local-password-removal', async () => {
      let stageAcknowledged = false;
      try {
        if (!sessionId || sessionId !== await this.vault.passkeySessionId()) throw new Error('密码库解锁会话已变化，请重新打开项目。');
        // Recheck the account kind immediately before the first local write.
        const current = await Promise.all([...ids].map(id => this.vault.getProvider(id)));
        if (current.some(row => !row?.enabled)) throw new Error('密码源已变化或不可用。');
        if (current.some((row, index) => !sameProviderBinding(row!, accounts[index]!)
          || row!.config.nativeVaultId !== accounts[index]!.config.nativeVaultId)) throw new Error('排队期间密码源已变化，请重新打开项目。');
        this.account(current as ProviderAccount[]);
        const staged = await this.vault.stagePasswordProjectRemoval(input);
        stageAcknowledged = true;
        this.changed();
        if (!staged.removal) return { operationId: input.operationId, title: staged.items[0]?.title || '', status: 'completed',
          retainedItemIds: staged.items.map(row => row.id), removedItemIds: [], pendingRestoreItemIds: [], canCancel: false, supported: true };
        const result = account && isPasswordProjectRemovalPending(staged.removal) ? await this.runner(account).resume(staged.removal.id) : staged.removal;
        return this.describe(result, await this.vault.readMdbx2Restores());
      } catch (cause) {
        if (!stageAcknowledged && removesExisting) {
          // The same-source queue is still held. A rejected write with no saved
          // journal can safely return to editing. Read/transport uncertainty must
          // retain the original request; never infer this from an empty UI list.
          const records = await this.vault.readPasswordProjectRemovals().catch(() => undefined);
          if (records && !records.some(row => row.id === input.operationId))
            throw new PasswordProjectRemovalNotStagedError(cause instanceof Error ? cause.message : '保存失败，请重试。');
        }
        throw cause;
      } finally { this.changed(); }
    });
  }

  async resume(operationId: string): Promise<PasswordProjectRemovalStatus> {
    const record = await this.record(operationId), account = this.account(record.providerBindings);
    const sessionId = await this.vault.passkeySessionId();
    return this.queue.run(account?.id || 'local-password-removal', async () => {
      try {
        if (!sessionId || sessionId !== await this.vault.passkeySessionId()) throw new Error('密码库解锁会话已变化，请重新打开项目。');
        const result = account ? await this.runner(account).resume(operationId) : await this.record(operationId);
        return this.describe(result, await this.vault.readMdbx2Restores());
      } finally { this.changed(); }
    });
  }

  async cancel(operationId: string): Promise<PasswordProjectRemovalStatus> {
    const record = await this.record(operationId); this.account(record.providerBindings);
    // This competes at the service lock, so preparation can be stopped while
    // attachment copying is in flight. It never cancels a saved delete request.
    try { return this.describe(await this.vault.cancelPasswordProjectRemovalPreparation(operationId), await this.vault.readMdbx2Restores()); }
    finally { this.changed(); }
  }

  /** Already inside the provider queue; never recursively enqueue a sync here. */
  async recoverProvider(providerId: string, signal?: AbortSignal): Promise<void> {
    for (const row of (await this.vault.readPasswordProjectRemovals()).filter(row => isPasswordProjectRemovalPending(row)
      && row.providerBindings.some(account => account.id === providerId && (account.kind === 'mdbx2' || account.kind === 'bitwarden')))) {
      signal?.throwIfAborted();
      const account = this.account(row.providerBindings)!;
      try { await this.runner(account).resume(row.id, signal); }
      finally { this.changed(); }
    }
    for (const row of (await this.vault.readMdbx2Restores()).filter(row => row.status === 'prepared' && row.provider.id === providerId)) {
      signal?.throwIfAborted();
      await this.restore.restore(row.source.id);
    }
    signal?.throwIfAborted();
  }

  /** Recovery may rotate OAuth tokens. Never hand ordinary sync its old account. */
  async recoverBeforeSync(account: ProviderAccount, signal: AbortSignal): Promise<ProviderAccount> {
    await this.recoverProvider(account.id, signal);
    signal.throwIfAborted();
    const current = await this.vault.getProvider(account.id);
    if (!current?.enabled || !sameProviderBinding(current, account)) throw new Error('恢复期间密码源已变化，请重新打开密码源。');
    if ((await this.vault.readPasswordProjectRemovals()).some(row => isPasswordProjectRemovalPending(row)
      && row.providerBindings.some(binding => binding.id === account.id))) throw new Error('请先完成未处理的密码移除，再同步此密码源。');
    return current;
  }

  private async record(operationId: string): Promise<PasswordProjectRemovalRecord> {
    if (typeof operationId !== 'string' || !operationId || operationId.length > 512) throw new Error('移除操作标识无效。');
    const record = (await this.vault.readPasswordProjectRemovals()).find(row => row.id === operationId);
    if (!record) throw new Error('找不到密码项目移除操作。');
    return record;
  }
}

function supportedAccount(providers: ProviderAccount[], bitwarden = false): ProviderAccount | undefined {
  const external = providers.filter(row => row.kind !== 'local');
  if (external.length > 1 || external.some(row => row.kind !== 'mdbx2' && !(bitwarden && row.kind === 'bitwarden')))
    throw new Error('成员移除目前支持本地库或单个 MDBX2 密码源，其他密码源的原始内容已保留。');
  return external[0];
}
function linkedRestores(record: PasswordProjectRemovalRecord, restores: Mdbx2RestoreRecord[]): Mdbx2RestoreRecord[] {
  return restores.filter(row => row.status === 'prepared' && row.reapply?.deletionOperationId === record.id);
}
function describe(record: PasswordProjectRemovalRecord, restores: Mdbx2RestoreRecord[], bitwarden = false): PasswordProjectRemovalStatus {
  const external = record.providerBindings.filter(row => row.kind !== 'local');
  const supported = external.length <= 1 && external.every(row => row.kind === 'mdbx2' || bitwarden && row.kind === 'bitwarden');
  const pending = linkedRestores(record, restores);
  const copies = record.bitwardenPasskeyPreservation?.sources.flatMap(source => source.copies);
  return { operationId: record.id, title: record.retained[0].title,
    status: pending.length || isPasswordProjectRemovalPending(record) && ['restoring', 'restored'].includes(record.bitwardenDeletion?.phase || '') ? 'restoring' : record.status,
    providerId: external[0]?.id, retainedItemIds: record.retained.map(row => row.id), removedItemIds: record.removed.map(row => row.id),
    pendingRestoreItemIds: pending.map(row => row.source.id), supported,
    ...(record.bitwardenPreparationRecovery ? { preparationRecovery: true } : {}),
    canCancel: supported && record.status === 'preparing' && Boolean(record.cancellationItems) && !record.nativeDeletion && !record.bitwardenDeletion && !record.bitwardenPreparationRecovery,
    ...(copies?.length ? { passkeyPreservation: { total: copies.length, verified: copies.filter(row => row.stage === 'verified').length,
      uncertain: copies.filter(row => row.stage === 'attempted').length } } : {}) };
}
