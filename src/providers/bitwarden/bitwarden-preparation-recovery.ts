import type { VaultItem } from '../../core/model';
import type { PasswordProjectRemovalRecord } from '../../core/password-project-removal-journal';
import { bitwardenProjectLocalSha256 } from '../../core/bitwarden-project-removal-local';
import { createSourceRecord } from '../../core/source-records';
import { parseLosslessJson } from '../../core/lossless-json';
import { sameProviderBinding } from '../../core/provider';
import { BitwardenClient, type BitwardenSessionConfig } from './bitwarden-client';
import { decodeBitwardenCipher } from './bitwarden-cipher-codec';
import { decryptBitwardenString } from './bitwarden-crypto';
import { resolveBitwardenOrganizationKeys } from './bitwarden-organization';
import { verifyBitwardenPasskeyPreservationCopy } from './bitwarden-passkey-preservation';
import { assertBitwardenPasskeyPreservationTransition } from './bitwarden-passkey-preservation-transaction';
import type { BitwardenProjectPreparationReadback } from './bitwarden-project-removal-restoration';

const invalid = () => new Error('准备阶段的 Passkey 副本尚未完整核实，原始记录和恢复日志已保留。');

/** Preserve every confirmed copy as its own remote-backed record. Originals
 * remain live; cancellation never deletes a copy or replaces its key material. */
export async function adoptBitwardenPreparationCopies(record: PasswordProjectRemovalRecord, items: VaultItem[], result: BitwardenProjectPreparationReadback) {
  const account = record.providerBindings.find(row => row.kind === 'bitwarden');
  if (!account || !record.bitwardenPreparationRecovery || record.status !== 'preparing'
    || result.preparationSnapshotSha256 !== await bitwardenProjectLocalSha256(record) || !sameProviderBinding(account, result.account)
    || !Array.isArray(result.passkeyCopies) || result.passkeyCopies.length > 1000) throw invalid();
  const preservation = structuredClone(record.bitwardenPasskeyPreservation);
  const candidates = (preservation?.sources || []).flatMap(source => source.copies.map(progress => ({ source, progress,
    copy: source.plan.copies.find(copy => copy.copyId === progress.copyId)! })));
  if (result.passkeyCopies.length > candidates.length) throw invalid();
  const vaultKey = new BitwardenClient().vaultKey(result.account.config as BitwardenSessionConfig);
  let organizations: Awaited<ReturnType<typeof resolveBitwardenOrganizationKeys>> | undefined;
  try {
    organizations = await resolveBitwardenOrganizationKeys({ profile: { organizations: result.decodeContext.organizations,
      privateKey: result.decodeContext.privateKey } }, vaultKey);
    const folders = new Map<string, string>();
    for (const folder of result.decodeContext.folders) {
      const id = folder.id ?? folder.Id, name = folder.name ?? folder.Name;
      if (typeof id !== 'string' || typeof name !== 'string' || folders.has(id)
        || folder.id !== undefined && folder.Id !== undefined && folder.id !== folder.Id
        || folder.name !== undefined && folder.Name !== undefined && folder.name !== folder.Name) throw invalid();
      folders.set(id, (await decryptBitwardenString(name, vaultKey)).trim().slice(0, 256));
    }
    const originals = new Set([...record.retained, ...record.removed].map(row => row.providerRefs.find(ref => ref.providerId === account.id)!.remoteId));
    const seen = new Set<string>(), remoteIds = new Set<string>(), additions: VaultItem[] = [];
    for (const entry of result.passkeyCopies) {
      const saved = candidates.find(candidate => candidate.source.plan.sourceCipherId === entry.sourceCipherId && candidate.copy.copyId === entry.copyId);
      const source = entry.sourceRecord;
      if (!saved || seen.has(entry.copyId) || source.providerId !== account.id || source.format !== 'bitwarden-cipher' || source.encoding !== 'json'
        || !source.remoteId || /[:#]/.test(source.remoteId) || originals.has(source.remoteId) || remoteIds.has(source.remoteId)
        || saved.progress.stage === 'verified' && saved.progress.remoteId !== source.remoteId
        || (await createSourceRecord(source)).contentHash !== source.contentHash) throw invalid();
      const raw = parseLosslessJson(source.payload) as Record<string, unknown>;
      if ((raw.id ?? raw.Id) !== source.remoteId || (raw.revisionDate ?? raw.RevisionDate) !== source.revision) throw invalid();
      const organization = raw.organizationId ?? raw.OrganizationId;
      const key = organization ? organizations.keys.get(String(organization)) : vaultKey;
      if (!key) throw invalid();
      await verifyBitwardenPasskeyPreservationCopy(saved.source.plan, saved.copy, raw, key);
      const decoded = await decodeBitwardenCipher(raw, account.id, key, folders.get(String(raw.folderId ?? raw.FolderId)), { requireReadableProjectMembership: true });
      if (decoded.warning || decoded.historyWarning || decoded.unsupported || decoded.items.length !== 2
        || !decoded.items.some(row => row.kind === 'login') || !decoded.items.some(row => row.kind === 'passkey')) throw invalid();
      for (const item of decoded.items) {
        if (items.some(row => row.providerRefs.some(ref => ref.providerId === account.id && ref.remoteId === item.providerRefs[0]?.remoteId))) throw invalid();
        additions.push({ ...item, id: crypto.randomUUID() } as VaultItem);
      }
      if (saved.progress.stage !== 'verified') {
        const next = { ...saved.source, revision: saved.source.revision + 1, copies: saved.source.copies.map(copy => copy.copyId === entry.copyId
          ? { ...copy, stage: 'verified' as const, remoteId: source.remoteId } : copy) };
        assertBitwardenPasskeyPreservationTransition(saved.source, next);
        Object.assign(saved.source, next);
      }
      seen.add(entry.copyId); remoteIds.add(source.remoteId);
    }
    // An absent attempted/verified copy is not proof that its creation failed.
    if (candidates.some(candidate => candidate.progress.stage !== 'ready' && !seen.has(candidate.copy.copyId))) throw invalid();
    return { items: [...items, ...additions], preservation };
  } finally {
    vaultKey.encKey.fill(0); vaultKey.macKey.fill(0);
    organizations?.keys.forEach(key => { key.encKey.fill(0); key.macKey.fill(0); });
  }
}
