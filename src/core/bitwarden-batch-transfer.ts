import type { ProviderAccount, ProviderSourceRecord, VaultItem, VaultState } from './model';
import type { Mdbx2BatchTransferExecuteResult, Mdbx2BatchTransferPlanResult, Mdbx2BatchTransferRequest } from '../providers/mdbx2/mdbx2-batch-transfer-coordinator';
import { assertMdbx2TransferOperationId, mdbx2TransferOperationScope as hash } from '../providers/mdbx2/mdbx2-transfer-identity';
import { bitwardenTransferSelection } from '../providers/bitwarden/bitwarden-transfer-selection';
import { bitwardenCopySourceHash, type BitwardenCipherCopyRecord } from './bitwarden-transfer-journal';
import { normalizeCredentialId } from '../passkey/source-policy';
import { sameProviderBinding } from './provider';
import { resolveSsoAccount } from './sso-links';
import { verifyBitwardenTransferCipher } from '../providers/bitwarden/bitwarden-transfer-cipher';
import { bitwardenComparablePayload } from '../providers/bitwarden/bitwarden-durable-sync';
import type { BitwardenSymmetricKey } from '../providers/bitwarden/bitwarden-crypto';
import { parseLosslessJson } from './lossless-json';
import { isLocalTransferItem } from './local-transfer';
import { readPasskeyBindings } from './passkey-bindings';
import { readBitwardenMdbxMoveGroups, assertBitwardenMdbxMoveBinding, type BitwardenMdbxMoveGroup } from './bitwarden-mdbx-move';

export type BitwardenBatchRequest = Omit<Mdbx2BatchTransferRequest, 'operationId' | 'operationCreatedAt' | 'confirmed'> & { operationId: string; operationCreatedAt: string };
export interface BitwardenBatchUnit {
  copyId: string;
  sources: Array<{ id: string; kind: VaultItem['kind']; credentialId?: string }>;
  ssoTargetCopyId?: string;
  folderKey?: string;
}
export interface BitwardenBatchFolder {
  key: string;
  name: string;
  /** Exact randomized CipherString identifies a create whose reply was lost. */
  encryptedName: string;
  stage: 'existing' | 'prepared' | 'attempted' | 'created';
  targetId?: string;
}
export interface BitwardenBatchIntent {
  version: 1 | 2 | 3 | 4;
  request: BitwardenBatchRequest;
  requestHash: string;
  plan: Mdbx2BatchTransferPlanResult;
  target: ProviderAccount;
  snapshotHash: string;
  units: BitwardenBatchUnit[];
  folders?: BitwardenBatchFolder[];
  mdbxMoves?: BitwardenMdbxMoveGroup[];
  /** V4 prevents older readers from ignoring the decision and deleting sources. */
  resolution?: { version: 1; kind: 'keep-both'; originalVersion: 2 | 3; confirmedAt: string };
  status: 'writing' | 'completed' | 'cancelled';
  result?: Mdbx2BatchTransferExecuteResult;
}
const invalid = () => new Error('Bitwarden 整批传输恢复记录无效，来源和已保存副本均已保留。');
const id = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 4096;
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export interface BitwardenPendingTransfer {
  request: BitwardenBatchRequest;
  plan: Mdbx2BatchTransferPlanResult;
  canKeepBoth: boolean;
  keptBoth: boolean;
}
export function bitwardenBatchAction(batch: BitwardenBatchIntent): 'copy' | 'move' {
  return batch.version === 4 ? 'copy' : batch.request.action;
}
export function canKeepBitwardenBatchSources(batch: BitwardenBatchIntent): boolean {
  return batch.status === 'writing' && (batch.version === 2 || batch.version === 3)
    && !(batch.mdbxMoves || []).some(group => group.deletion || group.receipt);
}
/** Only a display projection changes action. The original request stays immutable. */
export function pendingBitwardenBatch(batch: BitwardenBatchIntent): BitwardenPendingTransfer {
  const action = bitwardenBatchAction(batch);
  return { request: structuredClone(batch.request),
    plan: { ...structuredClone(batch.plan), action, requiresMoveConfirmation: action === 'move',
      items: batch.plan.items.map(item => ({ ...structuredClone(item), effectiveAction: action })) },
    canKeepBoth: canKeepBitwardenBatchSources(batch), keptBoth: batch.version === 4 };
}

