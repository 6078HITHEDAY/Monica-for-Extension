import type { ProviderAccount, VaultItem, VaultState } from './model';
import { keePassRemoteUrl } from '../providers/keepass/keepass-webdav-client';
import { sameProviderBinding } from './provider';
import { assertMdbx2TransferOperationId } from '../providers/mdbx2/mdbx2-transfer-identity';
import { readKeePassSourceRemoval, type KeePassSourceRemovalRequest, type KeePassSourceRemovalResult } from '../providers/keepass/keepass-source-removal';
import { normalizeUuid } from '../providers/keepass/keepass-field-reference';

export interface BitwardenKeePassMoveGroup {
  id: string;
  account: ProviderAccount;
  sources: VaultItem[];
  fingerprints: Array<{ copyId: string; sha256: string }>;
  inputSha256: string;
  inputContentSha256: string;
  deletion?: KeePassSourceRemovalRequest;
  receipt?: KeePassSourceRemovalResult;
  publication?: { workingSha256: string; confirmedAt: string };
}
const invalid = () => new Error('Bitwarden 的 KeePass 移动恢复记录无效，来源和副本已保留。');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function sameKeePassMoveFile(left: ProviderAccount, right: ProviderAccount): boolean {
  if (left.kind !== 'keepass' || right.kind !== 'keepass') return false;
  if (left.id === right.id) return true;
  const a = left.config, b = right.config;
  if (a.sourceMode !== b.sourceMode) return false;
  if (a.sourceMode === 'webdav') {
    try { return keePassRemoteUrl(String(a.webDavBaseUrl), String(a.remotePath)) === keePassRemoteUrl(String(b.webDavBaseUrl), String(b.remotePath)); }
    catch { return false; }
  }
  const fields = a.sourceMode === 'local-file' ? ['localFileSourceSha256']
    : a.sourceMode === 'onedrive' ? ['oneDriveDriveId', 'oneDriveItemId'] : [];
  return fields.length > 0 && fields.every(key => typeof a[key] === 'string' && !!a[key] && a[key] === b[key]);
}

/** Stable identity excludes refreshed tokens, connection labels and checkpoints. */
export function bitwardenKeePassAccountSnapshot(account: ProviderAccount): ProviderAccount {
  const config = account.config;
  const connection = config.oneDriveConnection as { id?: unknown; clientId?: unknown; profile?: { id?: unknown } } | undefined;
  const keys = ['sourceMode','databaseId','localFileSourceSha256','webDavBaseUrl','webDavUsername','webDavPassword','remotePath',
    'databasePassword','keyFile','oneDriveDriveId','oneDriveItemId','cacheEncryptionKey'];
  return { id: account.id, kind: account.kind, enabled: account.enabled, name: '', isDefaultSaveTarget: false,
    config: { ...Object.fromEntries(keys.filter(key => config[key] !== undefined).map(key => [key, config[key]])),
      ...(connection ? { oneDriveConnection: { id: connection.id, clientId: connection.clientId, profile: { id: connection.profile?.id } } } : {}) } };
}

export function bitwardenKeePassMoveSource(state: VaultState, item: VaultItem): ProviderAccount {
  const ref = item.providerRefs?.[0], account = state.providers.find(row => row.id === ref?.providerId);
  if (!account?.enabled || account.kind !== 'keepass' || !['local-file','webdav','onedrive'].includes(String(account.config.sourceMode))
    || item.deletedAt || item.kind === 'opaque' || item.providerRefs.length !== 1 || ref.remoteId !== item.keepassEntryUuid || !ref.etag
    || !item.keepassEntryUuid || !/^[a-f0-9]{32}$/.test(normalizeUuid(item.keepassEntryUuid))) throw invalid();
  if (state.mutationQueue.some(row => row.providerId === account.id) || state.providerConflicts.some(row => row.providerId === account.id))
    throw new Error('KeePass 来源仍有未保存修改或冲突，请先处理后再移动。');
  return account;
}

