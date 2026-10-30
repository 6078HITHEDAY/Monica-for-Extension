import { expect, it } from 'vitest';
import { mdbxDirectWriteProvider } from './mdbx-direct-write';
import type { ExtensionRequest } from '../runtime/messages';

it.each(['MDBX2_HEALTH_REPAIR_APPLY','MDBX2_OBJECT_UPSERT','MDBX2_OBJECT_DELETE','MDBX2_COLLECTION_MOVE',
  'MDBX2_HISTORY_REVERT','MDBX2_SNAPSHOT_RESTORE','MDBX2_SNAPSHOT_PRUNE_EXECUTE','MDBX2_CONFLICT_RESOLVE',
  'PROVIDER_ATTACHMENT_UPLOAD_BEGIN','PROVIDER_ATTACHMENT_UPLOAD_FINISH','PROVIDER_ATTACHMENT_DELETE'])(
  'protects the direct native %s write route', type => {
    expect(mdbxDirectWriteProvider({ type, providerId: 'native-source' } as ExtensionRequest)).toBe('native-source');
  });
it.each(['MDBX2_OBJECT_REVEAL','MDBX2_HISTORY_LIST','MDBX2_FILE_EXPORT_BEGIN','MDBX2_VAULT_LOCK','PROVIDER_ATTACHMENT_READ_BEGIN','PROVIDER_ATTACHMENT_UPLOAD_ABORT'])(
  'keeps recovery reads/export/lock/abort available: %s', type => {
    expect(mdbxDirectWriteProvider({ type, providerId: 'native-source' } as ExtensionRequest)).toBeUndefined();
  });
it('guards the native destination of a separate incoming transfer', () => {
  expect(mdbxDirectWriteProvider({ type: 'MDBX2_BATCH_TRANSFER_EXECUTE', input: { targetProviderId: 'native-source' } } as ExtensionRequest)).toBe('native-source');
});