export function normalizeBitwardenBatchRequest(input: Mdbx2BatchTransferRequest): BitwardenBatchRequest {
  if (!input || !Array.isArray(input.itemIds) || !input.itemIds.length || input.itemIds.length > 200
    || input.itemIds.some(value => !id(value)) || new Set(input.itemIds).size !== input.itemIds.length || !id(input.targetProviderId)
    || !['copy', 'move'].includes(input.action) || typeof input.preserveCategories !== 'boolean'
    || input.targetCollectionId !== undefined && !id(input.targetCollectionId)
    || input.operationCreatedAt !== undefined && (typeof input.operationCreatedAt !== 'string' || !Number.isFinite(Date.parse(input.operationCreatedAt)))) throw invalid();
  return { operationId: assertMdbx2TransferOperationId(input.operationId || crypto.randomUUID()), operationCreatedAt: input.operationCreatedAt || new Date().toISOString(),
    itemIds: [...input.itemIds].sort(), targetProviderId: input.targetProviderId, targetCollectionId: input.targetCollectionId || undefined,
    preserveCategories: input.preserveCategories, action: input.action };
}

/** Dependency order is persisted by identity, never by title or current UI order. */
export function bitwardenBatchOrder(units: BitwardenBatchUnit[]): BitwardenBatchUnit[] {
  const byId = new Map(units.map(row => [row.copyId, row])), visited = new Set<string>(), visiting = new Set<string>(), result: BitwardenBatchUnit[] = [];
  if (byId.size !== units.length) throw invalid();
  const visit = (unit: BitwardenBatchUnit) => {
    if (visited.has(unit.copyId)) return;
    if (visiting.has(unit.copyId)) throw new Error('Bitwarden 传输关联存在循环，已停止创建。');
    visiting.add(unit.copyId);
    if (unit.ssoTargetCopyId) { const target = byId.get(unit.ssoTargetCopyId); if (!target) throw invalid(); visit(target); }
    visiting.delete(unit.copyId); visited.add(unit.copyId); result.push(unit);
  };
  units.forEach(visit); return result;
}

