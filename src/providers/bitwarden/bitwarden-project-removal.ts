import { sameProviderBinding } from '../../core/provider';
import type { ProviderAccount } from '../../core/model';
import type { PasswordProjectRemovalRecord } from '../../core/password-project-removal-journal';
import { BitwardenProjectLocalChange, bitwardenProjectCipherId } from '../../core/bitwarden-project-removal-local';
import type { SecureVaultService } from '../../security/secure-vault-service';
import { BitwardenClient } from './bitwarden-client';
import { BitwardenProvider } from './bitwarden-provider';
import { BitwardenDurableSyncCoordinator } from './bitwarden-durable-sync';
import { BitwardenAttachmentDownloadService } from './bitwarden-attachments';
import { BitwardenAttachmentMutationService } from './bitwarden-attachment-mutations';
import { BitwardenProjectRemovalAttachmentPreparation } from './bitwarden-project-removal-attachments';
import { BitwardenProjectRemovalVerifier } from './bitwarden-project-removal-verification';
import { BitwardenPasskeyPreservationPreparation } from './bitwarden-passkey-preservation-preparation';
import { BitwardenProjectRemovalTransaction, bitwardenProjectRemovalStore } from './bitwarden-project-removal-transaction';

/** The runtime must hold the provider operation queue for the whole call.
 * This coordinator never invokes ordinary sync once deletion has been staged.
 */
export class BitwardenPasswordProjectRemovalCoordinator {
  private readonly active = new Map<string, Promise<PasswordProjectRemovalRecord>>();
  constructor(private readonly vault: SecureVaultService, private readonly client = new BitwardenClient(),
    private readonly provider = new BitwardenProvider(), private readonly downloads = new BitwardenAttachmentDownloadService(),
    private readonly mutations = new BitwardenAttachmentMutationService()) {}

  resume(operationId: string, signal?: AbortSignal): Promise<PasswordProjectRemovalRecord> {
    const previous = this.active.get(operationId); if (previous) return previous;
    const promise = this.run(operationId, signal).catch(async cause => {
      const current = await this.record(operationId);
      if (current.status === 'cancelled') return current;
      throw cause;
    }).finally(() => this.active.delete(operationId));
    this.active.set(operationId, promise); return promise;
  }

  private async run(operationId: string, signal?: AbortSignal): Promise<PasswordProjectRemovalRecord> {
    let record = await this.record(operationId);
    if (record.status === 'completed' || record.status === 'cancelled') return record;
    let account = await this.account(record);
    if (record.status === 'preparing') {
      const recovery = await this.vault.beginBitwardenPreparationRecoveryIfChanged(operationId);
      if (recovery) return await this.recoverPreparation(recovery, signal);
      try {
      let proofs = record.proofs || [];
      if (!record.bitwardenPasskeyPreservation) {
        await this.synchronize(record, account, signal);
        account = await this.account(record);
        const preparation = new BitwardenProjectRemovalAttachmentPreparation(this.client, account, this.vault, this.downloads, this.mutations, signal);
        try { proofs = await preparation.prepare(operationId); }
        finally { await this.persistSession(record, preparation.currentAccount()); }
        // Attachment writes have server revisions/source envelopes of their own.
        // Reconcile them before freezing the final local and remote snapshots.
        account = await this.account(record);
        await this.synchronize(record, account, signal);
      }
      const context = await this.vault.readPasskeyContext();
      const sourceIds = new Set(record.removed.map(row => row.providerRefs.find(ref => ref.providerId === account.id)?.remoteId));
      if (record.bitwardenPasskeyPreservation || context.items.some(row => row.providerRefs.some(ref => ref.providerId === account.id
        && ref.remoteId && sourceIds.has(bitwardenProjectCipherId(ref.remoteId))))) {
        account = await this.account(record);
        await new BitwardenPasskeyPreservationPreparation(this.client, account, this.vault, operationId, signal, proofs).prepare();
      }
      account = await this.account(record);
      const observed = await this.vault.inspectPasswordProjectRemoval(operationId);
      const acknowledged = { ...observed.record, retained: observed.record.retained.map(row => observed.items.find(item => item.id === row.id)!),
        removed: observed.record.removed.map(row => observed.items.find(item => item.id === row.id)!), proofs };
      const verifier = new BitwardenProjectRemovalVerifier(this.client, account, this.downloads, signal);
      try {
        const intent = await verifier.prepare(acknowledged);
        record = await this.vault.finalizePasswordProjectRemoval(operationId, observed.items, proofs, undefined, intent);
      } finally { await this.persistSession(record, verifier.currentAccount()); }
      } catch (cause) {
        const recovery = await this.vault.beginBitwardenPreparationRecoveryIfChanged(operationId);
        if (recovery) return await this.recoverPreparation(recovery, signal);
        throw cause;
      }
    }
    if (record.status === 'cancelled' || record.status === 'completed') return record;
    account = await this.account(record);
    const verifier = new BitwardenProjectRemovalVerifier(this.client, account, this.downloads, signal);
    try {
      const transaction = new BitwardenProjectRemovalTransaction(bitwardenProjectRemovalStore(this.vault), verifier.remote());
      try {
        if (!['restoring', 'restored'].includes(record.bitwardenDeletion?.phase || ''))
          await this.vault.checkPasswordProjectBitwardenDeletionLocalState(operationId);
        record = await transaction.resume(operationId);
        if (record.bitwardenDeletion?.phase === 'committed') {
          const result = await verifier.committedReadback(record);
          return await this.vault.completePasswordProjectBitwardenDeletion(result);
        }
      } catch (cause) {
        if (!(cause instanceof BitwardenProjectLocalChange)) throw cause;
        record = await transaction.restoreAfterLocalChange(operationId);
      }
      if (record.bitwardenDeletion?.phase === 'restored')
        return await this.vault.completePasswordProjectBitwardenRestoration(await verifier.restoredReadback(record));
      return record;
    } finally { await this.persistSession(record, verifier.currentAccount()); }
  }

