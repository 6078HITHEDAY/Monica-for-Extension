import type { PasswordProjectRemovalRecord } from './password-project-removal-journal';
import type { BitwardenProjectLocalChild } from './bitwarden-project-removal-local';

export type BitwardenProjectDeletionStage = 'ready' | 'delete-attempted' | 'deleted' | 'restore-attempted' | 'restored';
export interface BitwardenProjectDeletionJournal {
  version: 1;
  revision: number;
  phase: 'deleting' | 'restoring' | 'committed' | 'restored';
  reason?: 'source-changed' | 'retained-changed' | 'source-live' | 'local-changed';
  /** Frozen native retained Ciphers, including embedded credentials and unknown fields. */
  retainedSnapshots?: Array<{ itemId: string; cipherId: string; snapshotSha256: string }>;
  /** Computed by the vault at finalization, never supplied by the manager. */
  localChildren?: BitwardenProjectLocalChild[];
  members: Array<{
    itemId: string;
    cipherId: string;
    /** Native ciphertext/attachment manifest, excluding server timestamps and signed URLs. */
    snapshotSha256: string;
    stage: BitwardenProjectDeletionStage;
  }>;
}

const invalid = () => new Error('Bitwarden 项目移除恢复记录无效，原始记录已保留。');
const stages: BitwardenProjectDeletionStage[] = ['ready', 'delete-attempted', 'deleted', 'restore-attempted', 'restored'];

