import type { ProviderAccount, VaultItem, VaultState } from '../../core/model';
import { parseLosslessJson } from '../../core/lossless-json';
import { readLocalTransferResource } from '../attachments/local-transfer-resource';
import { decodeMdbx2Object, encodeMdbx2Object } from '../mdbx2/mdbx2-item-codec';
import { sourceCategoryPath } from '../mdbx2/mdbx2-batch-transfer';
import { mdbx2TransferOperationScope as hash } from '../mdbx2/mdbx2-transfer-identity';
import { readMdbx2TransferBinding, verifyMdbx2TransferBinding } from '../mdbx2/mdbx2-transfer-verification';
import type { Mdbx2TransferAttachmentService } from '../mdbx2/mdbx2-transfer-attachments';
import type { Mdbx2CollectionSummary, Mdbx2ObjectRecord, Mdbx2VaultRuntimeStatus } from '../mdbx2/native-contract';
import { parsePortablePasskeyPrivateKey } from '../../passkey/private-key-portability';
import { assertBitwardenPortableProjection, type BitwardenPortableSource } from './bitwarden-batch-resource';
import { MdbxBitwardenMembers, type MdbxBitwardenMembershipClient } from './bitwarden-mdbx-members';

interface Dependencies {
  native: MdbxBitwardenMembershipClient & {
    vaultStatus(handle: string): Promise<Mdbx2VaultRuntimeStatus>;
    revealObject(handle: string, id: string): Promise<Mdbx2ObjectRecord>;
  };
  members: MdbxBitwardenMembers;
  collections(account: ProviderAccount): Promise<Mdbx2CollectionSummary[]>;
  files: Pick<Mdbx2TransferAttachmentService, 'listSourceAttachments' | 'readSourceAttachment'>;
  assertCurrent(): Promise<void>;
}

/** Read native evidence, never treat a stale vault-index projection as an export. */
export async function readMdbxBitwardenSource(state: VaultState, account: ProviderAccount, item: VaultItem,
  preserveCategories: boolean, dependencies: Dependencies): Promise<BitwardenPortableSource> {
  if (account.kind !== 'mdbx2' || !account.enabled || item.providerRefs.length !== 1 || item.providerRefs[0].providerId !== account.id)
    throw new Error('MDBX 来源身份不唯一。');
  const reference = item.providerRefs[0];
  if (!reference.remoteId || !reference.revision || !reference.remoteFolderId) throw new Error('MDBX 来源身份或版本缺失，请先同步。');
  await dependencies.assertCurrent();
  const binding = await readMdbx2TransferBinding(dependencies.native, account);
  const revision = await dependencies.native.readWriteRevision(binding.vaultHandle);
  if (revision.vaultId !== binding.vaultId || !revision.revisionSha256) throw new Error('MDBX 来源版本无法确认。');
  const read = async () => {
    const record = await dependencies.native.revealObject(binding.vaultHandle, reference.remoteId!);
    if (record.objectId !== reference.remoteId || record.collectionId !== reference.remoteFolderId || record.deleted
      || record.headCommitId !== reference.revision) throw new Error('MDBX 原生来源已变化，请先同步再预览。');
    return record;
  };
  const record = await read(), decoded = decodeMdbx2Object(record, { headCommitId: reference.revision, updatedAt: item.updatedAt }, account.id);
  if (!decoded.item || decoded.item.kind === 'opaque' || decoded.item.kind !== item.kind) throw new Error('MDBX 来源类型或字段版本尚不能完整转换。');
  const portable = portableMdbxItem(item);
  await assertBitwardenPortableProjection(portable, portableMdbxItem(decoded.item));
  assertMdbxPayloadRepresented(record, decoded.item, decoded.payload);
  const collections = await dependencies.collections(account);
  if (item.kind === 'login') await dependencies.members.verify(state, account, item, dependencies.native, collections, revision);
  const path = sourceCategoryPath(item, { collections });
  if (preserveCategories && !path.complete) throw new Error('MDBX 来源文件夹层级不完整，请先同步或取消保留分类。');
  const files = (await readLocalTransferResource(state, item, { files: dependencies.files, prepare: async () => collections })).attachments;
  if (await hash(record) !== await hash(await read())) throw new Error('读取附件期间 MDBX 原生来源已变化。');
  if (preserveCategories && await hash(collections) !== await hash(await dependencies.collections(account))) throw new Error('读取期间 MDBX 文件夹层级已变化。');
  const after = await dependencies.native.readWriteRevision(binding.vaultHandle);
  if (after.vaultId !== revision.vaultId || after.revisionSha256 !== revision.revisionSha256) throw new Error('读取期间 MDBX 来源版本已变化。');
  await verifyMdbx2TransferBinding(dependencies.native, account, binding); await dependencies.assertCurrent();
  return { item: portable, files, path: preserveCategories ? path.segments : [], fingerprint: await hash({ binding, record }) };
}

