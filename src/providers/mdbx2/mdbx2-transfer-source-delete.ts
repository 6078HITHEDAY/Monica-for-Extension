import type { ProviderAccount, VaultItem } from '../../core/model';
import { readMdbx2SourceDeletionIntent, type Mdbx2SourceDeletionIntent } from '../../core/mdbx2-source-deletion';
import type { Mdbx2NativeClient } from './native-client';
import { MDBX2_MAX_OBJECT_BATCH_MUTATIONS, type Mdbx2ObjectBatchResult, type Mdbx2ObjectMutationInput } from './native-contract';
import { assertMdbx2TransferOperationId, mdbx2TransferOperationScope as hash } from './mdbx2-transfer-identity';
import { readMdbx2TransferBinding } from './mdbx2-transfer-verification';

type DeleteClient = Pick<Mdbx2NativeClient, 'mutateObjects' | 'resolveObjectOperation' | 'vaultStatus'>;
type PrepareClient = Pick<Mdbx2NativeClient, 'resolveObjectOperation' | 'vaultStatus' | 'readWriteRevision'>;
const invalid = () => new Error('MDBX 来源删除恢复记录或数据库身份不一致，已保留来源和副本。');

function deletion(source: ProviderAccount, items: readonly VaultItem[], operationId: string, targetProviderId: string) {
  assertMdbx2TransferOperationId(operationId);
  const handle = source.config.vaultHandle;
  if (source.kind !== 'mdbx2' || !source.enabled || typeof handle !== 'string' || !handle || source.id === targetProviderId || !targetProviderId) throw invalid();
  if (!items.length || items.length > MDBX2_MAX_OBJECT_BATCH_MUTATIONS) throw new Error('MDBX2 Object 批量数量无效。');
  const mutations: Mdbx2ObjectMutationInput[] = items.map((item): Mdbx2ObjectMutationInput => {
    const references = item.providerRefs.filter(ref => ref.providerId !== 'local'), ref = references[0];
    if (references.length !== 1 || ref.providerId !== source.id || !ref.remoteId || !ref.revision || item.deletedAt) throw invalid();
    return { kind: 'delete', logicalObjectId: `native:${ref.remoteId}`, expectedHeadCommitId: ref.revision };
  }).sort((left, right) => left.logicalObjectId.localeCompare(right.logicalObjectId));
  if (new Set(mutations.map(item => item.logicalObjectId)).size !== mutations.length) throw invalid();
  return { handle, mutations, identity: { version: 1, purpose: 'source-group-delete', operationId, sourceProviderId: source.id, targetProviderId, mutations } };
}

export async function assertMdbx2SourceDeletionScope(intent: Mdbx2SourceDeletionIntent, source: ProviderAccount,
  items: readonly VaultItem[], operationId: string, targetProviderId: string, vaultId: string): Promise<void> {
  readMdbx2SourceDeletionIntent(intent);
  const { identity } = deletion(source, items, operationId, targetProviderId);
  if ((intent.version === 1 ? intent.writeRevision.vaultId : intent.vaultId) !== vaultId
    || intent.operationScope !== await hash(intent.version === 1 ? { ...identity, version: 2, writeRevision: intent.writeRevision } : identity)) throw invalid();
}

/** Read-only preparation. Persist its result before calling delete. An existing
 * legacy commit is recovered without trying to read already-deleted sources. */
export async function prepareMdbx2TransferSourceDeletion(client: PrepareClient, source: ProviderAccount,
  items: readonly VaultItem[], operationId: string, targetProviderId: string, vaultId: string,
  verifySources: () => Promise<void>): Promise<Mdbx2SourceDeletionIntent> {
  const { handle, identity } = deletion(source, items, operationId, targetProviderId);
  if ((await readMdbx2TransferBinding(client, source)).vaultId !== vaultId) throw invalid();
  const legacyScope = await hash(identity), legacy = await client.resolveObjectOperation(handle, legacyScope);
  if (legacy.known) {
    if (!legacy.committed) throw new Error('旧移动删除结果尚未确认，请稍后恢复；未发送新删除。');
    return readMdbx2SourceDeletionIntent({ version: 0, vaultId, operationScope: legacyScope,
      receipt: { operationId: legacy.operationId, commitId: legacy.commitId } });
  }
  const revision = await client.readWriteRevision(handle);
  const intent = readMdbx2SourceDeletionIntent({ version: 1, operationScope: await hash({ ...identity, version: 2, writeRevision: revision }), writeRevision: revision });
  if (revision.vaultId !== vaultId) throw invalid();
  await verifySources();
  const after = await client.readWriteRevision(handle);
  if (after.vaultId !== revision.vaultId || after.revisionSha256 !== revision.revisionSha256)
    throw new Error('核验期间 MDBX 来源提交已变化，已保留来源和副本。');
  if ((await readMdbx2TransferBinding(client, source)).vaultId !== vaultId) throw invalid();
  return intent;
}

/** Execute only the durably saved intent. Never substitute a newer revision on
 * conflict: it would authorize deleting content that the target never received. */
export async function deleteMdbx2TransferSources(client: DeleteClient, source: ProviderAccount,
  items: readonly VaultItem[], operationId: string, targetProviderId: string, saved: Mdbx2SourceDeletionIntent): Promise<Mdbx2ObjectBatchResult> {
  const intent = readMdbx2SourceDeletionIntent(saved), { handle, mutations } = deletion(source, items, operationId, targetProviderId);
  const binding = await readMdbx2TransferBinding(client, source);
  await assertMdbx2SourceDeletionScope(intent, source, items, operationId, targetProviderId, binding.vaultId);
  let receipt = intent.version === 0 ? intent.receipt : undefined;
  if (receipt) {
    const current = await client.resolveObjectOperation(handle, intent.operationScope);
    if (!current.known || !current.committed || current.operationId !== receipt.operationId || current.commitId !== receipt.commitId) throw invalid();
  }
  const mutate = () => client.mutateObjects(handle, intent.operationScope, mutations, 120_000, intent.version === 1 ? intent.writeRevision : undefined);
  let result: Mdbx2ObjectBatchResult;
  try { result = await mutate(); }
  catch (error) {
    const recovered = await client.resolveObjectOperation(handle, intent.operationScope).catch(() => undefined);
    if (!recovered?.known || !recovered.committed) throw error;
    if (receipt && (receipt.operationId !== recovered.operationId || receipt.commitId !== recovered.commitId)) throw invalid();
    receipt = recovered;
    result = await mutate();
  }
  if (receipt && (result.operationId !== receipt.operationId || result.commitId !== receipt.commitId)
    || !result.operationId || !result.commitId || result.items.length !== mutations.length || result.items.some((item, index) =>
      item.kind !== 'delete' || item.logicalObjectId !== mutations[index].logicalObjectId || `native:${item.objectId}` !== item.logicalObjectId))
    throw new Error('来源 MDBX2 删除响应与项目不一致。');
  return result;
}