export function validateBitwardenProjectDeletion(value: BitwardenProjectDeletionJournal, parent: PasswordProjectRemovalRecord): void {
  const external = parent.providerBindings.filter(row => row.kind !== 'local');
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !['deleting', 'restoring', 'committed', 'restored'].includes(value.phase)
    || value.reason !== undefined && !['source-changed', 'retained-changed', 'source-live', 'local-changed'].includes(value.reason)
    || external.length !== 1 || external[0].kind !== 'bitwarden' || parent.nativeDeletion
    || !['deleting', 'completed', 'cancelled'].includes(parent.status)
    || !Array.isArray(value.members) || value.members.length !== parent.removed.length
    || value.members.length < 1 || value.members.length >= 100) throw invalid();
  const ids = new Set<string>(), ciphers = new Set<string>();
  for (const entry of value.members) {
    const source = parent.removed.find(row => row.id === entry?.itemId);
    const ref = source?.providerRefs.find(row => row.providerId === external[0].id);
    if (!entry || !source || ids.has(entry.itemId) || !entry.cipherId || entry.cipherId.length > 512
      || entry.cipherId !== ref?.remoteId || ciphers.has(entry.cipherId) || entry.cipherId.includes(':')
      || !/^[a-f0-9]{64}$/.test(entry.snapshotSha256) || !stages.includes(entry.stage)) throw invalid();
    ids.add(entry.itemId); ciphers.add(entry.cipherId);
  }
  if (value.retainedSnapshots !== undefined) {
    if (!Array.isArray(value.retainedSnapshots) || value.retainedSnapshots.length !== parent.retained.length) throw invalid();
    for (const entry of value.retainedSnapshots) {
      const source = parent.retained.find(row => row.id === entry?.itemId);
      const ref = source?.providerRefs.find(row => row.providerId === external[0].id);
      if (!entry || !source || ids.has(entry.itemId) || typeof entry.cipherId !== 'string' || !entry.cipherId
        || entry.cipherId.length > 512 || entry.cipherId !== ref?.remoteId || ciphers.has(entry.cipherId)
        || /[:#]/.test(entry.cipherId) || !/^[a-f0-9]{64}$/.test(entry.snapshotSha256)) throw invalid();
      ids.add(entry.itemId); ciphers.add(entry.cipherId);
    }
  }
  if (value.localChildren !== undefined) {
    if (!Array.isArray(value.localChildren) || value.localChildren.length > 10000) throw invalid();
    const childRefs = new Set<string>();
    const parents = new Set([...parent.retained, ...parent.removed].map(row => row.providerRefs.find(ref => ref.providerId === external[0].id)?.remoteId));
    for (const child of value.localChildren) {
      if (!child || !['passkey', 'totp'].includes(child.kind) || typeof child.itemId !== 'string' || !child.itemId || child.itemId.length > 512
        || ids.has(child.itemId) || !parents.has(child.cipherId) || typeof child.remoteId !== 'string' || child.remoteId.length > 512
        || childRefs.has(child.remoteId) || !/^[a-f0-9]{64}$/.test(child.snapshotSha256)
        || child.usageIndependentSha256 !== undefined && (child.kind !== 'passkey' || !/^[a-f0-9]{64}$/.test(child.usageIndependentSha256))
        || (child.kind === 'totp' ? child.remoteId !== `${child.cipherId}#totp` : !child.remoteId.startsWith(`${child.cipherId}#fido2:`))) throw invalid();
      ids.add(child.itemId); childRefs.add(child.remoteId);
    }
  }
  if (parent.retained.some(row => value.members.some(member => member.cipherId === row.providerRefs.find(ref => ref.providerId === external[0].id)?.remoteId))
    || value.phase === 'deleting' && (value.reason || value.members.some(row => ['restore-attempted', 'restored'].includes(row.stage)))
    || value.phase === 'committed' && (value.reason || value.members.some(row => row.stage !== 'deleted'))
    || ['restoring', 'restored'].includes(value.phase) && !value.reason
    || value.phase === 'restored' && value.members.some(row => row.stage !== 'ready' && row.stage !== 'restored')
    || parent.status === 'completed' && value.phase !== 'committed'
    || parent.status === 'cancelled' && value.phase !== 'restored') throw invalid();
}

/** Only progress is mutable; a worker cannot replace the source identities or baselines on retry. */
export function assertBitwardenProjectDeletionTransition(before: BitwardenProjectDeletionJournal, after: BitwardenProjectDeletionJournal): void {
  if (after.revision !== before.revision + 1 || before.version !== after.version || before.members.length !== after.members.length
    || before.reason && after.reason !== before.reason
    || JSON.stringify(before.retainedSnapshots) !== JSON.stringify(after.retainedSnapshots)
    || JSON.stringify(before.localChildren) !== JSON.stringify(after.localChildren)) throw invalid();
  const phases: Record<BitwardenProjectDeletionJournal['phase'], BitwardenProjectDeletionJournal['phase'][]> = {
    deleting: ['deleting', 'restoring', 'committed'], restoring: ['restoring', 'restored'], committed: ['restoring'], restored: [] };
  if (!phases[before.phase].includes(after.phase)) throw invalid();
  const allowed: Record<BitwardenProjectDeletionStage, BitwardenProjectDeletionStage[]> = {
    ready: ['ready', 'delete-attempted'], 'delete-attempted': ['delete-attempted', 'deleted', 'restore-attempted', 'restored'],
    deleted: ['deleted', 'restore-attempted', 'restored'], 'restore-attempted': ['restore-attempted', 'restored'], restored: ['restored']
  };
  let changedMembers = 0;
  before.members.forEach((row, index) => {
    const next = after.members[index];
    if (row.itemId !== next.itemId || row.cipherId !== next.cipherId || row.snapshotSha256 !== next.snapshotSha256
      || !allowed[row.stage].includes(next.stage)) throw invalid();
    if (row.stage !== next.stage) {
      changedMembers++;
      if (before.phase !== after.phase || (after.phase === 'deleting'
        ? !['delete-attempted', 'deleted'].includes(next.stage)
        : after.phase !== 'restoring' || !['restore-attempted', 'restored'].includes(next.stage))) throw invalid();
    }
  });
  if (changedMembers > 1 || !changedMembers && before.phase === after.phase) throw invalid();
}
