import type { ProviderAccount, ProviderSourceRecord, VaultItem } from '../../core/model';
import type { PasswordProjectRemovalRecord } from '../../core/password-project-removal-journal';
import { bitwardenProjectCipherId } from '../../core/bitwarden-project-removal-local';
import { sameProviderBinding } from '../../core/provider';
import { createSourceRecord } from '../../core/source-records';
import { parseLosslessJson } from '../../core/lossless-json';
import { preserveLocalPasskeyUsage } from '../../passkey/ownership-policy';
import { bitwardenRemovalSnapshotSha256 } from './bitwarden-project-removal-transaction';
import { bitwardenMutationFingerprint } from './bitwarden-durable-sync';
import type { BitwardenPasskeyCopyReadback } from './bitwarden-passkey-preservation-adoption';

export interface BitwardenProjectRemovalReadback {
  operationId: string;
  journalRevision: number;
  account: ProviderAccount;
  items: VaultItem[];
  sourceRecords: ProviderSourceRecord[];
  passkeyCopies?: BitwardenPasskeyCopyReadback;
}

/** Validate the native result again and map provider projections onto existing
 * local identities. Called inside the encrypted vault write lock, with no I/O.
 */
export async function mergeBitwardenProjectRemovalReadback(record: PasswordProjectRemovalRecord, current: VaultItem[], result: BitwardenProjectRemovalReadback): Promise<VaultItem[]> {
  const fail = () => new Error('Bitwarden 删除回读与保存的项目不一致，恢复日志已保留。');
  const journal = record.bitwardenDeletion!, provider = record.providerBindings.find(row => row.kind === 'bitwarden');
  if (!provider || !journal?.retainedSnapshots || !journal.localChildren || journal.phase !== 'committed'
    || result.operationId !== record.id || result.journalRevision !== journal.revision || !sameProviderBinding(provider, result.account)) throw fail();
  const expected = [...journal.members, ...journal.retainedSnapshots], rawById = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(result.sourceRecords) || result.sourceRecords.length !== expected.length || !Array.isArray(result.items)
    || result.items.length > 10000) throw fail();
  for (const source of result.sourceRecords) {
    const saved = expected.find(row => row.cipherId === source?.remoteId);
    if (!saved || source.providerId !== provider.id || source.format !== 'bitwarden-cipher' || source.encoding !== 'json' || rawById.has(source.remoteId)) throw fail();
    const raw = parseLosslessJson(source.payload) as Record<string, unknown>;
    const id = raw.id ?? raw.Id, deletedAt = raw.deletedDate ?? raw.DeletedDate;
    if (id !== source.remoteId || source.revision !== String(raw.revisionDate ?? raw.RevisionDate)
      || Boolean(deletedAt) !== journal.members.some(row => row.cipherId === id)
      || await bitwardenRemovalSnapshotSha256(raw) !== saved.snapshotSha256
      || (await createSourceRecord({ ...source, payload: source.payload })).contentHash !== source.contentHash) throw fail();
    rawById.set(source.remoteId, raw);
  }
  const loginByRemoteId = new Map([...record.retained, ...record.removed].map(row => [row.providerRefs.find(ref => ref.providerId === provider.id)!.remoteId!, row]));
  const expectedRemoteIds = new Set([...loginByRemoteId.keys(), ...journal.localChildren.map(row => row.remoteId)]);
  if (result.items.length !== expectedRemoteIds.size) throw fail();
  const localByRemoteId = new Map<string, VaultItem>();
  for (const row of current) {
    const ref = row.providerRefs.find(ref => ref.providerId === provider.id);
    if (!ref?.remoteId || !rawById.has(bitwardenProjectCipherId(ref.remoteId))) continue;
    if (localByRemoteId.has(ref.remoteId)) throw fail();
    localByRemoteId.set(ref.remoteId, row);
  }
  const remoteIds = new Set<string>(), ids = new Set<string>(), incoming: VaultItem[] = [];
  for (const row of result.items) {
    if (!row || !['login', 'passkey', 'totp'].includes(row.kind) || row.providerRefs.length !== 1) throw fail();
    const ref = row.providerRefs[0], parentId = bitwardenProjectCipherId(ref.remoteId || ''), raw = rawById.get(parentId);
    if (!raw || ref.providerId !== provider.id || !ref.remoteId || !expectedRemoteIds.has(ref.remoteId) || remoteIds.has(ref.remoteId)
      || ref.revision !== new Date(String(raw.revisionDate ?? raw.RevisionDate)).toISOString()
      || row.deletedAt !== (raw.deletedDate || raw.DeletedDate ? new Date(String(raw.deletedDate || raw.DeletedDate)).toISOString() : undefined)
      || row.kind === 'login' && ref.remoteId !== parentId
      || row.kind === 'totp' && ref.remoteId !== `${parentId}#totp`
      || row.kind === 'passkey' && !ref.remoteId.startsWith(`${parentId}#fido2:`)) throw fail();
    const local = row.kind === 'login' ? current.find(item => item.id === loginByRemoteId.get(parentId)?.id) : localByRemoteId.get(ref.remoteId);
    if (!local || local.kind !== row.kind) throw fail();
    const baseline = row.kind === 'login' ? loginByRemoteId.get(parentId) : local;
    const baselineRef = baseline?.providerRefs.find(ref => ref.providerId === provider.id);
    if (!baseline || !baselineRef || ref.remoteFolderId !== baselineRef.remoteFolderId
      || JSON.stringify(ref.remoteCollectionIds) !== JSON.stringify(baselineRef.remoteCollectionIds)
      || row.kind === 'login' && (baseline.kind !== 'login' || row.passwordGroupId !== baseline.passwordGroupId)
      || await bitwardenMutationFingerprint(baseline) !== await bitwardenMutationFingerprint(row)) throw fail();
    const id = local.id;
    if (!id || ids.has(id)) throw fail();
    let mapped = { ...structuredClone(row), id, providerRefs: [...local.providerRefs.filter(ref => ref.providerId !== provider.id), ...row.providerRefs] } as VaultItem;
    if (local?.kind === 'passkey' && mapped.kind === 'passkey') mapped = preserveLocalPasskeyUsage(local, mapped);
    remoteIds.add(ref.remoteId); ids.add(id); incoming.push(mapped);
  }
  if ([...expectedRemoteIds].some(id => !remoteIds.has(id))) throw fail();
  // Only this project's known projections are replaced; unrelated providers and
  // independent records are never removed by a partial server result.
  return [...current.filter(row => !ids.has(row.id)), ...incoming];
}
