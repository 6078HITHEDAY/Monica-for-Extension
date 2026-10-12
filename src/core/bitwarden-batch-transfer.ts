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
  version: 1;
  request: BitwardenBatchRequest;
  requestHash: string;
  plan: Mdbx2BatchTransferPlanResult;
  target: ProviderAccount;
  snapshotHash: string;
  units: BitwardenBatchUnit[];
  folders?: BitwardenBatchFolder[];
  status: 'writing' | 'completed' | 'cancelled';
  result?: Mdbx2BatchTransferExecuteResult;
}
const invalid = () => new Error('Bitwarden 整批传输恢复记录无效，来源和已保存副本均已保留。');
const id = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 4096;
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

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
    if (row.version !== 1 || !row.request.operationId || !row.request.operationCreatedAt || seen.has(request.operationId)
      || row.target?.kind !== 'bitwarden' || row.target.id !== request.targetProviderId || row.target.enabled !== true
      || !digest(row.requestHash) || !digest(row.snapshotHash) || !['writing', 'completed', 'cancelled'].includes(row.status)
      || !Array.isArray(row.units) || !row.units.length || row.units.length > 200 || request.action !== 'copy'
      || row.units.some(unit => !unit || !id(unit.copyId) || !Array.isArray(unit.sources) || !unit.sources.length || unit.sources.length > 200
        || unit.sources.some(source => !source || !id(source.id) || !['login','totp','passkey','secure-note','card','identity','api-token','billing-address','payment-account'].includes(source.kind)
          || source.kind === 'passkey' && !id(source.credentialId)) || unit.ssoTargetCopyId !== undefined && !id(unit.ssoTargetCopyId))
      || !row.plan || row.plan.operationId !== request.operationId || row.plan.targetProviderId !== request.targetProviderId
      || row.plan.action !== request.action || row.plan.operationCreatedAt !== request.operationCreatedAt
      || row.plan.preserveCategories !== request.preserveCategories || row.plan.targetCollectionId !== request.targetCollectionId
      || !Array.isArray(row.plan.items) || !row.plan.items.length || row.plan.items.length > 200 || row.plan.requiresMoveConfirmation !== false
      || !Array.isArray(row.plan.warnings) || row.plan.warnings.some(value => typeof value !== 'string')
      || row.plan.items.some(item => !item || !id(item.sourceItemId) || typeof item.title !== 'string' || item.effectiveAction !== 'copy'
        || typeof item.pathIncomplete !== 'boolean' || !Array.isArray(item.sourcePath) || !Array.isArray(item.targetPath)
        || [...item.sourcePath, ...item.targetPath].some(value => typeof value !== 'string')
        || item.blockedReason !== undefined && !id(item.blockedReason))) throw invalid();
    const sources = row.units.flatMap(unit => unit.sources), accepted = row.plan.items.filter(item => !item.blockedReason);
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
        || row.result.action !== 'copy' || row.result.completedCount !== accepted.length || row.result.failedCount !== 0
        || row.result.blockedCount !== row.plan.blockedCount || !Array.isArray(row.result.items) || row.result.items.length !== row.plan.items.length
        || row.result.items.some((item,index) => item.sourceItemId !== row.plan.items[index].sourceItemId
          || item.status !== (row.plan.items[index].blockedReason ? 'blocked' : 'completed') || item.status === 'completed' && !id(item.targetItemId)))) throw invalid();
    row.units.forEach(unit => assertMdbx2TransferOperationId(unit.copyId)); bitwardenBatchOrder(row.units);
    seen.add(request.operationId); return structuredClone(row);
  });
}

export async function bitwardenBatchSnapshotHash(state: VaultState, request: BitwardenBatchRequest): Promise<string> {
  const ids = bitwardenTransferSelection(request.itemIds, state.items, state.providers).selectedIds;
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
export function bitwardenBatchSourceHash(state: VaultState, ids: string[]) {
  return bitwardenCopySourceHash({ ...state, providers: state.providers.map(batchAccountSnapshot) }, ids, true);
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
  return { operationId: batch.request.operationId, action: 'copy', targetProviderId: batch.target.id,
    items: batch.plan.items.map(row => ({ sourceItemId: row.sourceItemId, kind: row.kind, title: row.title, effectiveAction: 'copy',
      status: row.blockedReason ? 'blocked' : 'completed', targetItemId: targets.get(row.sourceItemId), retryable: false, error: row.blockedReason })),
    completedCount: targets.size, blockedCount: batch.plan.blockedCount, failedCount: 0, warnings: batch.plan.warnings };
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
