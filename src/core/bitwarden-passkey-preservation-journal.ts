import type { PasswordProjectRemovalRecord } from './password-project-removal-journal';
import type { BitwardenProjectLocalChild } from './bitwarden-project-removal-local';
import { validateBitwardenPasskeyPreservationJournal, type BitwardenPasskeyPreservationJournal } from '../providers/bitwarden/bitwarden-passkey-preservation-transaction';

export interface BitwardenProjectPasskeyPreservation {
  version: 1;
  /** Frozen by the vault before the first remote copy request. */
  localChildren: BitwardenProjectLocalChild[];
  sources: BitwardenPasskeyPreservationJournal[];
}

export function validateBitwardenProjectPasskeyPreservation(value: BitwardenProjectPasskeyPreservation, parent: PasswordProjectRemovalRecord): void {
  const fail = () => new Error('Bitwarden Passkey 保留记录无效，原始凭据已保留。');
  const external = parent.providerBindings.filter(row => row.kind !== 'local');
  if (!value || value.version !== 1 || external.length !== 1 || external[0].kind !== 'bitwarden' || parent.nativeDeletion
    || !Array.isArray(value.sources) || value.sources.length !== parent.removed.length
    || !Array.isArray(value.localChildren) || value.localChildren.length > 10000) throw fail();
  const expected = new Set(parent.removed.map(row => row.providerRefs.find(ref => ref.providerId === external[0].id)?.remoteId));
  const parents = new Set([...expected, ...parent.retained.map(row => row.providerRefs.find(ref => ref.providerId === external[0].id)?.remoteId)]);
  const seen = new Set<string>();
  const copyIds = new Set<string>();
  for (const source of value.sources) {
    validateBitwardenPasskeyPreservationJournal(source);
    if (source.plan.operationId !== parent.id || !expected.has(source.plan.sourceCipherId) || seen.has(source.plan.sourceCipherId)) throw fail();
    seen.add(source.plan.sourceCipherId);
    for (const copy of source.copies) {
      if (copy.remoteId && (parents.has(copy.remoteId) || copyIds.has(copy.remoteId))) throw fail();
      if (copy.remoteId) copyIds.add(copy.remoteId);
    }
    if (parent.bitwardenDeletion && (source.copies.some(row => row.stage !== 'verified')
      || parent.bitwardenDeletion.members.find(row => row.cipherId === source.plan.sourceCipherId)?.snapshotSha256 !== source.plan.sourceSha256)) throw fail();
  }
  const ids = new Set<string>(), refs = new Set<string>();
  for (const child of value.localChildren) {
    if (!child || !['passkey', 'totp'].includes(child.kind) || typeof child.itemId !== 'string' || !child.itemId || child.itemId.length > 512
      || ids.has(child.itemId) || !parents.has(child.cipherId) || typeof child.remoteId !== 'string' || child.remoteId.length > 512
      || refs.has(child.remoteId) || !/^[a-f0-9]{64}$/.test(child.snapshotSha256)
      || child.usageIndependentSha256 !== undefined && (child.kind !== 'passkey' || !/^[a-f0-9]{64}$/.test(child.usageIndependentSha256))
      || (child.kind === 'totp' ? child.remoteId !== `${child.cipherId}#totp` : !child.remoteId.startsWith(`${child.cipherId}#fido2:`))) throw fail();
    ids.add(child.itemId); refs.add(child.remoteId);
  }
}
