import type { Mdbx2WriteRevision } from '../providers/mdbx2/native-contract';

/** A legacy receipt authorizes replay only. New deletions always carry the
 * complete source revision authenticated before content/file verification. */
export type Mdbx2SourceDeletionIntent = {
  version: 1;
  operationScope: string;
  writeRevision: Mdbx2WriteRevision;
} | {
  version: 0;
  operationScope: string;
  vaultId: string;
  receipt: { operationId: string; commitId: string };
};

export function readMdbx2SourceDeletionIntent(value: unknown): Mdbx2SourceDeletionIntent {
  const row = value as Mdbx2SourceDeletionIntent;
  const id = (value: unknown) => typeof value === 'string' && !!value && value.length <= 512;
  const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (!row || !digest(row.operationScope) || !(row.version === 1 && row.writeRevision
    && id(row.writeRevision.vaultId) && digest(row.writeRevision.revisionSha256)
    || row.version === 0 && id(row.vaultId) && row.receipt && id(row.receipt.operationId) && id(row.receipt.commitId)))
    throw new Error('MDBX 来源删除恢复记录无效，已保留来源和副本。');
  return structuredClone(row);
}
