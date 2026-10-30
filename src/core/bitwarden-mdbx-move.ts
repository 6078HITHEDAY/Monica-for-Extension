import type { ProviderAccount, ProviderSourceRecord, VaultItem, VaultState } from './model';
import type { Mdbx2SourceDeletionIntent } from './mdbx2-source-deletion';
import { readMdbx2SourceDeletionIntent } from './mdbx2-source-deletion';
import { sameProviderBinding } from './provider';
import { assertMdbx2TransferOperationId } from '../providers/mdbx2/mdbx2-transfer-identity';

export interface BitwardenMdbxMoveGroup {
  id: string;
  account: ProviderAccount;
  vaultId: string;
  sources: VaultItem[];
  fingerprints: Array<{ copyId: string; sha256: string }>;
  deletion?: Mdbx2SourceDeletionIntent;
  receipt?: { operationId: string; commitId: string };
}

export interface BitwardenMoveReadback {
  account: ProviderAccount;
  items: VaultItem[];
  records: ProviderSourceRecord[];
}

const invalid = () => new Error('Bitwarden 的 MDBX 移动恢复记录无效，已保留来源和副本。');
const id = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 4096;
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function readBitwardenMdbxMoveGroups(value: unknown): BitwardenMdbxMoveGroup[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.length || value.length > 200) throw invalid();
  const groups = new Set<string>(), sources = new Set<string>(), copies = new Set<string>(), native = new Set<string>();
  for (const row of value as BitwardenMdbxMoveGroup[]) {
    if (!row || !id(row.id) || groups.has(row.id) || !id(row.vaultId) || row.account?.kind !== 'mdbx2' || !row.account.enabled
      || !id(row.account.id) || !id(row.account.config?.vaultHandle) || !Array.isArray(row.sources) || !row.sources.length || row.sources.length > 50
      || !Array.isArray(row.fingerprints) || row.fingerprints.length !== row.sources.length) throw invalid();
    groups.add(row.id);
    assertMdbx2TransferOperationId(row.id);
    for (const source of row.sources) {
      if (!source || !id(source.id) || sources.has(source.id) || source.deletedAt || !Array.isArray(source.providerRefs)
        || source.providerRefs.length !== 1 || source.providerRefs[0].providerId !== row.account.id
        || !id(source.providerRefs[0].remoteId) || !id(source.providerRefs[0].revision) || !id(source.providerRefs[0].remoteFolderId)) throw invalid();
      sources.add(source.id);
      const identity = JSON.stringify([row.vaultId, source.providerRefs[0].remoteId]);
      if (native.has(identity)) throw invalid(); native.add(identity);
    }
    if (new Set(row.sources.map(source => source.providerRefs[0].remoteId)).size !== row.sources.length) throw invalid();
    for (const fingerprint of row.fingerprints) {
      if (!fingerprint || !id(fingerprint.copyId) || copies.has(fingerprint.copyId) || !digest(fingerprint.sha256)) throw invalid();
      copies.add(fingerprint.copyId);
    }
    if (row.deletion) {
      const intent = readMdbx2SourceDeletionIntent(row.deletion);
      // Bitwarden native moves never issued the historical unguarded request.
      if (intent.version !== 1 || intent.writeRevision.vaultId !== row.vaultId) throw invalid();
    }
    if (row.receipt && (!row.deletion || !id(row.receipt.operationId) || !id(row.receipt.commitId))) throw invalid();
  }
  if (sources.size > 200) throw invalid();
  return structuredClone(value);
}

export function bitwardenMdbxMoveSource(state: VaultState, item: VaultItem): ProviderAccount {
  const ref = item.providerRefs[0], account = state.providers.find(row => row.id === ref?.providerId);
  if (!account?.enabled || account.kind !== 'mdbx2' || item.providerRefs.length !== 1 || item.deletedAt
    || !ref.remoteId || !ref.revision || !ref.remoteFolderId || !account.config.vaultHandle)
    throw new Error('此来源的跨库移动尚未接入删除恢复，请使用复制；来源已保留。');
  if (state.mutationQueue.some(row => row.itemId === item.id) || state.providerConflicts.some(row => row.itemId === item.id))
    throw new Error('MDBX 来源仍有未同步修改或冲突，请先处理后再移动。');
  if (item.kind === 'login' && item.passkeyBindings && item.passkeyBindings.trim() !== '[]')
    throw new Error('MDBX 密码仍有关联 Passkey，关联迁移尚未完成，请使用复制。');
  return account;
}

export function assertBitwardenMdbxMoveBinding(state: VaultState, group: BitwardenMdbxMoveGroup): ProviderAccount {
  const current = state.providers.find(row => row.id === group.account.id);
  if (!current?.enabled || !sameProviderBinding(current, group.account)
    || current.config.nativeVaultId !== undefined && current.config.nativeVaultId !== group.vaultId) throw invalid();
  for (const expected of group.sources) {
    const item = state.items.find(row => row.id === expected.id);
    if (!item || JSON.stringify(item) !== JSON.stringify(expected)) throw new Error('MDBX 移动期间来源已变化，已保留来源和副本。');
    bitwardenMdbxMoveSource(state, item);
  }
  return current;
}