  private async recoverPreparation(record: PasswordProjectRemovalRecord, signal?: AbortSignal) {
    const verifier = new BitwardenProjectRemovalVerifier(this.client, await this.account(record), this.downloads, signal);
    try { return await this.vault.completeBitwardenPreparationRecovery(await verifier.preparationReadback(record)); }
    finally { await this.persistSession(record, verifier.currentAccount()); }
  }

  private async record(operationId: string) {
    const record = (await this.vault.readPasswordProjectRemovals()).find(row => row.id === operationId);
    if (!record) throw new Error('找不到 Bitwarden 项目移除记录。'); return record;
  }
  private async account(record: PasswordProjectRemovalRecord): Promise<ProviderAccount> {
    const external = record.providerBindings.filter(row => row.kind !== 'local');
    if (external.length !== 1 || external[0].kind !== 'bitwarden') throw new Error('Bitwarden 项目移除仅支持一个外部来源。');
    const current = await this.vault.getProvider(external[0].id);
    if (!current?.enabled || !sameProviderBinding(current, external[0])) throw new Error('Bitwarden 项目来源已变化，请检查恢复记录。');
    return current;
  }
  private async synchronize(record: PasswordProjectRemovalRecord, account: ProviderAccount, signal?: AbortSignal) {
    const state = await this.vault.readState(false), rows = [...record.retained, ...record.removed];
    const ids = new Set(rows.map(row => row.id)), ciphers = new Set(rows.flatMap(row => row.providerRefs.flatMap(ref => ref.providerId === account.id && ref.remoteId ? [ref.remoteId] : [])));
    const itemIds = state.items.filter(row => ids.has(row.id) || row.providerRefs.some(ref => ref.providerId === account.id && ref.remoteId && ciphers.has(bitwardenProjectCipherId(ref.remoteId)))).map(row => row.id);
    await new BitwardenDurableSyncCoordinator(this.provider, this.vault).synchronize(account, signal, { itemIds });
    await this.vault.inspectPasswordProjectRemoval(record.id);
  }
  private async persistSession(record: PasswordProjectRemovalRecord, refreshed: ProviderAccount) {
    const current = await this.account(record);
    if (!sameProviderBinding(current, refreshed)) throw new Error('Bitwarden 凭据刷新改变了来源。');
    if (JSON.stringify(current.config) !== JSON.stringify(refreshed.config))
      await this.vault.upsertProvider({ ...current, config: { ...current.config, ...refreshed.config } }, false, current);
  }
}
