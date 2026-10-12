import { expect, it, vi } from 'vitest';
import { createLoginItem, type ProviderAccount, type VaultItem } from '../../core/model';
import { deleteMdbx2TransferSources, prepareMdbx2TransferSourceDeletion, assertMdbx2SourceDeletionScope } from './mdbx2-transfer-source-delete';
import type { Mdbx2NativeClient } from './native-client';
import { readMdbx2SourceDeletionIntent } from '../../core/mdbx2-source-deletion';

const source: ProviderAccount = { id: 'source', kind: 'mdbx2', name: 'Source', enabled: true, isDefaultSaveTarget: false, config: { vaultHandle: 'source-handle' } };
const item = { ...createLoginItem({ title: 'Synthetic' }), providerRefs: [{ providerId: source.id, remoteId: 'object', revision: 'revision' }] };
const operationId = '11111111-1111-4111-8111-111111111111';
const revision = { vaultId: 'source-vault', revisionSha256: 'ab'.repeat(32) };
function client() { return {
  mutateObjects: vi.fn<Mdbx2NativeClient['mutateObjects']>(),
  resolveObjectOperation: vi.fn<Mdbx2NativeClient['resolveObjectOperation']>().mockResolvedValue({ known: false, committed: false }),
  readWriteRevision: vi.fn<Mdbx2NativeClient['readWriteRevision']>().mockResolvedValue(revision),
  vaultStatus: vi.fn<Mdbx2NativeClient['vaultStatus']>().mockResolvedValue({ vaultHandle: 'source-handle', vaultId: revision.vaultId, open: true, available: true })
}; }
const result = { changed: true, operationId, commitId: 'commit', items: [{ kind: 'delete' as const, changed: true, logicalObjectId: 'native:object', objectId: 'object' }] };
async function prepare(native = client(), verify: () => Promise<void> = vi.fn(async () => {})) {
  const intent = await prepareMdbx2TransferSourceDeletion(native, source, [item], operationId, 'target', revision.vaultId, verify);
  return { native, intent, verify };
}

it('rejects same-vault deletion, mixed sources, duplicate native IDs and oversized groups before IO', async () => {
  const native = client();
  for (const [items, target] of [[[item], source.id], [[{ ...item, providerRefs: [...item.providerRefs, { providerId: 'other' }] }], 'target'],
    [[item, { ...item, id: 'other-local-id' }], 'target'], [Array(51).fill(item), 'target']] as [VaultItem[], string][]) {
    await expect(prepareMdbx2TransferSourceDeletion(native, source, items, operationId, target, revision.vaultId, async () => {})).rejects.toThrow();
  }
  expect(native.vaultStatus).not.toHaveBeenCalled(); expect(native.mutateObjects).not.toHaveBeenCalled();
});

it('binds the exact source revision to an immutable deletion and passes it to the native transaction', async () => {
  const { native, intent, verify } = await prepare();
  expect(verify).toHaveBeenCalledOnce(); expect(native.mutateObjects).not.toHaveBeenCalled();
  expect(intent).toMatchObject({ version: 1, writeRevision: revision });
  native.mutateObjects.mockResolvedValue(result);
  await deleteMdbx2TransferSources(native, source, [item], operationId, 'target', intent);
  expect(native.mutateObjects).toHaveBeenCalledWith('source-handle', intent.operationScope,
    [{ kind: 'delete', logicalObjectId: 'native:object', expectedHeadCommitId: 'revision' }], 120_000, revision);
});

it.each(['revision', 'vault', 'files'] as const)('refuses a changed %s during read-only source verification', async change => {
  const native = client();
  const verify = async () => {
    if (change === 'files') throw new Error('files changed');
    native.readWriteRevision.mockResolvedValue({ ...revision, ...(change === 'revision' ? { revisionSha256: 'cd'.repeat(32) } : { vaultId: 'other' }) });
  };
  await expect(prepare(native, verify)).rejects.toThrow(); expect(native.mutateObjects).not.toHaveBeenCalled();
});

it('rejects a forged scope, another source vault, or altered source heads before deletion', async () => {
  const { native, intent } = await prepare();
  await expect(deleteMdbx2TransferSources(native, source, [item], operationId, 'target', { ...intent, operationScope: 'cd'.repeat(32) })).rejects.toThrow();
  await expect(deleteMdbx2TransferSources(native, source, [{ ...item, providerRefs: [{ ...item.providerRefs[0], revision: 'new' }] }], operationId, 'target', intent)).rejects.toThrow();
  native.vaultStatus.mockResolvedValue({ vaultHandle: 'source-handle', vaultId: 'replacement-vault', open: true, available: true });
  await expect(deleteMdbx2TransferSources(native, source, [item], operationId, 'target', intent)).rejects.toThrow();
  expect(native.mutateObjects).not.toHaveBeenCalled();
});

