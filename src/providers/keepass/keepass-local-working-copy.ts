import type { ProviderAccount } from '../../core/model';
import { keePassSourceRemovalRequestHash, type KeePassSourceRemovalRequest } from './keepass-source-removal';
import { keePassTransferRequestHash, type KeePassTransferDraft } from './keepass-transfer-file';
import type { KeePassProjectRemovalDraft } from '../../core/keepass-project-removal';
import { keePassRemovalFileRequestHash } from '../../core/keepass-project-removal-journal';
import { KeePassProvider, type KeePassUnlockCredential } from './keepass-provider';
import { openKeePassDurableReceipt, sealKeePassDurableReceipt } from './keepass-receipt-crypto';
import type { KeePassDurableMutationReceipt, KeePassRemoteWorkingCopyRecord, KeePassWorkingCopyStorage } from './keepass-working-copy-store';

export const KEEPASS_LOCAL_SOURCE_HASH = 'localFileSourceSha256';
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))]
  .map(value => value.toString(16).padStart(2, '0')).join('');
const invalidSource = () => new Error('本地 KeePass 文件来源已变化，请核对原文件和待保存修改。');

/** Encrypted file checkpoints, not a writable handle to the user's original file.
 * Database credentials remain in the provider session. Only the receipt key is
 * held in the enclosing encrypted Monica provider configuration.
 */
export class KeePassLocalWorkingCopyService {
  private readonly queues = new Map<string, Promise<void>>();
  constructor(private readonly provider: KeePassProvider, private readonly storage: KeePassWorkingCopyStorage) {}

  private assertSource(account: ProviderAccount) {
    if (account.kind !== 'keepass' || !account.enabled || account.config.sourceMode !== 'local-file' ||
      typeof account.config[KEEPASS_LOCAL_SOURCE_HASH] !== 'string' || !/^[a-f0-9]{64}$/.test(account.config[KEEPASS_LOCAL_SOURCE_HASH] as string))
      throw invalidSource();
  }

  private async checkedRecord(account: ProviderAccount) {
    this.assertSource(account);
    const record = await this.storage.read(account.id);
    if (!record) throw new Error('本地 KeePass 恢复副本不存在，请重新打开原文件。');
    try {
      if (record.baseSha256 !== account.config[KEEPASS_LOCAL_SOURCE_HASH] ||
        await digest(record.baseBytes) !== record.baseSha256 || await digest(record.workingBytes) !== record.workingSha256)
        throw invalidSource();
      return record;
    } catch (cause) { this.release(record); throw cause; }
  }

  /** First capture only. Never replace an existing checkpoint with an old picker file. */
  async initialize(account: ProviderAccount, originalFile: Uint8Array) {
    const source = structuredClone(account), original = originalFile.slice();
    try {
      this.assertSource(source);
      if (await digest(original) !== source.config[KEEPASS_LOCAL_SOURCE_HASH]) throw invalidSource();
      await this.exclusive(source.id, async () => {
        const existing = await this.storage.read(source.id);
        if (existing) {
          this.release(existing);
          const current = await this.checkedRecord(source); this.release(current); return;
        }
        const hash = await digest(original);
        const saved = await this.storage.save({ providerId: source.id, baseBytes: original, workingBytes: original,
          baseSha256: hash, workingSha256: hash, updatedAt: new Date().toISOString() }, 0);
        this.release(saved);
      });
    } finally { original.fill(0); }
  }

  async reconcileAccountConfig(account: ProviderAccount): Promise<Record<string, unknown>> {
    const record = await this.checkedRecord(account);
    try { return { ...account.config, workingSha256: record.workingSha256 }; }
    finally { this.release(record); }
  }

  /** Capture live changes before preparing a complete project transaction. */
  async persistWorkingCopy(account: ProviderAccount, receipt?: KeePassDurableMutationReceipt) {
    const source = structuredClone(account);
    return this.exclusive(source.id, async () => {
      const record = await this.checkedRecord(source);
      let bytes: Uint8Array | undefined;
      try {
        const assertCurrent = this.provider.localSessionGuard(source);
        bytes = await this.provider.snapshotFile(source.id);
        const workingSha256 = await digest(bytes);
        if (receipt && receipt.providerId !== source.id) throw invalidSource();
        const encrypted = receipt ? await sealKeePassDurableReceipt(source, receipt) : undefined;
        assertCurrent();
        const saved = await this.storage.save({ ...record, workingBytes: bytes, workingSha256,
          updatedAt: new Date().toISOString() }, record.revision, encrypted);
        const result = { revision: saved.revision, workingSha256, accountConfig: { ...source.config, workingSha256 } };
        this.release(saved); return result;
      } finally { bytes?.fill(0); this.release(record); }
    });
  }