export function readBitwardenKeePassMoveGroups(value: unknown): BitwardenKeePassMoveGroup[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.length || value.length > 200) throw invalid();
  const ids = new Set<string>(), providers = new Set<string>(), sources = new Set<string>(), copies = new Set<string>();
  for (const group of value as BitwardenKeePassMoveGroup[]) {
    if (!group || !group.account || typeof group.account.id !== 'string' || !group.account.id || group.account.id.length > 128 || !group.account.config || typeof group.account.config !== 'object' || Array.isArray(group.account.config)
      || ids.has(group.id) || providers.has(group.account?.id) || !digest(group.inputSha256) || !digest(group.inputContentSha256)
      || !Array.isArray(group.sources) || !group.sources.length || group.sources.length > 200
      || !Array.isArray(group.fingerprints) || group.fingerprints.length !== group.sources.length) throw invalid();
    assertMdbx2TransferOperationId(group.id); ids.add(group.id); providers.add(group.account.id);
    // Reuse the file layer's validation of the provider and native source IDs.
    readKeePassSourceRemoval(group.account, { version: 1, operationId: group.id, createdAt: '2026-10-12T00:00:00Z',
      targetProviderId: group.account.id === 'validation-target' ? 'validation-other' : 'validation-target', targetProofSha256: '0'.repeat(64), expectedWorkingSha256: group.inputSha256,
      expectedContentSha256: group.inputContentSha256, sources: group.sources });
    for (const source of group.sources) { if (sources.has(source.id)) throw invalid(); sources.add(source.id); }
    for (const row of group.fingerprints) {
      if (!row || !digest(row.sha256) || copies.has(row.copyId)) throw invalid();
      assertMdbx2TransferOperationId(row.copyId); copies.add(row.copyId);
    }
    if (group.deletion !== undefined) {
      const request = readKeePassSourceRemoval(group.account, group.deletion);
      if (request.operationId !== group.id || request.expectedWorkingSha256 !== group.inputSha256
        || request.expectedContentSha256 !== group.inputContentSha256 || JSON.stringify(request.sources) !== JSON.stringify(group.sources)) throw invalid();
    }
    if (group.receipt !== undefined) assertBitwardenKeePassReceipt(group, group.receipt);
    if (group.publication !== undefined && (!group.publication || !group.receipt || !digest(group.publication.workingSha256) || group.publication.workingSha256 !== group.receipt.outputSha256
      || typeof group.publication.confirmedAt !== 'string' || !Number.isFinite(Date.parse(group.publication.confirmedAt)))) throw invalid();
  }
  if (value.some((group, index) => value.slice(0, index).some(other => sameKeePassMoveFile(group.account, other.account)))) throw invalid();
  if (sources.size > 200) throw invalid();
  return structuredClone(value);
}

export function assertBitwardenKeePassReceipt(group: BitwardenKeePassMoveGroup, receipt: KeePassSourceRemovalResult): void {
  if (!group.deletion || !receipt || receipt.inputSha256 !== group.inputSha256 || !digest(receipt.outputSha256)
    || typeof receipt.recycleBinUuid !== 'string' || !/^[a-f0-9]{32}$/.test(normalizeUuid(receipt.recycleBinUuid))
    || !Array.isArray(receipt.entries) || receipt.entries.length !== group.sources.length
    || new Set(receipt.entries.map(row => row?.sourceItemId)).size !== group.sources.length
    || receipt.entries.some(row => !row || !group.sources.some(source => source.id === row.sourceItemId && source.keepassEntryUuid === row.entryUuid)
      || normalizeUuid(row.entryUuid) === normalizeUuid(receipt.recycleBinUuid))) throw invalid();
}

export function assertBitwardenKeePassMoveBinding(state: VaultState, group: BitwardenKeePassMoveGroup): ProviderAccount {
  const current = state.providers.find(row => row.id === group.account.id);
  if (!current?.enabled || !sameProviderBinding(current, group.account)
    || JSON.stringify(bitwardenKeePassAccountSnapshot(current)) !== JSON.stringify(bitwardenKeePassAccountSnapshot(group.account))) throw invalid();
  for (const expected of group.sources) {
    const item = state.items.find(row => row.id === expected.id);
    if (!item || JSON.stringify(item) !== JSON.stringify(expected)) throw new Error('KeePass 移动期间来源已变化，来源和副本已保留。');
    bitwardenKeePassMoveSource(state, item);
  }
  return current;
}