export function readBitwardenBatches(value: unknown): BitwardenBatchIntent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000) throw invalid();
  const seen = new Set<string>();
  return value.map(raw => {
    const row = raw as BitwardenBatchIntent, request = normalizeBitwardenBatchRequest(row?.request);
    if (!(row.version === 1 && request.action === 'copy' || [2, 3, 4].includes(row.version) && request.action === 'move')
      || !row.request.operationId || !row.request.operationCreatedAt || seen.has(request.operationId)
      || row.target?.kind !== 'bitwarden' || row.target.id !== request.targetProviderId || row.target.enabled !== true
      || !digest(row.requestHash) || !digest(row.snapshotHash) || !['writing', 'completed', 'cancelled'].includes(row.status)
      || !Array.isArray(row.units) || !row.units.length || row.units.length > 200
      || row.units.some(unit => !unit || !id(unit.copyId) || !Array.isArray(unit.sources) || !unit.sources.length || unit.sources.length > 200
        || unit.sources.some(source => !source || !id(source.id) || !['login','totp','passkey','secure-note','card','identity','api-token','billing-address','payment-account'].includes(source.kind)
          || source.kind === 'passkey' && !id(source.credentialId)) || unit.ssoTargetCopyId !== undefined && !id(unit.ssoTargetCopyId))
      || !row.plan || row.plan.operationId !== request.operationId || row.plan.targetProviderId !== request.targetProviderId
      || row.plan.action !== request.action || row.plan.operationCreatedAt !== request.operationCreatedAt
      || row.plan.preserveCategories !== request.preserveCategories || row.plan.targetCollectionId !== request.targetCollectionId
      || !Array.isArray(row.plan.items) || !row.plan.items.length || row.plan.items.length > 200 || row.plan.requiresMoveConfirmation !== (request.action === 'move')
      || !Array.isArray(row.plan.warnings) || row.plan.warnings.some(value => typeof value !== 'string')
      || row.plan.items.some(item => !item || !id(item.sourceItemId) || typeof item.title !== 'string' || item.effectiveAction !== request.action
        || typeof item.pathIncomplete !== 'boolean' || !Array.isArray(item.sourcePath) || !Array.isArray(item.targetPath)
        || [...item.sourcePath, ...item.targetPath].some(value => typeof value !== 'string')
        || item.blockedReason !== undefined && !id(item.blockedReason))) throw invalid();
    if (row.version === 4 ? !row.resolution || row.resolution.version !== 1 || row.resolution.kind !== 'keep-both'
      || ![2, 3].includes(row.resolution.originalVersion) || typeof row.resolution.confirmedAt !== 'string'
      || !Number.isFinite(Date.parse(row.resolution.confirmedAt)) : row.resolution !== undefined) throw invalid();
    const sources = row.units.flatMap(unit => unit.sources), accepted = row.plan.items.filter(item => !item.blockedReason);
    const moves = readBitwardenMdbxMoveGroups(row.mdbxMoves);
    const originalVersion = row.version === 4 ? row.resolution!.originalVersion : row.version;
    if ((originalVersion === 3) !== (moves.length > 0) || moves.some(group => group.account.id === row.target.id
      || group.sources.some(source => !sources.some(item => item.id === source.id && item.kind === source.kind))
      || group.fingerprints.some(fingerprint => !row.units.some(unit => unit.copyId === fingerprint.copyId && unit.sources.length === 1
        && group.sources.some(source => source.id === unit.sources[0].id)))
      || row.version === 4 && (group.deletion !== undefined || group.receipt !== undefined)
      || row.status === 'completed' && row.version !== 4 && !group.receipt || row.status === 'cancelled' && group.deletion)) throw invalid();
    const folders = row.folders || [];
    if (!Array.isArray(folders) || folders.length > 200 || folders.some(folder => !folder || !id(folder.key) || !id(folder.name)
      || typeof folder.encryptedName !== 'string' || !folder.encryptedName.startsWith('2.') || folder.encryptedName.length > 8192
      || !['existing','prepared','attempted','created'].includes(folder.stage)
      || ['existing','created'].includes(folder.stage) !== Boolean(folder.targetId) || folder.targetId !== undefined && !id(folder.targetId))
      || new Set(folders.map(folder => folder.key)).size !== folders.length
      || new Set(folders.flatMap(folder => folder.targetId ? [folder.targetId] : [])).size !== folders.filter(folder => folder.targetId).length
      || row.units.some(unit => unit.folderKey && !folders.some(folder => folder.key === unit.folderKey))) throw invalid();
    if (sources.length > 200 || new Set(sources.map(source => source.id)).size !== sources.length
      || new Set(row.plan.items.map(item => item.sourceItemId)).size !== row.plan.items.length
      || request.itemIds.some(id => !row.plan.items.some(item => item.sourceItemId === id))
      || accepted.length !== sources.length || accepted.some(item => !sources.some(source => source.id === item.sourceItemId && source.kind === item.kind))
      || row.plan.transferableCount !== accepted.length || row.plan.blockedCount !== row.plan.items.length - accepted.length
      || row.status !== 'completed' && row.result !== undefined
      || row.status === 'completed' && (!row.result || row.result.operationId !== request.operationId || row.result.targetProviderId !== request.targetProviderId
        || row.result.action !== bitwardenBatchAction(row) || row.result.completedCount !== accepted.length || row.result.failedCount !== 0
        || row.result.blockedCount !== row.plan.blockedCount || !Array.isArray(row.result.items) || row.result.items.length !== row.plan.items.length
        || row.result.items.some((item,index) => item.sourceItemId !== row.plan.items[index].sourceItemId || item.effectiveAction !== bitwardenBatchAction(row)
          || item.status !== (row.plan.items[index].blockedReason ? 'blocked' : 'completed') || item.status === 'completed' && !id(item.targetItemId)))) throw invalid();
    row.units.forEach(unit => assertMdbx2TransferOperationId(unit.copyId)); bitwardenBatchOrder(row.units);
    seen.add(request.operationId); return structuredClone(row);
  });
}