  async readDurableReceipt(account: ProviderAccount, operationId: string, kind: string, intentSha256: string) {
    const receipt = await this.readAnyDurableReceipt(account, operationId);
    if (!receipt) return undefined;
    if (receipt.kind !== kind || receipt.intentSha256 !== intentSha256) throw new Error('KeePass 恢复操作与原请求不一致。');
    return receipt;
  }

  async readAnyDurableReceipt(account: ProviderAccount, operationId: string) {
    const record = await this.checkedRecord(account); this.release(record);
    const encrypted = await this.storage.readReceipt(account.id, operationId);
    return encrypted ? openKeePassDurableReceipt(account, encrypted) : undefined;
  }

  async deleteDurableReceipt(account: ProviderAccount, operationId: string) {
    const record = await this.checkedRecord(account); this.release(record);
    await this.storage.deleteReceipt(account.id, operationId);
  }

  /** Common sync adapter: a local checkpoint has no remote publication step. */
  async publishWorkingCopy(account: ProviderAccount, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const record = await this.checkedRecord(account);
    try { return { status: 'unchanged' as const, revision: record.revision, workingSha256: record.workingSha256,
      accountConfig: { ...account.config, workingSha256: record.workingSha256 } }; }
    finally { this.release(record); }
  }

  async assertPickedFile(account: ProviderAccount, bytes: Uint8Array) {
    const record = await this.checkedRecord(account);
    try {
      const selected = await digest(bytes);
      if (selected !== record.baseSha256 && selected !== record.workingSha256 && selected !== account.config.localFileExportSha256)
        throw new Error('所选文件已在外部修改。请先导出本机恢复副本，再将该文件作为新的密码源打开。');
    } finally { this.release(record); }
  }

  async openPickedFile(account: ProviderAccount, bytes: Uint8Array, credential: KeePassUnlockCredential) {
    this.assertSource(account);
    const existing = await this.storage.read(account.id);
    if (existing) {
      this.release(existing);
      await this.assertPickedFile(account, bytes);
      return this.restore(account, credential);
    }
    if (await this.storage.hasReceipts(account.id) ||
      (account.config.workingSha256 && account.config.workingSha256 !== account.config[KEEPASS_LOCAL_SOURCE_HASH]) ||
      await digest(bytes) !== account.config[KEEPASS_LOCAL_SOURCE_HASH])
      throw invalidSource();
    const session = await this.provider.unlock(account, bytes, credential);
    await this.initialize(account, bytes);
    return session;
  }

  async reload(account: ProviderAccount) {
    const record = await this.checkedRecord(account);
    try { return await this.provider.reloadLocalFile(account, record.workingBytes, this.hasUnexportedChanges(account, record)); }
    finally { this.release(record); }
  }

  async exportFile(account: ProviderAccount) {
    const source = structuredClone(account);
    return this.exclusive(source.id, async () => {
      const record = await this.checkedRecord(source);
      let bytes: Uint8Array | undefined;
      try {
        const assertCurrent = this.provider.localSessionGuard(source);
        bytes = await this.provider.snapshotFile(source.id);
        const sha256 = await digest(bytes); assertCurrent();
        const saved = await this.storage.save({ ...record, workingBytes: bytes, workingSha256: sha256,
          updatedAt: new Date().toISOString() }, record.revision);
        this.release(saved); assertCurrent();
        return { bytes, accountConfig: { ...source.config, workingSha256: sha256, localFileExportSha256: sha256 } };
      } catch (cause) { bytes?.fill(0); throw cause; }
      finally { this.release(record); }
    });
  }

  async persistProjectRemoval(account: ProviderAccount, input: {
    operationId: string; expectedWorkingSha256: string; draft: KeePassProjectRemovalDraft;
  }): Promise<KeePassDurableMutationReceipt> {
    const source = structuredClone(account), request = structuredClone(input);
    this.assertSource(source);
    const intentSha256 = await keePassRemovalFileRequestHash(source, request);
    return this.exclusive(source.id, async () => {
      const previous = await this.readDurableReceipt(source, request.operationId, 'project-remove', intentSha256);
      if (previous) return previous;
      const record = await this.checkedRecord(source);
      let bytes: Uint8Array | undefined;
      try {
        const assertCurrent = this.provider.localSessionGuard(source);
        if (record.workingSha256 !== request.expectedWorkingSha256) throw new Error('KeePass 文件版本已变化，原密码尚未移除。');
        const result = await this.provider.prepareLocalProjectRemovalFile(source, request.draft,
          { bytes: record.workingBytes, expectedSha256: request.expectedWorkingSha256 });
        bytes = result.bytes;
        const receipt: KeePassDurableMutationReceipt = { providerId: source.id, operationId: request.operationId,
          kind: 'project-remove', intentSha256, completedAt: new Date().toISOString(), result: { type: 'project-remove',
            inputSha256: result.inputSha256, outputSha256: result.outputSha256, snapshotItems: result.items } };
        const encrypted = await sealKeePassDurableReceipt(source, receipt);
        assertCurrent();
        const saved = await this.storage.save({ ...record, workingBytes: bytes, workingSha256: result.outputSha256,
          updatedAt: receipt.completedAt }, record.revision, encrypted);
        this.release(saved); return receipt;
      } finally { bytes?.fill(0); this.release(record); }
    });
  }

