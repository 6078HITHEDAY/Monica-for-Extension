import type { ExtensionRequest } from '../runtime/messages';

/** Native mutations that bypass the ordinary provider sync queue. Reads,
 * exports, unlock and abort remain available during recovery. */
const directWrites = new Set<string>([
  'MDBX2_HEALTH_REPAIR_APPLY', 'MDBX2_COLLECTION_CREATE', 'MDBX2_COLLECTION_RENAME',
  'MDBX2_COLLECTION_MOVE', 'MDBX2_COLLECTION_DELETE', 'MDBX2_COLLECTION_RESTORE',
  'MDBX2_OBJECT_UPSERT', 'MDBX2_OBJECT_DELETE', 'MDBX2_HISTORY_REVERT',
  'MDBX2_SNAPSHOT_PRUNE_EXECUTE', 'MDBX2_SNAPSHOT_CREATE', 'MDBX2_SNAPSHOT_DELETE',
  'MDBX2_SNAPSHOT_RESTORE', 'MDBX2_CONFLICT_RESOLVE',
  'MDBX2_BOOTSTRAP_PUBLISH', 'MDBX2_BOOTSTRAP_REGISTER',
  'PROVIDER_ATTACHMENT_UPLOAD_BEGIN', 'PROVIDER_ATTACHMENT_UPLOAD_FINISH', 'PROVIDER_ATTACHMENT_DELETE'
]);

export function mdbxDirectWriteProvider(request: ExtensionRequest): string | undefined {
  if (request.type === 'MDBX2_BATCH_TRANSFER_EXECUTE') return request.input.targetProviderId;
  return directWrites.has(request.type) && 'providerId' in request ? request.providerId : undefined;
}
