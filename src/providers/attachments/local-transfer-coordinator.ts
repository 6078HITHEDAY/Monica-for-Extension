import type { VaultItem, VaultState } from '../../core/model';
import { isLocalTransferItem, prepareLocalTransferBatch, readLocalTransferReceipts, LOCAL_ATTACHMENT_MAX_BYTES, type LocalTransferResource, type LocalTransferReceipt } from '../../core/local-transfer';
import type { SecureVaultService } from '../../security/secure-vault-service';
import { mdbx2TransferDependencies } from '../mdbx2/mdbx2-transfer-dependencies';
import { assertMdbx2TransferOperationId, mdbx2TransferOperationScope as hash } from '../mdbx2/mdbx2-transfer-identity';
import { sourceCategoryPath } from '../mdbx2/mdbx2-batch-transfer';
import type { Mdbx2BatchTransferRequest, Mdbx2BatchTransferPlanResult, Mdbx2BatchTransferExecuteResult, Mdbx2BatchTransferProgressListener } from '../mdbx2/mdbx2-batch-transfer-coordinator';
import { normalizeCredentialId } from '../../passkey/source-policy';

type Prepared = Awaited<ReturnType<SecureVaultService['prepareLocalTransfer']>>;
type Vault = Pick<SecureVaultService, 'prepareLocalTransfer' | 'commitLocalTransfer' | 'readState'>;
type Input = Mdbx2BatchTransferRequest & { operationId: string; operationCreatedAt: string };