function portableMdbxItem(item: VaultItem): VaultItem {
  const result = structuredClone(item);
  // Native routing belongs to the source vault. New target identities/folders
  // are supplied by the batch journal; credential and relationship IDs remain.
  for (const key of ['mdbxDatabaseId','mdbxFolderId','replicaGroupId','categoryId','categoryName'] as const) delete result[key];
  result.providerRefs = [];
  if (result.sortOrder === 0) delete result.sortOrder;
  return result;
}

const nativeRouting = new Set(['monica_entry_id','room_id','mdbx_folder_id','category_id','bitwarden_mode','keepass_mode',
  'bitwarden_compatible','keepass_compatible','passkey_mode']);
const aliases: Record<string, string> = { password: 'password_plain', appPackageName: 'app_package_name', appName: 'app_name',
  customIconType: 'custom_icon_type', customIconValue: 'custom_icon_value', customIconUpdatedAt: 'custom_icon_updated_at',
  ssoProvider: 'sso_provider', ssoRefEntryId: 'sso_ref_entry_id', wifiMetadata: 'wifi_metadata' };
const jsonFields = new Set(['wifi_metadata','ssh_key_data','passkey_bindings','item_data']);

/** Reconstruct without the original payload: the codec's normal merge would
 * retain unknown data and conceal a loss. Every native content field must be
 * accounted for before the separate Bitwarden round trip can accept it. */
export function assertMdbxPayloadRepresented(record: Mdbx2ObjectRecord, item: VaultItem, payload: Record<string, unknown>): void {
  const encoded = encodeMdbx2Object(item);
  if (!encoded || encoded.objectTypeId !== record.objectTypeId || record.payloadSchemaVersion !== 1)
    throw new Error('MDBX 原生类型尚不能完整转换。');
  const projection = parseLosslessJson(encoded.payloadJson) as Record<string, unknown>;
  for (const [name, value] of Object.entries(payload)) {
    if (nativeRouting.has(name)) continue;
    const mapped = aliases[name] || name, actual = projection[mapped];
    if (canonical(value) === canonical(actual)) continue;
    if (name === 'monica_password_encoding' && (value == null || value === '')) continue;
    if (mapped === 'private_key_alias' && parsePortablePasskeyPrivateKey(value)?.pkcs8Base64
      && parsePortablePasskeyPrivateKey(value)?.pkcs8Base64 === parsePortablePasskeyPrivateKey(actual)?.pkcs8Base64) continue;
    if (mapped === 'transports' && typeof value === 'string' && typeof actual === 'string') {
      const normalize = (text: string) => text.split(',').map(part => part.trim()).filter(Boolean);
      const expected = normalize(value), received = normalize(actual);
      if (canonical(expected.length ? expected : ['internal']) === canonical(received.length ? received : ['internal'])) continue;
    }
    if (Object.prototype.hasOwnProperty.call(projection, mapped) && value == null && (actual === '' || actual === undefined)) continue;
    if (jsonFields.has(mapped)) {
      try { if (canonical(typeof value === 'string' ? parseLosslessJson(value) : value)
        === canonical(typeof actual === 'string' ? parseLosslessJson(actual) : actual)) continue; } catch { /* Name-only error below. */ }
    }
    throw new Error(`MDBX 原生 ${name} 字段尚不能完整转入 Bitwarden，已保留来源。`);
  }
  if (record.apiTokenMetadataJson !== undefined || record.apiTokenFavorite !== undefined)
    throw new Error('MDBX API 令牌原生标签尚不能完整转入 Bitwarden。');
}
function canonical(value: unknown) { const json = JSON as typeof JSON & { isRawJSON?: (row: unknown) => boolean };
  return JSON.stringify(value, (_key, row) => row && typeof row === 'object' && !Array.isArray(row) && !json.isRawJSON?.(row)
    ? Object.fromEntries(Object.entries(row).sort(([a],[b]) => a.localeCompare(b))) : row); }