  /** Commit encrypted batch bytes and mapping before any live reload or export. */
  async persistTransfer(account: ProviderAccount, input: { expectedWorkingSha256: string; draft: KeePassTransferDraft }): Promise<KeePassDurableMutationReceipt> {
    const source = structuredClone(account), request = structuredClone(input);
    this.assertSource(source);
    const intentSha256 = await keePassTransferRequestHash(source, request);
    return this.exclusive(source.id, async () => {
      const previous = await this.readDurableReceipt(source, request.draft.operationId, 'batch-transfer', intentSha256);
      if (previous) return previous;
      const record = await this.checkedRecord(source);
      let output: Uint8Array | undefined;
      try {
        const assertCurrent = this.provider.localSessionGuard(source);
        if (record.workingSha256 !== request.expectedWorkingSha256) throw new Error('目标 KeePass 文件已变化，请重新预览。');
        const result = await this.provider.prepareTransferFile(source, request.draft, { bytes: record.workingBytes, expectedSha256: record.workingSha256 });
        output = result.bytes;
        const receipt: KeePassDurableMutationReceipt = { providerId: source.id, operationId: request.draft.operationId,
          kind: 'batch-transfer', intentSha256, completedAt: new Date().toISOString(), result: { type: 'batch-transfer',
            inputSha256: result.inputSha256, outputSha256: result.outputSha256, snapshotItems: result.items, entries: result.entries } };
        const encrypted = await sealKeePassDurableReceipt(source, receipt);
        assertCurrent(); result.assertCurrent();
        const saved = await this.storage.save({ ...record, workingBytes: output, workingSha256: result.outputSha256,
          updatedAt: receipt.completedAt }, record.revision, encrypted);
        this.release(saved); return receipt;
      } finally { output?.fill(0); this.release(record); }
    });
  }

  /** The caller holds the provider operation queue and has saved authorization. */
  async persistSourceRemoval(account: ProviderAccount, input: KeePassSourceRemovalRequest): Promise<KeePassDurableMutationReceipt> {
    const source = structuredClone(account), request = structuredClone(input);
    this.assertSource(source);
    const intentSha256 = await keePassSourceRemovalRequestHash(source, request);
    return this.exclusive(source.id, async () => {
      const previous = await this.readDurableReceipt(source, request.operationId, 'transfer-source-remove', intentSha256);
      if (previous) return previous;
      const record = await this.checkedRecord(source);
      let output: Uint8Array | undefined;
      try {
        if (record.workingSha256 !== request.expectedWorkingSha256) throw new Error('KeePass 来源文件版本已变化，原文件已保留。');
        const result = await this.provider.prepareSourceRemovalFile(source, request, record.workingBytes);
        output = result.bytes;
        const receipt: KeePassDurableMutationReceipt = { providerId: source.id, operationId: request.operationId,
          kind: 'transfer-source-remove', intentSha256, completedAt: new Date().toISOString(), result: { type: 'transfer-source-remove',
            inputSha256: result.inputSha256, outputSha256: result.outputSha256, recycleBinUuid: result.recycleBinUuid, entries: result.entries } };
        const encrypted = await sealKeePassDurableReceipt(source, receipt); result.assertCurrent();
        const saved = await this.storage.save({ ...record, workingBytes: output, workingSha256: result.outputSha256,
          updatedAt: receipt.completedAt }, record.revision, encrypted);
        this.release(saved); return receipt;
      } finally { output?.fill(0); this.release(record); }
    });
  }

  /** Requires the user-supplied file credential again after a lock/restart. */
  async restore(account: ProviderAccount, credential: KeePassUnlockCredential) {
    const record = await this.checkedRecord(account);
    try {
      return await this.provider.unlock(account, record.workingBytes, { ...credential,
        sourceMode: 'local-file', dirty: this.hasUnexportedChanges(account, record) });
    } finally { this.release(record); }
  }

  private release(record: KeePassRemoteWorkingCopyRecord) { record.baseBytes.fill(0); record.workingBytes.fill(0); }
  private hasUnexportedChanges(account: ProviderAccount, record: KeePassRemoteWorkingCopyRecord) {
    return record.workingSha256 !== record.baseSha256 && record.workingSha256 !== account.config.localFileExportSha256;
  }
  private async exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(id) || Promise.resolve();
    const current = prior.catch(() => undefined).then(operation);
    const tail = current.then(() => undefined, () => undefined);
    this.queues.set(id, tail);
    try { return await current; } finally { if (this.queues.get(id) === tail) this.queues.delete(id); }
  }
}