export async function bitwardenBatchSnapshotHash(state: VaultState, request: BitwardenBatchRequest): Promise<string> {
  const ids = bitwardenTransferSelection(request.itemIds, state.items, state.providers, request.action).selectedIds;
  const target = state.providers.find(row => row.id === request.targetProviderId);
  if (target?.kind !== 'bitwarden' || !target.enabled || state.mutationQueue.some(row => row.providerId === target.id)
    || state.providerConflicts.some(row => row.providerId === target.id)) throw new Error('Bitwarden 目标不可用或仍有未完成修改，请先同步并处理冲突。');
  const providers = new Set(state.items.filter(row => ids.includes(row.id)).flatMap(row => row.providerRefs.map(ref => ref.providerId)));
  // Snapshot all selected components, including those the preview must block.
  // Content eligibility is checked separately for accepted copy units.
  return hash({ request, target: batchAccountSnapshot(target), items: state.items.filter(row => ids.includes(row.id)),
    providers: state.providers.filter(row => providers.has(row.id)).map(batchAccountSnapshot),
    records: state.sourceRecords.filter(row => providers.has(row.providerId)),
    files: (state.localItemAttachments || []).filter(row => ids.includes(row.itemId)),
    origins: (state.localItemOrigins || []).filter(row => ids.includes(row.itemId)),
    mutations: state.mutationQueue.filter(row => ids.includes(row.itemId)), conflicts: state.providerConflicts.filter(row => ids.includes(row.itemId)),
    removals: state.passwordProjectRemovals, moves: state.mdbx2MoveFinalizations });
}

function batchAccountSnapshot(account: ProviderAccount): ProviderAccount {
  if (account.kind !== 'bitwarden') return account;
  const config = { ...account.config };
  for (const field of ['accessToken','refreshToken','expiresAt']) delete config[field];
  return { ...account, config };
}

/** New batch intents exclude only rotating bearer tokens. Existing standalone
 * receipt hashes deliberately keep their original semantics. */
export function bitwardenBatchSourceHash(state: VaultState, ids: string[], nativeMove = false) {
  return bitwardenCopySourceHash({ ...state, providers: state.providers.map(account => {
    if (!nativeMove || account.kind !== 'mdbx2') return batchAccountSnapshot(account);
    // V3 moves survive reopening the same native working copy. Display/default
    // settings and host verification timestamps are not source content. The
    // journal separately verifies authenticated vault ID and the live binding.
    const keys = ['vaultHandle','syncStateHandle','webDavBaseUrl','webDavUsername','webDavPassword','remotePath'];
    return { id: account.id, kind: account.kind, enabled: account.enabled, name: '', isDefaultSaveTarget: false,
      config: Object.fromEntries(keys.filter(key => account.config[key] !== undefined).map(key => [key, account.config[key]])) };
  }) }, ids, true);
}

export function assertBitwardenBatchCopies(state: VaultState, batch: BitwardenBatchIntent, copies: BitwardenCipherCopyRecord[]) {
  const ids = new Set(batch.units.map(unit => unit.copyId));
  const relevant = copies.filter(row => ids.has(row.prepared.copyId));
  if (relevant.length !== ids.size) throw invalid();
  for (const unit of batch.units) {
    const copy = relevant.find(row => row.prepared.copyId === unit.copyId)!;
    if (copy.batchOperationId !== batch.request.operationId || copy.prepared.operationId !== batch.request.operationId
      || !sameProviderBinding(copy.target, batch.target) || copy.sourceItemIds.length !== unit.sources.length
      || unit.sources.some(source => !copy.sourceItemIds.includes(source.id))) throw invalid();
    for (const source of unit.sources) {
      const original = state.items.find(row => row.id === source.id);
      if (!original || original.kind !== source.kind || original.kind === 'passkey'
        && normalizeCredentialId(original.credentialId) !== normalizeCredentialId(source.credentialId!)) throw invalid();
    }
    const folder = batch.folders?.find(row => row.key === unit.folderKey);
    if (folder && copy.prepared.pendingFolderKey !== folder.key
      || !folder && copy.prepared.pendingFolderKey) throw invalid();
    const login = state.items.find(row => row.kind === 'login' && unit.sources.some(source => source.id === row.id));
    if (login?.kind === 'login' && login.ssoRefLogicalId) {
      const target = resolveSsoAccount(login, state.items), dependency = batch.units.find(unit => unit.sources.some(source => source.id === target?.id));
      if (!dependency || dependency.copyId !== unit.ssoTargetCopyId || copy.prepared.pendingSso?.sourceLogicalId !== login.ssoRefLogicalId) throw invalid();
    } else if (unit.ssoTargetCopyId || copy.prepared.pendingSso || copy.prepared.boundSso) throw invalid();
  }
}