/** Shared transfer UI contract, with local persistence and no Native Object claims. */
export class LocalTransferCoordinator {
  private plans = new Map<string, { requestHash: string; prepared?: Prepared; plan: Mdbx2BatchTransferPlanResult; timer: ReturnType<typeof setTimeout> }>();
  private generation = 0;
  constructor(private readonly vault: Vault, private readonly loadResource: (state: VaultState, item: VaultItem) => Promise<LocalTransferResource>) {}
  clear() { this.generation++; for (const row of this.plans.values()) clearTimeout(row.timer); this.plans.clear(); }
  private normalize(input: Mdbx2BatchTransferRequest): Input {
    if (!Array.isArray(input.itemIds) || !input.itemIds.length || input.itemIds.length > 200 || input.itemIds.some(id => typeof id !== 'string' || !id)
      || new Set(input.itemIds).size !== input.itemIds.length || typeof input.targetProviderId !== 'string' || !['copy', 'move'].includes(input.action)
      || typeof input.preserveCategories !== 'boolean'
      || (input.targetCollectionId !== undefined && typeof input.targetCollectionId !== 'string')
      || (input.operationCreatedAt !== undefined && (typeof input.operationCreatedAt !== 'string' || !Number.isFinite(Date.parse(input.operationCreatedAt))))) throw new Error('传输请求无效。');
    return { itemIds: [...input.itemIds].sort(), targetProviderId: input.targetProviderId, targetCollectionId: input.targetCollectionId || undefined,
      preserveCategories: input.preserveCategories, action: input.action, operationId: assertMdbx2TransferOperationId(input.operationId || crypto.randomUUID()),
      operationCreatedAt: input.operationCreatedAt || new Date().toISOString() };
  }
  async plan(input: Mdbx2BatchTransferRequest): Promise<Mdbx2BatchTransferPlanResult> {
    const request = this.normalize(input), requestHash = await hash(request), generation = this.generation;
    const state = await this.vault.readState(false), dependencies = mdbx2TransferDependencies(request.itemIds, state.items, request.action);
    if (dependencies.selectedIds.length > 200) throw new Error('包含关联项目后超过单次 200 项上限。');
    const sources = state.items.filter(row => dependencies.selectedIds.includes(row.id)).sort((a, b) => a.id.localeCompare(b.id));
    const blocked = new Map<string, string>(), resources: LocalTransferResource[] = [], paths = new Map<string, string[]>(), warnings: string[] = [];
    let resourceBytes = 0;
    for (const item of sources) {
      try {
        if (!isLocalTransferItem(item, state.providers)) {
          if (request.action === 'move') throw new Error('此来源的跨库移动仍需持久删除恢复，请使用复制保留来源。');
          const resource = await this.loadResource(state, item);
          const size = resource.attachments.reduce((sum, file) => sum + file.sizeBytes, 0);
          if (!Number.isSafeInteger(size) || size < 0 || resourceBytes + size > LOCAL_ATTACHMENT_MAX_BYTES)
            throw new Error('本地传输附件合计超过 16 MiB 上限，请减少选择。');
          resourceBytes += size; resources.push(resource);
          paths.set(item.id, resource.folder?.label ? [resource.folder.label] : []);
        } else paths.set(item.id, sourceCategoryPath(item).segments);
        if (item.kind === 'passkey' && (item.backupEligible === false || item.signCount > 0 || item.algorithm !== -7))
          warnings.push(`Passkey「${item.title}」跨端受限：注册标志、原始算法和计数保持不变，其他设备或网站可能无法使用。`);
      } catch (error) { blocked.set(item.id, error instanceof Error ? error.message : '来源无法读取。'); }
      if (generation !== this.generation) throw new Error('密码库已锁定，传输预览已取消。');
    }
    const accepted = new Set<string>(), credentials = new Set<string>();
    const localRequest = { operationId: request.operationId, createdAt: request.operationCreatedAt, targetProviderId: request.targetProviderId,
      action: request.action, preserveCategories: request.preserveCategories, targetFolder: request.targetCollectionId };
    for (const component of dependencies.components) {
      let reason = component.map(id => blocked.get(id)).find(Boolean);
      if (!reason) try {
        const selected = sources.filter(row => component.includes(row.id));
        const passkeys = selected.flatMap(row => row.kind === 'passkey' ? [normalizeCredentialId(row.credentialId)] : []);
        if (passkeys.some(id => credentials.has(id))) throw new Error('所选项目包含相同 Passkey 凭据，请只选择一个来源副本。');
        await prepareLocalTransferBatch(state, { ...localRequest, itemIds: component }, resources.filter(row => component.includes(row.expected.id)));
        passkeys.forEach(id => credentials.add(id));
      } catch (error) { reason = error instanceof Error ? error.message : '关联项目无法完整传输。'; }
      for (const id of component) { if (reason) blocked.set(id, reason); else accepted.add(id); }
    }
    const review = { requestHash, warnings, items: sources.map(item => ({ sourceItemId: item.id, title: item.title, kind: item.kind, blockedReason: blocked.get(item.id) })) };
    const prepared = accepted.size ? await this.vault.prepareLocalTransfer({ ...localRequest, itemIds: [...accepted].sort(), review,
      sourceSnapshotHash: await hash(sources.filter(row => accepted.has(row.id))) }, resources.filter(row => accepted.has(row.expected.id))) : undefined;
    if (generation !== this.generation) throw new Error('密码库已锁定，传输预览已取消。');
    const plan: Mdbx2BatchTransferPlanResult = { ...request, items: review.items.map(row => {
      const entry = prepared?.batch.receipt.entries.find(item => item.sourceItemId === row.sourceItemId);
      const target = prepared?.batch.items.find(item => item.id === entry?.targetItemId);
      return { ...row, effectiveAction: request.action, sourcePath: paths.get(row.sourceItemId) || [], targetPath: target?.categoryName ? [target.categoryName] : [], pathIncomplete: false };
    }), blockedCount: blocked.size, transferableCount: accepted.size, requiresMoveConfirmation: request.action === 'move' && accepted.size > 0, warnings };
    const old = this.plans.get(request.operationId); if (old) clearTimeout(old.timer);
    while (!this.plans.has(request.operationId) && this.plans.size >= 4) {
      const first = this.plans.keys().next().value!;
      clearTimeout(this.plans.get(first)!.timer); this.plans.delete(first);
    }
    const timer = setTimeout(() => this.plans.delete(request.operationId), 5 * 60_000);
    if (typeof timer === 'object') timer.unref?.();
    this.plans.set(request.operationId, { requestHash, prepared, plan, timer });
    return structuredClone(plan);
  }
  async execute(input: Mdbx2BatchTransferRequest, progress?: Mdbx2BatchTransferProgressListener): Promise<Mdbx2BatchTransferExecuteResult> {
    if (!input.operationId || !input.operationCreatedAt) throw new Error('请先生成传输预览。');
    const request = this.normalize(input), requestHash = await hash(request);
    if (request.action === 'move' && input.confirmed !== true) throw new Error('移动项目需要明确确认。');
    const state = await this.vault.readState(false);
    const previous = readLocalTransferReceipts(state.localTransferReceipts).find(row => row.operationId === request.operationId);
    let result: Mdbx2BatchTransferExecuteResult;
    if (previous) {
      if (!previous.review || previous.review.requestHash !== requestHash) throw new Error('传输操作与原预览不一致。');
      result = this.result(request, previous);
    } else {
      const saved = this.plans.get(request.operationId);
      if (!saved || saved.requestHash !== requestHash || !saved.prepared) throw new Error('传输预览已过期或没有可传输项目，请重新预览。');
      progress?.({ operationId: request.operationId, phase: 'writing', processed: 0, total: saved.plan.items.length,
        completedCount: 0, blockedCount: saved.plan.blockedCount, failedCount: 0 });
      try {
        const committed = await this.vault.commitLocalTransfer(saved.prepared, input.confirmed === true);
        result = this.result(request, committed.receipt);
      } catch (error) {
        result = { operationId: request.operationId, action: request.action, targetProviderId: request.targetProviderId,
          items: saved.plan.items.map(row => ({ sourceItemId: row.sourceItemId, title: row.title, kind: row.kind, effectiveAction: row.effectiveAction,
            status: row.blockedReason ? 'blocked' : 'failed', retryable: !row.blockedReason, error: row.blockedReason || (error instanceof Error ? error.message : '本地保存失败。') })),
          completedCount: 0, blockedCount: saved.plan.blockedCount, failedCount: saved.plan.transferableCount, warnings: saved.plan.warnings };
      }
    }
    progress?.({ operationId: request.operationId, phase: result.failedCount ? 'failed' : 'completed', processed: result.items.length, total: result.items.length,
      completedCount: result.completedCount, blockedCount: result.blockedCount, failedCount: result.failedCount });
    return result;
  }
  private result(request: Input, receipt: LocalTransferReceipt): Mdbx2BatchTransferExecuteResult {
    const items = receipt.review!.items.map(row => ({ sourceItemId: row.sourceItemId, title: row.title, kind: row.kind, effectiveAction: request.action,
      status: row.blockedReason ? 'blocked' as const : 'completed' as const, retryable: false, error: row.blockedReason,
      targetItemId: receipt.entries.find(entry => entry.sourceItemId === row.sourceItemId)?.targetItemId }));
    return { operationId: request.operationId, action: request.action, targetProviderId: request.targetProviderId, items,
      completedCount: receipt.entries.length, blockedCount: items.length - receipt.entries.length, failedCount: 0, warnings: receipt.review!.warnings };
  }
}