it('does not retry a conflict or refresh the revision without a committed receipt', async () => {
  const { native, intent } = await prepare(); native.mutateObjects.mockRejectedValue(new Error('revision conflict'));
  await expect(deleteMdbx2TransferSources(native, source, [item], operationId, 'target', intent)).rejects.toThrow('revision conflict');
  expect(native.mutateObjects).toHaveBeenCalledTimes(1); expect(native.readWriteRevision).toHaveBeenCalledTimes(2);
});

it('replays the same guarded request after a lost reply even if the source has advanced', async () => {
  const { native, intent } = await prepare();
  native.readWriteRevision.mockRejectedValue(new Error('Must not read deleted source'));
  native.mutateObjects.mockRejectedValueOnce(new Error('lost')).mockResolvedValue(result);
  native.resolveObjectOperation.mockResolvedValue({ known: true, committed: true, operationId, commitId: result.commitId });
  expect(await deleteMdbx2TransferSources(native, source, [item], operationId, 'target', intent)).toEqual(result);
  expect(native.mutateObjects.mock.calls[1]).toEqual(native.mutateObjects.mock.calls[0]);
});

it('rejects a mismatched recovery receipt or a response for another object', async () => {
  const { native, intent } = await prepare(); native.mutateObjects.mockRejectedValueOnce(new Error('lost'));
  native.resolveObjectOperation.mockResolvedValue({ known: true, committed: true, operationId, commitId: 'expected-commit' });
  native.mutateObjects.mockResolvedValue({ ...result, commitId: 'wrong-commit' });
  await expect(deleteMdbx2TransferSources(native, source, [item], operationId, 'target', intent)).rejects.toThrow('响应');
  native.mutateObjects.mockResolvedValue({ ...result, items: [{ ...result.items[0], objectId: 'other' }] });
  await expect(deleteMdbx2TransferSources(native, source, [item], operationId, 'target', intent)).rejects.toThrow('响应');
});

it('recovers an old committed deletion without reading missing sources and never authorizes a new unguarded write', async () => {
  const native = client(); native.resolveObjectOperation.mockResolvedValue({ known: true, committed: true, operationId, commitId: result.commitId });
  const { intent, verify } = await prepare(native);
  expect(intent.version).toBe(0); expect(verify).not.toHaveBeenCalled(); expect(native.readWriteRevision).not.toHaveBeenCalled();
  native.mutateObjects.mockResolvedValue(result);
  await deleteMdbx2TransferSources(native, source, [item], operationId, 'target', intent);
  expect(native.mutateObjects.mock.calls[0][4]).toBeUndefined();
  native.mutateObjects.mockClear(); native.resolveObjectOperation.mockResolvedValue({ known: false, committed: false });
  await expect(deleteMdbx2TransferSources(native, source, [item], operationId, 'target', intent)).rejects.toThrow();
  expect(native.mutateObjects).not.toHaveBeenCalled();
});

it('stops when a legacy deletion is known but not committed or its lookup fails', async () => {
  const native = client(); native.resolveObjectOperation.mockResolvedValue({ known: true, committed: false, operationId });
  await expect(prepare(native)).rejects.toThrow('尚未确认');
  native.resolveObjectOperation.mockRejectedValue(new Error('offline'));
  await expect(prepare(native)).rejects.toThrow('offline'); expect(native.readWriteRevision).not.toHaveBeenCalled();
});

it('rejects damaged or future deletion data and binds even legacy receipts to the original request', async () => {
  for (const row of [{ version: 2 }, { version: 1, operationScope: 'ab'.repeat(32), writeRevision: { vaultId: 'source-vault' } },
    { version: 0, operationScope: 'ab'.repeat(32), vaultId: 'source-vault', receipt: { operationId, commitId: '' } }])
    expect(() => readMdbx2SourceDeletionIntent(row)).toThrow();
  const native = client(); native.resolveObjectOperation.mockResolvedValue({ known: true, committed: true, operationId, commitId: result.commitId });
  const { intent } = await prepare(native);
  await expect(assertMdbx2SourceDeletionScope(intent, source, [item], operationId, 'other-target', revision.vaultId)).rejects.toThrow();
});