/** Result mapping follows native identity, never decrypted titles/passwords. */
export function bitwardenBatchResult(batch: BitwardenBatchIntent, copies: BitwardenCipherCopyRecord[], currentItems?: VaultItem[]): Mdbx2BatchTransferExecuteResult {
  const targets = new Map<string, string>();
  for (const unit of batch.units) {
    const copy = copies.find(row => row.prepared.copyId === unit.copyId);
    if (!copy || copy.stage !== 'verified' || copy.batchOperationId !== batch.request.operationId || copy.target.id !== batch.target.id) throw invalid();
    for (const source of unit.sources) {
      const rows = (currentItems || copy.verifiedItems!).filter(row => row.kind === source.kind && !row.deletedAt
        && row.providerRefs.some(ref => ref.providerId === batch.target.id && copy.verifiedItems!.some(old => old.providerRefs.some(oldRef => oldRef.remoteId === ref.remoteId)))
        && (row.kind !== 'passkey' || normalizeCredentialId(row.credentialId) === normalizeCredentialId(source.credentialId!)));
      if (rows.length !== 1) throw invalid(); targets.set(source.id, rows[0].id);
    }
  }
  if (new Set(targets.values()).size !== targets.size) throw invalid();
  return { operationId: batch.request.operationId, action: bitwardenBatchAction(batch), targetProviderId: batch.target.id,
    items: batch.plan.items.map(row => ({ sourceItemId: row.sourceItemId, kind: row.kind, title: row.title, effectiveAction: bitwardenBatchAction(batch),
      status: row.blockedReason ? 'blocked' : 'completed', targetItemId: targets.get(row.sourceItemId), retryable: false, error: row.blockedReason })),
    completedCount: targets.size, blockedCount: batch.plan.blockedCount, failedCount: 0, warnings: batch.plan.warnings };
}

/** Local removal joins target adoption in one encrypted write. Remote sources
 * require their own durable native deletion receipts and are never unbound here. */
export function assertBitwardenLocalMoveSource(state: VaultState, item: VaultItem): void {
  if (!isLocalTransferItem(item, state.providers) || (state.localItemOrigins || []).some(row => row.itemId === item.id && row.records.length))
    throw new Error('此来源的跨库移动尚未接入删除恢复，请使用复制；来源已保留。');
  if (item.kind === 'passkey') {
    for (const owner of state.items) {
      if (owner.deletedAt || owner.kind !== 'login' || !isLocalTransferItem(owner, state.providers) || !owner.passkeyBindings) continue;
      let bindings;
      try { bindings = readPasskeyBindings(owner.passkeyBindings); } catch { throw new Error('本地 Passkey 关联无法确认，已保留来源。'); }
      if (bindings.some(binding => !normalizeCredentialId(binding.credentialId || '')
        || normalizeCredentialId(binding.credentialId || '') === normalizeCredentialId(item.credentialId)))
        throw new Error('本地 Passkey 仍有关联密码，关联迁移尚未完成，请使用复制。');
    }
  }
}

/** Recheck after the final network read, while holding the local mutation lock.
 * A new dependent or an edit since staging must never be removed by an old plan. */
