import type { ProviderAccount, ProviderConflictInput, ProviderSourceRecord, VaultItem } from '../../core/model';
import type { PasswordProjectRemovalRecord } from '../../core/password-project-removal-journal';
import { bitwardenProjectCipherId, bitwardenProjectLocalSha256 } from '../../core/bitwarden-project-removal-local';
import { sameProviderBinding } from '../../core/provider';
import { createSourceRecord, sourceRecordsBudgetError } from '../../core/source-records';
import { parseLosslessJson } from '../../core/lossless-json';
import { assertPasskeyCounterNotRegressed, preserveLocalPasskeyUsage, samePasskeyCredential } from '../../passkey/ownership-policy';
import { BitwardenClient, type BitwardenSessionConfig } from './bitwarden-client';
import { decodeBitwardenCipher } from './bitwarden-cipher-codec';
import { decryptBitwardenString } from './bitwarden-crypto';
import { resolveBitwardenOrganizationKeys } from './bitwarden-organization';
import { bitwardenRemovalSnapshotSha256 } from './bitwarden-project-removal-transaction';

/** Native encrypted records only: the vault derives its own projections rather
 * than accepting caller-supplied plaintext after legitimate remote edits. */
export interface BitwardenProjectRestorationReadback {
  operationId: string;
  journalRevision: number;
  account: ProviderAccount;
  sourceRecords: ProviderSourceRecord[];
  decodeContext: { folders: Record<string, unknown>[]; organizations: Record<string, unknown>[]; privateKey?: string };
}

export interface BitwardenProjectPreparationReadback extends Omit<BitwardenProjectRestorationReadback, 'journalRevision'> {
  preparationSnapshotSha256: string;
  /** Only observed copies; a ready plan may have no remote copy. */
  passkeyCopies: Array<{ sourceCipherId: string; copyId: string; sourceRecord: ProviderSourceRecord }>;
}

const field = (row: Record<string, unknown>, name: string): unknown => {
  const upper = name[0].toUpperCase() + name.slice(1);
  if (name in row && upper in row && JSON.stringify(row[name]) !== JSON.stringify(row[upper])) throw invalid();
  return row[name] ?? row[upper];
};
const invalid = () => new Error('Bitwarden 补偿回读不完整或已变化，原始记录和恢复日志已保留。');

