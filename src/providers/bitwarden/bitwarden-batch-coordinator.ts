import type { ProviderAccount, VaultItem, VaultState } from '../../core/model';
import type { ProviderAdapter } from '../../core/provider';
import { sameProviderBinding } from '../../core/provider';
import { bitwardenBatchOrder, bitwardenBatchSnapshotHash, bitwardenBatchSourceHash, normalizeBitwardenBatchRequest, readBitwardenBatches,
  type BitwardenBatchIntent, type BitwardenBatchFolder } from '../../core/bitwarden-batch-transfer';
import type { BitwardenCipherCopyRecord } from '../../core/bitwarden-transfer-journal';
import { bitwardenTransferSelection } from './bitwarden-transfer-selection';
import { bitwardenProjectCipherId } from '../../core/bitwarden-project-removal-local';
import { passwordGroupKey } from '../../core/password-groups';
import { resolveSsoAccount } from '../../core/sso-links';
import { mdbx2TransferOperationScope as hash, mdbx2TransferUuid as uuid } from '../mdbx2/mdbx2-transfer-identity';
import type { Mdbx2BatchTransferRequest, Mdbx2BatchTransferPlanResult, Mdbx2BatchTransferExecuteResult, Mdbx2BatchTransferProgressListener } from '../mdbx2/mdbx2-batch-transfer-coordinator';
import type { SecureVaultService } from '../../security/secure-vault-service';
import type { BitwardenBatchResource } from './bitwarden-batch-resource';
import { BitwardenClient, type BitwardenSessionConfig } from './bitwarden-client';
import { decryptBitwardenString, encryptBitwardenString, type BitwardenSymmetricKey } from './bitwarden-crypto';
import { prepareBitwardenTransferCipher } from './bitwarden-transfer-cipher';
import { executeBitwardenBatchFolders, readBitwardenBatchFolders, type BitwardenBatchFolderRemote, type BitwardenBatchStore } from './bitwarden-batch-folders';
import { executeBitwardenCipherCopy, type BitwardenCopyRemote } from './bitwarden-transfer-execution';

type Vault = Pick<SecureVaultService, 'readState' | 'stageBitwardenBatch' | 'openBitwardenBatchStore' | 'applyProviderSync' | 'passkeySessionId'>;
interface Dependencies {
  resource(state: VaultState, items: VaultItem[], preserveCategories: boolean): Promise<BitwardenBatchResource>;
  folders(account: ProviderAccount, signal?: AbortSignal): Promise<unknown>;
  folderRemote(copyId: string, store: BitwardenBatchStore): BitwardenBatchFolderRemote;
  remote(copyId: string, store: BitwardenBatchStore): BitwardenCopyRemote & { dispose(): void };
  exclusive<T>(providerId: string, work: () => Promise<T>): Promise<T>;
}
type Saved = { batch: BitwardenBatchIntent; copies: BitwardenCipherCopyRecord[]; fingerprints: Map<string, string>; timer: ReturnType<typeof setTimeout> };

export class BitwardenBatchTransferCoordinator {
  private plans = new Map<string, Saved>();
  private generation = 0;
  private controller = new AbortController();
  constructor(private readonly vault: Vault, private readonly provider: Pick<ProviderAdapter, 'sync'>, private readonly dependencies: Dependencies) {}
  clear() { this.generation++; this.controller.abort(); this.controller = new AbortController(); for (const row of this.plans.values()) clearTimeout(row.timer); this.plans.clear(); }
  async pending(providerId: string) { return readBitwardenBatches((await this.vault.readState(false)).bitwardenBatchTransfers)
    .filter(row => row.target.id === providerId && row.status === 'writing').map(row => ({ request: row.request, plan: row.plan })); }