export async function assertBitwardenBatchMoveCurrent(state: VaultState, batch: BitwardenBatchIntent, copies: BitwardenCipherCopyRecord[]): Promise<Set<string>> {
  const ids = new Set(batch.units.flatMap(unit => unit.sources.map(source => source.id)));
  if (bitwardenBatchAction(batch) !== 'move') return new Set();
  const moves = readBitwardenMdbxMoveGroups(batch.mdbxMoves), nativeIds = new Set(moves.flatMap(group => group.sources.map(source => source.id)));
  for (const group of moves) assertBitwardenMdbxMoveBinding(state, group);
  const selection = bitwardenTransferSelection(batch.request.itemIds, state.items, state.providers, 'move');
  if (selection.selectedIds.length !== batch.plan.items.length || selection.selectedIds.some(id => !batch.plan.items.some(row => row.sourceItemId === id))
    || selection.components.some(group => group.some(id => ids.has(id)) && group.some(id => !ids.has(id))))
    throw new Error('移动期间项目或关联已变化，已保留来源和目标副本。');
  for (const unit of batch.units) {
    const copy = copies.find(row => row.prepared.copyId === unit.copyId);
    if (!copy || copy.sourceSnapshotSha256 !== await bitwardenBatchSourceHash(state, unit.sources.map(source => source.id), batch.version === 3))
      throw new Error('移动期间来源已变化，已保留来源和目标副本。');
    for (const source of unit.sources) {
      const item = state.items.find(row => row.id === source.id);
      if (!item) throw invalid();
      if (!nativeIds.has(item.id)) assertBitwardenLocalMoveSource(state, item);
    }
  }
  return ids;
}

/** Fresh authenticated provider data must still describe the verified files and
 * every native sibling. Call inside the final encrypted adoption transaction. */
export async function verifyBitwardenBatchReadback(batch: BitwardenBatchIntent, copies: BitwardenCipherCopyRecord[],
  records: ProviderSourceRecord[], items: VaultItem[], ownerKey: BitwardenSymmetricKey): Promise<void> {
  for (const unit of batch.units) {
    const copy = copies.find(row => row.prepared.copyId === unit.copyId);
    if (!copy || copy.stage !== 'verified' || copy.batchOperationId !== batch.request.operationId) throw invalid();
    const matches = records.filter(row => row.providerId === batch.target.id && row.remoteId === copy.remoteId);
    if (matches.length !== 1 || matches[0].format !== 'bitwarden-cipher' || matches[0].encoding !== 'json') throw invalid();
    const raw = parseLosslessJson(matches[0].payload) as Record<string, unknown>;
    if ((raw.id ?? raw.Id) !== copy.remoteId) throw invalid();
    const revision = raw.revisionDate ?? raw.RevisionDate;
    if (copy.verifiedItems!.some(item => item.providerRefs[0].revision !== revision))
      throw new Error('Bitwarden 副本在附件核验后又发生变化，整批入库已停止。');
    const decoded = await verifyBitwardenTransferCipher(copy.prepared, raw, ownerKey);
    const folder = batch.folders?.find(row => row.key === unit.folderKey);
    if (folder && (!folder.targetId || (raw.folderId ?? raw.FolderId) !== folder.targetId)) throw invalid();
    const attachments = raw.attachments ?? raw.Attachments ?? [];
    if (!Array.isArray(attachments) || attachments.length !== copy.attachmentReceipts.length
      || copy.attachmentReceipts.some(file => !attachments.some(row => row && (row.id ?? row.Id) === file.targetAttachmentId))) throw invalid();
    if (unit.ssoTargetCopyId) {
      const dependency = copies.find(row => row.prepared.copyId === unit.ssoTargetCopyId);
      if (!dependency?.remoteId || copy.prepared.boundSso?.targetCipherId !== dependency.remoteId) throw invalid();
    }
    for (const expected of decoded) {
      const actual = items.filter(row => row.kind === expected.kind && row.providerRefs.some(ref => ref.providerId === batch.target.id
        && expected.providerRefs.some(old => old.remoteId === ref.remoteId)));
      if (actual.length !== 1 || actual[0].deletedAt) throw invalid();
      const expectedContent = bitwardenComparablePayload(expected), actualContent = bitwardenComparablePayload(actual[0]);
      if (await hash(expectedContent) !== await hash(Object.fromEntries(Object.keys(expectedContent).map(key => [key, actualContent[key]]))))
        throw new Error('Bitwarden 整批入库投影与已核验的原生记录不一致。');
    }
  }
  bitwardenBatchResult(batch, copies, items);
}