/** Runs without network I/O inside the final encrypted write. */
export async function mergeBitwardenProjectRestoration(record: PasswordProjectRemovalRecord, current: VaultItem[],
  result: BitwardenProjectRestorationReadback | BitwardenProjectPreparationReadback, localChanges: ReadonlySet<string> = new Set()): Promise<{ items: VaultItem[]; conflicts: ProviderConflictInput[] }> {
  const provider = record.providerBindings.find(row => row.kind === 'bitwarden'), journal = record.bitwardenDeletion;
  const preparing = 'preparationSnapshotSha256' in result;
  if (!provider || (preparing ? record.status !== 'preparing' || !record.bitwardenPreparationRecovery || journal || record.nativeDeletion
        || result.preparationSnapshotSha256 !== await bitwardenProjectLocalSha256(record)
      : journal?.phase !== 'restored' || !journal.localChildren || !journal.retainedSnapshots || result.journalRevision !== journal.revision)
    || result.operationId !== record.id || !sameProviderBinding(provider, result.account)
    || !Array.isArray(result.sourceRecords) || result.sourceRecords.length > 1000 || sourceRecordsBudgetError(result.sourceRecords)
    || !result.decodeContext || !Array.isArray(result.decodeContext.folders) || !Array.isArray(result.decodeContext.organizations)) throw invalid();
  const originalIds = new Set(preparing ? [...record.retained, ...record.removed].map(row => row.providerRefs.find(ref => ref.providerId === provider.id)!.remoteId!)
    : [...journal!.members, ...journal!.retainedSnapshots!].map(row => row.cipherId));
  const rawById = new Map<string, Record<string, unknown>>();
  for (const source of result.sourceRecords) {
    if (source?.providerId !== provider.id || source.format !== 'bitwarden-cipher' || source.encoding !== 'json'
      || !source.remoteId || /[:#]/.test(source.remoteId) || rawById.has(source.remoteId)) throw invalid();
    const raw = parseLosslessJson(source.payload) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || field(raw, 'id') !== source.remoteId || field(raw, 'type') !== 1
      || source.revision !== field(raw, 'revisionDate')
      || (await createSourceRecord(source)).contentHash !== source.contentHash) throw invalid();
    await bitwardenRemovalSnapshotSha256(raw);
    const member = journal?.members.find(row => row.cipherId === source.remoteId);
    // Untouched sources may have been independently trashed. Never resurrect
    // those; only this operation's touched sources must be confirmed live.
    if ((preparing && originalIds.has(source.remoteId) || member && member.stage !== 'ready') && field(raw, 'deletedDate')) throw invalid();
    rawById.set(source.remoteId, raw);
  }
  if ([...originalIds].some(id => !rawById.has(id))) throw invalid();
  const vaultKey = new BitwardenClient().vaultKey(result.account.config as BitwardenSessionConfig);
  let organizations: Awaited<ReturnType<typeof resolveBitwardenOrganizationKeys>> | undefined;
  try {
    organizations = await resolveBitwardenOrganizationKeys({ profile: {
      organizations: result.decodeContext.organizations, privateKey: result.decodeContext.privateKey
    } }, vaultKey);
    const folders = new Map<string, string>();
    for (const folder of result.decodeContext.folders) {
      if (!folder || typeof folder !== 'object' || typeof field(folder, 'id') !== 'string' || typeof field(folder, 'name') !== 'string') throw invalid();
      const id = String(field(folder, 'id'));
      if (folders.has(id)) throw invalid();
      folders.set(id, (await decryptBitwardenString(String(field(folder, 'name')), vaultKey)).trim().slice(0, 256));
    }
    const localByRemote = new Map<string, VaultItem>();
    for (const row of current) for (const ref of row.providerRefs) {
      if (ref.providerId !== provider.id || !ref.remoteId || !rawById.has(bitwardenProjectCipherId(ref.remoteId))) continue;
      if (localByRemote.has(ref.remoteId)) throw invalid();
      localByRemote.set(ref.remoteId, row);
    }
    const incoming: VaultItem[] = [], conflicts: ProviderConflictInput[] = [], seenIds = new Set<string>(), seenRemote = new Set<string>();
    for (const [cipherId, raw] of rawById) {
      const organizationId = field(raw, 'organizationId'), key = organizationId ? organizations.keys.get(String(organizationId)) : vaultKey;
      if (!key) throw invalid();
      const decoded = await decodeBitwardenCipher(raw, provider.id, key, folders.get(String(field(raw, 'folderId'))), { requireReadableProjectMembership: true });
      const login = decoded.items.find(row => row.kind === 'login');
      if (decoded.warning || decoded.historyWarning || decoded.unsupported || !login
        || !originalIds.has(cipherId) && (login.deletedAt || login.passwordGroupId !== record.retained[0].passwordGroupId)) throw invalid();
      for (const item of decoded.items) {
        const remoteId = item.providerRefs[0]?.remoteId;
        if (!remoteId || seenRemote.has(remoteId) || !['login', 'totp', 'passkey'].includes(item.kind)) throw invalid();
        const local = localByRemote.get(remoteId);
        if (local && local.kind !== item.kind) throw invalid();
        let mapped = { ...item, id: local?.id || item.id,
          providerRefs: [...(local?.providerRefs.filter(ref => ref.providerId !== provider.id) || []), ...item.providerRefs] } as VaultItem;
        if (seenIds.has(mapped.id) || !local && current.some(row => row.id === mapped.id)) throw invalid();
        if (local && localChanges.has(local.id)) {
          const remote = local.kind === 'passkey' && mapped.kind === 'passkey' ? preserveLocalPasskeyUsage(local, mapped) : mapped;
          conflicts.push({ itemId: local.id, local: structuredClone(local), remote, requiresExplicitResolution: true,
            reason: '项目移除期间本地内容已修改，移除已撤销；本地与远端版本均已保留，请核对后选择。' });
          mapped = structuredClone(local);
        } else if (local?.kind === 'passkey' && mapped.kind === 'passkey') {
          let compatible = samePasskeyCredential(local, mapped);
          try { assertPasskeyCounterNotRegressed(mapped, local); } catch { compatible = false; }
          if (compatible) mapped = preserveLocalPasskeyUsage(local, mapped);
          else {
            conflicts.push({ itemId: local.id, local: structuredClone(local), remote: mapped, requiresExplicitResolution: true,
              reason: '补偿恢复后远端 Passkey 的签名身份或计数发生冲突，已保留本地凭据，请核对后选择。' });
            mapped = structuredClone(local);
          }
        }
        seenIds.add(mapped.id); seenRemote.add(remoteId); incoming.push(mapped);
      }
    }
    // An independently removed embedded credential stays locally available for
    // an explicit conflict decision. Never discard a private key on rollback.
    conflicts.push(...[...localByRemote.entries()].filter(([id]) => !seenRemote.has(id)).map(([, local]) => ({
      itemId: local.id, local: structuredClone(local), requiresExplicitResolution: true as const,
      reason: '补偿恢复后远端已移除此关联凭据，本地版本已保留，请核对后选择。'
    })));
    return { items: [...current.filter(row => !seenIds.has(row.id)), ...incoming], conflicts };
  } finally {
    vaultKey.encKey.fill(0); vaultKey.macKey.fill(0);
    organizations?.keys.forEach(key => { key.encKey.fill(0); key.macKey.fill(0); });
  }
}