  async plan(input: Mdbx2BatchTransferRequest): Promise<Mdbx2BatchTransferPlanResult> {
    const request = normalizeBitwardenBatchRequest(input), generation = this.generation, signal = this.controller.signal;
    return this.dependencies.exclusive(request.targetProviderId, async () => {
      this.check(generation); const state = await this.vault.readState(false), target = this.target(state, request.targetProviderId);
      if (readBitwardenBatches(state.bitwardenBatchTransfers).some(row => row.target.id === target.id && row.status === 'writing')) throw new Error('Bitwarden 有待恢复的整批传输，请先恢复。');
      const snapshotHash = await bitwardenBatchSnapshotHash(state, request), selection = bitwardenTransferSelection(request.itemIds, state.items, state.providers);
      const selected = selection.selectedIds.map(id => state.items.find(row => row.id === id)!);
      if (selected.some(row => !row)) throw new Error('所选来源不存在。');
      const key = new BitwardenClient().vaultKey(target.config as BitwardenSessionConfig);
      try {
        const rawFolders = readBitwardenBatchFolders(await this.dependencies.folders(target, signal)); this.check(generation);
        const catalog = await Promise.all(rawFolders.map(async row => ({ ...row, name: await decryptBitwardenString(row.encryptedName, key) })));
        const parent = request.targetCollectionId ? catalog.find(row => row.id === request.targetCollectionId) : undefined;
        if (request.targetCollectionId && !parent) throw new Error('Bitwarden 目标文件夹不存在。');
        const blocked = new Map<string, string>(), paths = new Map<string, string[]>(), fingerprints = new Map<string, string>();
        const groups = new Map<string, VaultItem[]>(), copies: BitwardenCipherCopyRecord[] = [], folders: BitwardenBatchFolder[] = [];
        const units: BitwardenBatchIntent['units'] = [];
        for (const item of selected) {
          const account = item.providerRefs.length === 1 && state.providers.find(row => row.id === item.providerRefs[0].providerId);
          const native = account && account.kind === 'bitwarden' && bitwardenProjectCipherId(item.providerRefs[0].remoteId || '');
          const identity = native ? JSON.stringify([account.id, native]) : `item:${item.id}`;
          groups.set(identity, [...(groups.get(identity) || []), item]);
        }
        for (const [identity, items] of groups) {
          try {
            if (request.action !== 'copy') throw new Error('Bitwarden 跨库移动的来源删除恢复尚未完成，请使用复制。');
            const sourceSnapshotSha256 = await bitwardenBatchSourceHash(state, items.map(row => row.id));
            const resource = await this.dependencies.resource(state, items, request.preserveCategories);
            try {
              if ([...copies.flatMap(row => row.files), ...resource.files].reduce((sum, file) => sum + file.sizeBytes, 0) > 16 * 1024 * 1024)
                throw new Error('Bitwarden 整批附件超过 16 MiB，请减少本次选择。');
              items.forEach(row => paths.set(row.id, resource.path));
              const name = [parent?.name, ...resource.path].filter(Boolean).join('/');
              let folder: BitwardenBatchFolder | undefined;
              if (name) {
                if (name.length > 500 || resource.path.some(part => !part.trim() || /^\/|\/$|\/\//.test(part))) throw new Error('来源文件夹路径无法完整表示。');
                folder = folders.find(row => row.name === name);
                if (!folder) {
                  const matches = parent && !resource.path.length ? [parent] : catalog.filter(row => row.name === name);
                  if (matches.length > 1) throw new Error('目标有多个同名文件夹，请明确选择目标或先整理文件夹。');
                  folder = { key: await uuid(request.operationId, `folder:${name}`), name,
                    encryptedName: matches[0]?.encryptedName || await encryptBitwardenString(name, key),
                    stage: matches[0] ? 'existing' : 'prepared', ...(matches[0] ? { targetId: matches[0].id } : {}) }; folders.push(folder);
                }
              }
              const login = items.find(row => row.kind === 'login'), copyId = await uuid(request.operationId, identity);
              const prepared = await prepareBitwardenTransferCipher({ operationId: request.operationId, copyId, targetProviderId: target.id,
                targetProjectId: login?.kind === 'login' && login.passwordGroupId ? await uuid(request.operationId, passwordGroupKey(login)) : undefined,
                source: resource.raw, sourceOwnerKey: resource.ownerKey, targetOwnerKey: key, deferSsoBinding: true });
              if (folder) prepared.pendingFolderKey = folder.key;
              copies.push({ version: 1, revision: 0, target: structuredClone(target), sourceItemIds: items.map(row => row.id), sourceSnapshotSha256,
                prepared, files: resource.files, attachmentReceipts: [], stage: 'prepared', batchOperationId: request.operationId });
              units.push({ copyId, folderKey: folder?.key, sources: items.map(row => ({ id: row.id, kind: row.kind, ...(row.kind === 'passkey' ? { credentialId: row.credentialId } : {}) })) });
              fingerprints.set(copyId, resource.fingerprint);
            } finally { resource.dispose(); }
          } catch (error) { items.forEach(row => blocked.set(row.id, message(error))); }
          this.check(generation);
        }
        for (const unit of units) {
          const login = selected.find(row => row.kind === 'login' && unit.sources.some(source => source.id === row.id));
          if (login?.kind === 'login' && login.ssoRefLogicalId) {
            const dependency = resolveSsoAccount(login, state.items), targetUnit = units.find(row => row.sources.some(source => source.id === dependency?.id));
            if (!targetUnit) unit.sources.forEach(row => blocked.set(row.id, 'SSO 关联账户不能完整转入目标。'));
            else unit.ssoTargetCopyId = targetUnit.copyId;
          }
        }
        for (const component of selection.components) { const reason = component.map(id => blocked.get(id)).find(Boolean); if (reason) component.forEach(id => blocked.set(id, reason)); }
        const accepted = units.filter(row => !row.sources.some(source => blocked.has(source.id)));
        try { bitwardenBatchOrder(accepted); } catch (error) { accepted.forEach(row => row.sources.forEach(source => blocked.set(source.id, message(error)))); }
        const finalUnits = accepted.filter(row => !row.sources.some(source => blocked.has(source.id)));
        const plan: Mdbx2BatchTransferPlanResult = { ...request, items: selected.map(row => ({ sourceItemId: row.id, title: row.title, kind: row.kind,
          effectiveAction: 'copy', blockedReason: blocked.get(row.id), sourcePath: paths.get(row.id) || [],
          targetPath: [parent?.name, ...(paths.get(row.id) || [])].filter((s): s is string => !!s), pathIncomplete: false })),
          blockedCount: blocked.size, transferableCount: selected.length - blocked.size, requiresMoveConfirmation: false, warnings: [] };
        if (snapshotHash !== await bitwardenBatchSnapshotHash(await this.vault.readState(false), request)) throw new Error('生成预览期间来源或目标已变化，请重试。');
        this.check(generation);
        const batch: BitwardenBatchIntent = { version: 1, request, requestHash: await hash(request), target: structuredClone(target), snapshotHash, plan,
          units: finalUnits, folders: folders.filter(row => finalUnits.some(unit => unit.folderKey === row.key)), status: 'writing' };
        this.forget(request.operationId);
        while (this.plans.size >= 4) this.forget(this.plans.keys().next().value!);
        const timer = setTimeout(() => this.forget(request.operationId), 5 * 60_000); if (typeof timer === 'object') timer.unref?.();
        this.plans.set(request.operationId, { batch, copies: copies.filter(row => finalUnits.some(unit => unit.copyId === row.prepared.copyId)), fingerprints, timer });
        return structuredClone(plan);
      } finally { clearKey(key); }
    });
  }

  async execute(input: Mdbx2BatchTransferRequest, progress?: Mdbx2BatchTransferProgressListener): Promise<Mdbx2BatchTransferExecuteResult> {
    if (!input.operationId || !input.operationCreatedAt) throw new Error('请先生成传输预览。');
    const request = normalizeBitwardenBatchRequest(input), generation = this.generation, signal = this.controller.signal;
    return this.dependencies.exclusive(request.targetProviderId, async () => {
      this.check(generation); const state = await this.vault.readState(false), target = this.target(state, request.targetProviderId), requestHash = await hash(request);
      let batch = readBitwardenBatches(state.bitwardenBatchTransfers).find(row => row.request.operationId === request.operationId);
      if (batch && (batch.requestHash !== requestHash || batch.status === 'cancelled' || !sameProviderBinding(batch.target, target))) throw new Error('传输请求与原计划不一致或已取消。');
      if (batch?.status === 'completed') return batch.result!;
      const sessionId = await this.vault.passkeySessionId(); if (!sessionId) throw new Error('密码库已锁定。');
      if (!batch) {
        const saved = this.plans.get(request.operationId);
        if (!saved || saved.batch.requestHash !== requestHash || !saved.batch.plan.transferableCount) throw new Error('传输预览已过期或没有可复制项目，请重新预览。');
        if (saved.batch.snapshotHash !== await bitwardenBatchSnapshotHash(state, request)) throw new Error('预览后来源或目标已变化，请重新预览。');
        for (const unit of saved.batch.units) {
          const resource = await this.dependencies.resource(state, unit.sources.map(row => state.items.find(item => item.id === row.id)!), request.preserveCategories);
          try { if (resource.fingerprint !== saved.fingerprints.get(unit.copyId)) throw new Error('来源字段、附件或文件夹在预览后已变化。'); }
          finally { resource.dispose(); } this.check(generation);
        }
        batch = await this.vault.stageBitwardenBatch(saved.batch, saved.copies); this.check(generation); this.forget(request.operationId);
      }
      const store = await this.vault.openBitwardenBatchStore(), anchor = batch.units[0].copyId;
      const account = await store.copies.account(anchor), key = new BitwardenClient().vaultKey(account.config as BitwardenSessionConfig);
      try {
        progress?.(this.progress(batch, 'writing'));
        await executeBitwardenBatchFolders(request.operationId, store, this.dependencies.folderRemote(anchor, store), key, signal); this.check(generation);
        let processed = batch.plan.blockedCount;
        for (const unit of bitwardenBatchOrder(batch.units)) {
          await store.copies.materialize(unit.copyId); this.check(generation);
          const remote = this.dependencies.remote(unit.copyId, store);
          try { await executeBitwardenCipherCopy(unit.copyId, store.copies, remote, key, signal); } finally { remote.dispose(); }
          processed += unit.sources.length; progress?.({ ...this.progress(batch, 'writing'), processed });
          this.check(generation);
        }
        progress?.({ ...this.progress(batch, 'finalizing'), processed });
        // Confirm folders again after all uploads, then refresh every native
        // sibling with a read-only sync and adopt the whole batch atomically.
        await executeBitwardenBatchFolders(request.operationId, store, this.dependencies.folderRemote(anchor, store), key, signal);
        const latest = await this.vault.readState(false), current = await store.copies.account(anchor);
        const verified = (await Promise.all(batch.units.map(row => store.copies.read(row.copyId)))).flatMap(row => row.verifiedItems || []);
        const known = new Set(latest.items.map(row => row.id)), identities = [...latest.items, ...verified.filter(row => !known.has(row.id))];
        const result = await this.provider.sync(current, { now: new Date().toISOString(), localItems: identities, pendingMutations: [], readOnly: true, signal });
        this.check(generation);
        if (result.accountPatch?.config) await store.copies.saveSession(anchor, current, result.accountPatch.config as BitwardenSessionConfig);
        await this.vault.applyProviderSync(target.id, result.items, result.accountPatch, result.conflicts, result.sourceRecords, latest.items,
          result.acknowledgedMutations || [], result.requestedMutations || [], false, [], { expectedAccount: current, bitwardenBatchTransfer: { operationId: request.operationId, sessionId } });
        const completed = await store.read(request.operationId); if (completed.status !== 'completed' || !completed.result) throw new Error('整批入库尚未确认。');
        progress?.({ ...this.progress(batch, 'completed'), processed: batch.plan.items.length, completedCount: completed.result.completedCount }); return completed.result;
      } finally { clearKey(key); }
    });
  }
  async cancel(providerId: string, operationId: string) { return this.dependencies.exclusive(providerId, async () => {
    const store = await this.vault.openBitwardenBatchStore(), batch = await store.read(operationId);
    if (batch.target.id !== providerId) throw new Error('传输目标不匹配。'); await store.cancel(operationId); this.forget(operationId);
  }); }
  private forget(id: string) { const saved = this.plans.get(id); if (saved) clearTimeout(saved.timer); this.plans.delete(id); }
  private target(state: VaultState, id: string) { const account = state.providers.find(row => row.id === id);
    if (!account?.enabled || account.kind !== 'bitwarden') throw new Error('目标 Bitwarden 不可用。'); return account; }
  private check(generation: number) { if (generation !== this.generation) throw new Error('密码库已锁定，已保存的传输可在解锁后恢复。'); }
  private progress(batch: BitwardenBatchIntent, phase: 'writing' | 'finalizing' | 'completed') { return { operationId: batch.request.operationId, phase,
    processed: 0, total: batch.plan.items.length, completedCount: 0, blockedCount: batch.plan.blockedCount, failedCount: 0 }; }
}
function clearKey(key: BitwardenSymmetricKey) { key.encKey.fill(0); key.macKey.fill(0); }
function message(error: unknown) { return error instanceof Error ? error.message : '来源无法完整读取。'; }
