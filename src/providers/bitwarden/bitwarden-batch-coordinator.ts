import type { ProviderAccount, VaultItem, VaultState } from '../../core/model';
import type { ProviderAdapter } from '../../core/provider';
import { sameProviderBinding } from '../../core/provider';
import { assertBitwardenLocalMoveSource, bitwardenBatchAction, pendingBitwardenBatch, bitwardenBatchOrder, bitwardenBatchSnapshotHash, bitwardenBatchSourceHash, normalizeBitwardenBatchRequest, readBitwardenBatches,
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
import { bitwardenMdbxMoveSource, type BitwardenMdbxMoveGroup, type BitwardenMoveReadback } from '../../core/bitwarden-mdbx-move';
import { isLocalTransferItem } from '../../core/local-transfer';
import type { Mdbx2SourceDeletionIntent } from '../../core/mdbx2-source-deletion';
import type { Mdbx2ObjectBatchResult } from '../mdbx2/native-contract';

type Vault = Pick<SecureVaultService, 'readState' | 'stageBitwardenBatch' | 'openBitwardenBatchStore' | 'applyProviderSync' | 'passkeySessionId'
  | 'prepareBitwardenMdbxDeletion' | 'deleteBitwardenMdbxSources' | 'keepBitwardenBatchSources'>;
interface Dependencies {
  resource(state: VaultState, items: VaultItem[], preserveCategories: boolean): Promise<BitwardenBatchResource>;
  folders(account: ProviderAccount, signal?: AbortSignal): Promise<unknown>;
  folderRemote(copyId: string, store: BitwardenBatchStore): BitwardenBatchFolderRemote;
  remote(copyId: string, store: BitwardenBatchStore): BitwardenCopyRemote & { dispose(): void };
  exclusive<T>(providerId: string, work: () => Promise<T>): Promise<T>;
  exclusiveMany?<T>(providerIds: string[], work: () => Promise<T>): Promise<T>;
  mdbx?: {
    verify(state: VaultState, account: ProviderAccount, items: VaultItem[]): Promise<{ vaultId: string }>;
    prepare(group: BitwardenMdbxMoveGroup, targetId: string, verify: () => Promise<void>): Promise<Mdbx2SourceDeletionIntent>;
    remove(account: ProviderAccount, sources: VaultItem[], operationId: string, targetId: string, intent: Mdbx2SourceDeletionIntent): Promise<Mdbx2ObjectBatchResult>;
  };
}
type Saved = { batch: BitwardenBatchIntent; copies: BitwardenCipherCopyRecord[]; fingerprints: Map<string, string>; timer: ReturnType<typeof setTimeout> };

export class BitwardenBatchTransferCoordinator {
  private plans = new Map<string, Saved>();
  private generation = 0;
  private controller = new AbortController();
  constructor(private readonly vault: Vault, private readonly provider: Pick<ProviderAdapter, 'sync'>, private readonly dependencies: Dependencies) {}
  clear() { this.generation++; this.controller.abort(); this.controller = new AbortController(); for (const row of this.plans.values()) clearTimeout(row.timer); this.plans.clear(); }
  async pending(providerId: string) { return readBitwardenBatches((await this.vault.readState(false)).bitwardenBatchTransfers)
    .filter(row => row.target.id === providerId && row.status === 'writing').map(pendingBitwardenBatch); }

  /** Persist the decision before the UI resumes. No remote write is needed to
   * make a keep-both decision durable, even when the destination is offline. */
  async keepBoth(providerId: string, operationId: string, confirmed: boolean) {
    if (confirmed !== true) throw new Error('请先确认保留两端并按复制完成。');
    const generation = this.generation, sessionId = await this.vault.passkeySessionId();
    if (!sessionId) throw new Error('密码库已锁定。');
    const batch = readBitwardenBatches((await this.vault.readState(false)).bitwardenBatchTransfers).find(row => row.request.operationId === operationId);
    if (!batch || batch.target.id !== providerId) throw new Error('传输目标不匹配。');
    return this.exclusive(batch.request, async () => {
      this.check(generation);
      const saved = await this.vault.keepBitwardenBatchSources(providerId, operationId, confirmed, sessionId);
      this.check(generation); this.forget(operationId); return pendingBitwardenBatch(saved);
    });
  }

  async plan(input: Mdbx2BatchTransferRequest): Promise<Mdbx2BatchTransferPlanResult> {
    const request = normalizeBitwardenBatchRequest(input), generation = this.generation, signal = this.controller.signal;
    return this.exclusive(request, async () => {
      this.check(generation); const state = await this.vault.readState(false), target = this.target(state, request.targetProviderId);
      if (readBitwardenBatches(state.bitwardenBatchTransfers).some(row => row.target.id === target.id && row.status === 'writing')) throw new Error('Bitwarden 有待恢复的整批传输，请先恢复。');
      const snapshotHash = await bitwardenBatchSnapshotHash(state, request), selection = bitwardenTransferSelection(request.itemIds, state.items, state.providers, request.action);
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
        const nativeGroups: BitwardenMdbxMoveGroup[] = [];
        if (request.action === 'move') for (const component of selection.components) {
          const items = component.map(id => selected.find(item => item.id === id)!);
          if (items.every(item => isLocalTransferItem(item, state.providers))) continue;
          try {
            if (!this.dependencies.mdbx || !this.dependencies.exclusiveMany) throw new Error('MDBX 移动服务尚未就绪。');
            const account = bitwardenMdbxMoveSource(state, items[0]);
            if (items.length > 50) throw new Error('关联项目超过 MDBX 单次原子删除的 50 项上限，整组保留来源。');
            if (items.some(item => bitwardenMdbxMoveSource(state, item).id !== account.id)) throw new Error('关联组跨越多个来源库，尚不能原子移动。');
            const binding = await this.dependencies.mdbx.verify(state, account, items);
            nativeGroups.push({ id: await uuid(request.operationId, `mdbx-move:${JSON.stringify(component.slice().sort())}`),
              account: structuredClone(account), vaultId: binding.vaultId, sources: structuredClone(items), fingerprints: [] });
          } catch (error) { items.forEach(item => blocked.set(item.id, message(error))); }
          this.check(generation);
        }
        for (const item of selected) {
          const account = item.providerRefs.length === 1 && state.providers.find(row => row.id === item.providerRefs[0].providerId);
          const native = account && account.kind === 'bitwarden' && bitwardenProjectCipherId(item.providerRefs[0].remoteId || '');
          const identity = native ? JSON.stringify([account.id, native]) : `item:${item.id}`;
          groups.set(identity, [...(groups.get(identity) || []), item]);
        }
        for (const [identity, items] of groups) {
          try {
            if (items.some(item => blocked.has(item.id))) continue;
            if (request.action === 'move') items.forEach(item => {
              if (!nativeGroups.some(group => group.sources.some(source => source.id === item.id))) assertBitwardenLocalMoveSource(state, item);
            });
            const sourceSnapshotSha256 = await bitwardenBatchSourceHash(state, items.map(row => row.id), request.action === 'move');
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
        const mdbxMoves: BitwardenMdbxMoveGroup[] = [];
        for (const group of nativeGroups.filter(group => group.sources.every(source => finalUnits.some(unit => unit.sources.some(item => item.id === source.id))))) {
          // Pack complete components to avoid a full target download per item.
          const existing = mdbxMoves.find(row => row.account.id === group.account.id && row.vaultId === group.vaultId && row.sources.length + group.sources.length <= 50);
          if (existing) existing.sources.push(...group.sources); else mdbxMoves.push(structuredClone(group));
        }
        for (const group of mdbxMoves) {
          group.id = await uuid(request.operationId, `mdbx-move:${JSON.stringify(group.sources.map(row => row.id).sort())}`);
          group.fingerprints = finalUnits.filter(unit => group.sources.some(source => unit.sources.some(item => item.id === source.id)))
            .map(unit => ({ copyId: unit.copyId, sha256: fingerprints.get(unit.copyId)! }));
        }
        const plan: Mdbx2BatchTransferPlanResult = { ...request, items: selected.map(row => ({ sourceItemId: row.id, title: row.title, kind: row.kind,
          effectiveAction: request.action, blockedReason: blocked.get(row.id), sourcePath: paths.get(row.id) || [],
          targetPath: [parent?.name, ...(paths.get(row.id) || [])].filter((s): s is string => !!s), pathIncomplete: false })),
          blockedCount: blocked.size, transferableCount: selected.length - blocked.size, requiresMoveConfirmation: request.action === 'move', warnings: [] };
        if (snapshotHash !== await bitwardenBatchSnapshotHash(await this.vault.readState(false), request)) throw new Error('生成预览期间来源或目标已变化，请重试。');
        this.check(generation);
        if (mdbxMoves.length) plan.warnings.push('MDBX 原生提交历史保留在来源库中；目标校验完成后，当前项目才会从来源移除。');
        const batch: BitwardenBatchIntent = { version: mdbxMoves.length ? 3 : request.action === 'move' ? 2 : 1, request, requestHash: await hash(request), target: structuredClone(target), snapshotHash, plan,
          ...(mdbxMoves.length ? { mdbxMoves } : {}),
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
    return this.exclusive(request, async () => {
      this.check(generation); const state = await this.vault.readState(false), target = this.target(state, request.targetProviderId), requestHash = await hash(request);
      let batch = readBitwardenBatches(state.bitwardenBatchTransfers).find(row => row.request.operationId === request.operationId);
      if (batch && (batch.requestHash !== requestHash || batch.status === 'cancelled' || !sameProviderBinding(batch.target, target))) throw new Error('传输请求与原计划不一致或已取消。');
      if (batch?.status === 'completed') return batch.result!;
      const sessionId = await this.vault.passkeySessionId(); if (!sessionId) throw new Error('密码库已锁定。');
      if (!batch) {
        if (request.action === 'move' && input.confirmed !== true) throw new Error('请先确认移动；目标完整保存后才会移除来源。');
        const saved = this.plans.get(request.operationId);
        if (!saved || saved.batch.requestHash !== requestHash || !saved.batch.plan.transferableCount) throw new Error('传输预览已过期或没有可复制项目，请重新预览。');
        if (saved.batch.snapshotHash !== await bitwardenBatchSnapshotHash(state, request)) throw new Error('预览后来源或目标已变化，请重新预览。');
        for (const unit of saved.batch.units) {
          const resource = await this.dependencies.resource(state, unit.sources.map(row => state.items.find(item => item.id === row.id)!), request.preserveCategories);
          try { if (resource.fingerprint !== saved.fingerprints.get(unit.copyId)) throw new Error('来源字段、附件或文件夹在预览后已变化。'); }
          finally { resource.dispose(); } this.check(generation);
        }
        for (const group of saved.batch.mdbxMoves || []) {
          const binding = await this.dependencies.mdbx!.verify(state, group.account, group.sources);
          if (binding.vaultId !== group.vaultId) throw new Error('MDBX 来源库身份已变化。');
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
        const readback = async () => {
          const latest = await this.vault.readState(false), current = await store.copies.account(anchor);
          const verified = (await Promise.all(batch.units.map(row => store.copies.read(row.copyId)))).flatMap(row => row.verifiedItems || []);
          const known = new Set(latest.items.map(row => row.id)), identities = [...latest.items, ...verified.filter(row => !known.has(row.id))];
          const result = await this.provider.sync(current, { now: new Date().toISOString(), localItems: identities, pendingMutations: [], readOnly: true, signal });
          this.check(generation);
          if (!result.sourceRecords || result.conflicts.length || result.acknowledgedMutations?.length || result.requestedMutations?.length)
            throw new Error('移动需要无冲突、无写入的完整 Bitwarden 回读。');
          if (result.accountPatch?.config) await store.copies.saveSession(anchor, current, result.accountPatch.config as BitwardenSessionConfig);
          return { latest, current, result, proof: { account: current, records: result.sourceRecords, items: result.items } satisfies BitwardenMoveReadback };
        };
        for (const originalGroup of bitwardenBatchAction(batch) === 'move' ? batch.mdbxMoves || [] : []) {
          if (!this.dependencies.mdbx) throw new Error('MDBX 移动服务尚未就绪。');
          let group = (await store.read(request.operationId)).mdbxMoves!.find(row => row.id === originalGroup.id)!;
          if (group.receipt) continue;
          if (!group.deletion) {
            const state = await this.vault.readState(false);
            const intent = await this.dependencies.mdbx.prepare(group, target.id, async () => {
              for (const fingerprint of group.fingerprints) {
                const unit = batch.units.find(row => row.copyId === fingerprint.copyId)!;
                const resource = await this.dependencies.resource(state, unit.sources.map(row => state.items.find(item => item.id === row.id)!), request.preserveCategories);
                try { if (resource.fingerprint !== fingerprint.sha256) throw new Error('MDBX 来源内容或附件已变化，已保留来源和副本。'); }
                finally { resource.dispose(); }
                this.check(generation);
              }
              if ((await this.dependencies.mdbx!.verify(state, group.account, group.sources)).vaultId !== group.vaultId) throw new Error('MDBX 来源身份已变化。');
            });
            this.check(generation);
            const proof = (await readback()).proof;
            const staged = await this.vault.prepareBitwardenMdbxDeletion(request.operationId, group.id, intent, proof, sessionId);
            group = staged.mdbxMoves!.find(row => row.id === group.id)!;
          }
          const proof = (await readback()).proof;
          await this.vault.deleteBitwardenMdbxSources(request.operationId, group.id, group.deletion!, proof, sessionId, async (account, sources, intent) => {
            this.check(generation);
            return this.dependencies.mdbx!.remove(account, sources, group.id, target.id, intent);
          });
          this.check(generation);
        }
        const { latest, current, result } = await readback();
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
  private async exclusive<T>(request: ReturnType<typeof normalizeBitwardenBatchRequest>, work: () => Promise<T>): Promise<T> {
    if (request.action !== 'move' || !this.dependencies.exclusiveMany) return this.dependencies.exclusive(request.targetProviderId, work);
    const providerIds = (state: VaultState) => {
      const batch = readBitwardenBatches(state.bitwardenBatchTransfers).find(row => row.request.operationId === request.operationId);
      const ids = batch ? batch.mdbxMoves?.map(group => group.account.id) || []
      : bitwardenTransferSelection(request.itemIds, state.items, state.providers, 'move').selectedIds.flatMap(id =>
        state.items.find(item => item.id === id)!.providerRefs.filter(ref => state.providers.some(account => account.id === ref.providerId && account.kind === 'mdbx2')).map(ref => ref.providerId));
      return [...new Set([request.targetProviderId, ...ids])].sort();
    };
    const ids = providerIds(await this.vault.readState(false));
    return this.dependencies.exclusiveMany(ids, async () => {
      if (JSON.stringify(providerIds(await this.vault.readState(false))) !== JSON.stringify(ids))
        throw new Error('等待传输期间来源已变化，请重新预览。');
      return work();
    });
  }
  private target(state: VaultState, id: string) { const account = state.providers.find(row => row.id === id);
    if (!account?.enabled || account.kind !== 'bitwarden') throw new Error('目标 Bitwarden 不可用。'); return account; }
  private check(generation: number) { if (generation !== this.generation) throw new Error('密码库已锁定，已保存的传输可在解锁后恢复。'); }
  private progress(batch: BitwardenBatchIntent, phase: 'writing' | 'finalizing' | 'completed') { return { operationId: batch.request.operationId, phase,
    processed: 0, total: batch.plan.items.length, completedCount: 0, blockedCount: batch.plan.blockedCount, failedCount: 0 }; }
}
function clearKey(key: BitwardenSymmetricKey) { key.encKey.fill(0); key.macKey.fill(0); }
function message(error: unknown) { return error instanceof Error ? error.message : '来源无法完整读取。'; }
