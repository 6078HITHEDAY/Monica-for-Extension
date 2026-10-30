import type { Mdbx2NativeClient } from '../providers/mdbx2/native-client';
import { MDBX2_MAX_HISTORY_PAGE_SIZE, type Mdbx2CommitHistoryItem } from '../providers/mdbx2/native-contract';
import { validateMdbx2ContentWriteAnchor, type Mdbx2ContentWriteAnchor } from '../providers/mdbx2/content-write-anchor';
import type { NearbyNativeIntent } from './native-journal';
import { invalidNearby } from './wire-shape';

export interface NearbyRecoveryReviewView {
  reviewId: string;
  editedEntries: number;
  interveningCommits: number;
  remainingSteps: number;
}
export interface NearbyRecoveryProof {
  anchor: Mdbx2ContentWriteAnchor;
  commitIds: string[];
  editedEntries: number;
}
const allowedCommands = new Set(['collection-create', 'collection-rename', 'collection-presentation', 'collection-profile-set', 'label-create', 'label-update']);
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const fields = (values: string[]) => Array.isArray(values) && values.length > 0 && values.length <= 2
  && new Set(values).size === values.length && values.every(value => value === 'title' || value === 'payload');
function refuse(): never { return invalidNearby('native-recovery-overlap'); }

/** Fail closed. History previews are never compared as if they were full
 * payloads. Only structurally unchanged existing entries may have changed;
 * the remaining plan cannot mutate entries, their membership or their files.
 * Native authorization and revision checks still run on each resumed write. */
export async function reviewNearbyNativeRecovery(client: Pick<Mdbx2NativeClient, 'listCommitHistory' | 'listCommitDiff'>,
  handle: string, intent: NearbyNativeIntent, current: Mdbx2ContentWriteAnchor, active: () => void): Promise<NearbyRecoveryProof> {
  const sequence = intent.sequence;
  if (!sequence?.conflict || !sequence.completedSteps || sequence.completed?.length !== sequence.completedSteps
    || (sequence.resolutions?.length ?? 0) >= 8) refuse();
  const before = await validateMdbx2ContentWriteAnchor(sequence.anchor); active();
  const after = await validateMdbx2ContentWriteAnchor(current); active();
  if (before.writeRevision.vaultId !== intent.vaultId || after.writeRevision.vaultId !== intent.vaultId
    || before.writeRevision.revisionSha256 === after.writeRevision.revisionSha256) refuse();
  const oldMain = before.branches.find(b => b.branchName === 'main')!, main = after.branches.find(b => b.branchName === 'main')!;
  if (oldMain.branchId !== main.branchId || before.branches.length !== after.branches.length
    || before.branches.some(b => !after.branches.some(a => a.branchId === b.branchId && a.branchName === b.branchName
      && (b.branchName === 'main' || a.headCommitId === b.headCommitId)))) refuse();
  for (const write of [intent.write, ...sequence.remaining]) {
    if (write.plan.commands.some(c => !allowedCommands.has(c.kind))
      || write.plan.attachments.some(a => a.kind !== 'create' || a.objectId != null)) refuse();
  }

  // Native parents can point to the changed object's earlier version rather
  // than the previous vault-wide write. Native localSeq is monotonic per
  // device, while history pagination is ordered by wall-clock timestamps.
  // Therefore require a COMPLETE bounded history from one device, then prove
  // the contiguous sequence interval. Never stop at an apparent timestamp or
  // silently ignore a foreign device, missing page, gap or branch operation.
  const history = new Map<string, Mdbx2CommitHistoryItem>(), cursors = new Set<string>();
  const commitIds: string[] = [], entries = new Set<string>();
  let cursor: string | undefined, pages = 0;
  do {
    active(); if (pages++ >= 8) refuse();
    const page = await client.listCommitHistory(handle, { pageSize: MDBX2_MAX_HISTORY_PAGE_SIZE, ...(cursor ? { cursor } : {}) }); active();
    if (!Array.isArray(page.items) || page.items.length > MDBX2_MAX_HISTORY_PAGE_SIZE) refuse();
    for (const row of page.items) {
      if (!uuid.test(row.commitId) || history.has(row.commitId)) refuse();
      history.set(row.commitId, row);
    }
    cursor = page.nextCursor;
    if (cursor) { if (cursors.has(cursor)) refuse(); cursors.add(cursor); }
  } while (cursor);
  const baseline = history.get(oldMain.headCommitId), head = history.get(main.headCommitId);
  if (!baseline || !head || baseline.deviceId !== head.deviceId || !head.deviceId
    || !Number.isSafeInteger(baseline.localSeq) || !Number.isSafeInteger(head.localSeq)
    || baseline.localSeq < 1 || head.localSeq <= baseline.localSeq || head.localSeq - baseline.localSeq > 64) refuse();
  const sequences = new Map<number, Mdbx2CommitHistoryItem>();
  let genesis = 0;
  for (const row of history.values()) {
    // init.rs creates one parentless sequence-zero vault-meta commit, using
    // the creator label rather than the later per-vault device UUID.
    if (row.localSeq === 0 && row.legacy && row.commitKind === 'change' && row.changeScope === 'vault-meta'
      && !row.operationId && !row.operationKind && !row.branchName && !row.parentIds.length && !row.changes.length) {
      if (++genesis > 1) refuse();
      continue;
    }
    if (row.deviceId !== head.deviceId || !Number.isSafeInteger(row.localSeq) || row.localSeq < 1
      || row.localSeq > head.localSeq || sequences.has(row.localSeq)) refuse();
    sequences.set(row.localSeq, row);
  }
  for (let seq = head.localSeq; seq > baseline.localSeq; seq--) {
    const row = sequences.get(seq); if (!row) refuse();
    const next = row.commitId;
    // These native writers declare every command's footprint. Other operation
    // kinds need a separately audited footprint before joining this proof.
    if (row.legacy !== false || row.commitKind !== 'change' || row.changeScope !== 'entry' || row.branchName !== 'main'
      || !['monica-extension-upsert-object', 'monica-content-adoption-v1'].includes(row.operationKind ?? '') || !uuid.test(row.operationId ?? '')
      || row.parentIds.length !== 1 || !uuid.test(row.parentIds[0]) || !row.changes.length || row.changes.length > 128
      || new Set(row.changes.map(c => c.objectId)).size !== row.changes.length) refuse();
    if (row.changes.some(change => change.objectType !== 'entry' || change.action !== 'update' || !uuid.test(change.objectId) || !fields(change.fields))) refuse();
    const diff = await client.listCommitDiff(handle, next); active();
    if (diff.items.length !== row.changes.length || new Set(diff.items.map(d => d.objectId)).size !== diff.items.length) refuse();
    for (const change of row.changes) {
      const item = diff.items.find(d => d.objectId === change.objectId);
      if (!item || item.commitId !== next || item.objectType !== 'entry'
        || item.previousDeleted !== false || item.currentDeleted !== false || !uuid.test(item.collectionId ?? '')
        || !fields(item.changedFields) || change.fields.some(f => !item.changedFields.includes(f))) refuse();
      entries.add(change.objectId);
    }
    if (entries.size > 1024) refuse();
    commitIds.push(next);
  }
  if (!commitIds.length) refuse();
  return { anchor: after, commitIds, editedEntries: entries.size };
}
