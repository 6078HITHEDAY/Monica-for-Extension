import type { ProviderAccount, VaultItem } from '../../core/model';
import type { BitwardenKeePassMoveGroup } from '../../core/bitwarden-keepass-move';
import type { KeePassProvider } from './keepass-provider';
import type { KeePassLocalWorkingCopyService } from './keepass-local-working-copy';
import type { KeePassWorkingCopyStorage } from './keepass-working-copy-store';
import type { KeePassSourceRemovalRequest } from './keepass-source-removal';

type Persistence = Pick<KeePassLocalWorkingCopyService, 'persistSourceRemoval' | 'readAnyDurableReceipt'>;
interface Dependencies {
  ensure(account: ProviderAccount): Promise<unknown>;
  reload(account: ProviderAccount): Promise<unknown>;
  persistence(account: ProviderAccount): Persistence;
  publish(account: ProviderAccount, signal?: AbortSignal): Promise<{ workingSha256: string; accountConfig: Record<string, unknown> } | undefined>;
}

/** Called only while holding all involved provider and KeePass mutation queues. */
export class KeePassBitwardenMove {
  constructor(private readonly provider: KeePassProvider, private readonly storage: KeePassWorkingCopyStorage, private readonly dependencies: Dependencies) {}

  async verify(account: ProviderAccount, items: VaultItem[], operationId: string, targetProviderId: string, createdAt: string) {
    await this.dependencies.ensure(account);
    const record = await this.storage.read(account.id);
    if (!record) throw new Error('KeePass 来源工作副本不存在。');
    try {
      const content = await this.provider.transferNativeContentHash(account);
      const request: KeePassSourceRemovalRequest = { version: 1, operationId, targetProviderId, createdAt,
        expectedWorkingSha256: record.workingSha256, expectedContentSha256: content, targetProofSha256: '0'.repeat(64), sources: items };
      // Preflight includes native closure and serialization before target writes.
      const prepared = await this.provider.prepareSourceRemovalFile(account, request, record.workingBytes);
      try { prepared.assertCurrent(); return { inputSha256: record.workingSha256, inputContentSha256: content }; }
      finally { prepared.bytes.fill(0); }
    } finally { record.baseBytes.fill(0); record.workingBytes.fill(0); }
  }

  async prepareRemoval(group: BitwardenKeePassMoveGroup, account: ProviderAccount) {
    // Reopen only when no durable result exists. Do this outside the vault lock,
    // because remote restore may persist refreshed connection checkpoints.
    if (!await this.dependencies.persistence(account).readAnyDurableReceipt(account, group.id))
      await this.dependencies.ensure(account);
  }

  async remove(account: ProviderAccount, request: KeePassSourceRemovalRequest) {
    // Read the durable receipt before any requirement to reopen the source.
    const receipt = await this.dependencies.persistence(account).persistSourceRemoval(account, request);
    if (receipt.result.type !== 'transfer-source-remove') throw new Error('KeePass 来源移除回执类型不匹配。');
    return receipt.result;
  }

  async publish(group: BitwardenKeePassMoveGroup, account: ProviderAccount, signal?: AbortSignal) {
    if (!group.receipt) throw new Error('KeePass 来源文件尚未确认移除。');
    signal?.throwIfAborted(); await this.dependencies.ensure(account);
    const before = await this.storage.read(account.id);
    if (!before) throw new Error('KeePass 来源工作副本不存在。');
    try {
      if (before.workingSha256 !== group.receipt.outputSha256) throw new Error('KeePass 来源项目已被恢复或变化，来源和副本已保留。');
      await this.provider.assertTransferReload(account, before.workingBytes, group.inputContentSha256);
    }
    finally { before.baseBytes.fill(0); before.workingBytes.fill(0); }
    signal?.throwIfAborted(); await this.dependencies.reload(account);
    const result = await this.dependencies.publish(account, signal);
    if (!result) throw new Error('KeePass 来源工作副本无法发布。');
    signal?.throwIfAborted();
    const record = await this.storage.read(account.id);
    if (!record) throw new Error('KeePass 来源工作副本不存在。');
    try {
      if (record.workingSha256 !== group.receipt.outputSha256 || record.workingSha256 !== result.workingSha256 || account.config.sourceMode !== 'local-file' && record.baseSha256 !== record.workingSha256)
        throw new Error('KeePass 来源发布版本尚未确认。');
      const current = await this.provider.refreshFromSession(account, group.sources, new Date().toISOString());
      if (group.sources.some(source => !current.items.some(item => item.keepassEntryUuid === source.keepassEntryUuid && item.deletedAt)))
        throw new Error('KeePass 来源项目已被恢复或变化，目标副本保留，请核对来源后继续。');
      signal?.throwIfAborted(); return result;
    } finally { record.baseBytes.fill(0); record.workingBytes.fill(0); }
  }
}
