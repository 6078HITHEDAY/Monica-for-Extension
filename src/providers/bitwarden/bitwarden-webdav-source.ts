import { strFromU8 } from 'fflate';
import type { LoginItem, ProviderAccount, VaultItem, VaultState } from '../../core/model';
import { jsonScalarText, parseLosslessJson } from '../../core/lossless-json';
import { passwordGroupMembers } from '../../core/password-groups';
import { LOCAL_ATTACHMENT_MAX_BYTES, type LocalItemAttachment } from '../../core/local-transfer';
import { bytesToBase64 } from '../../security/encoding';
import type { MonicaWebDavProvider } from '../webdav/monica-webdav-provider';
import { listAndroidPortableAttachments, readAndroidPortableAttachment, vaultItemToAndroidRecord, type AndroidBackupDocument, type AndroidBackupRecord } from '../webdav/android-backup-codec';
import { parsePortablePasskeyPrivateKey } from '../../passkey/private-key-portability';
import { normalizeCredentialId } from '../../passkey/source-policy';
import { mdbx2TransferOperationScope as hash } from '../mdbx2/mdbx2-transfer-identity';
import { assertBitwardenPortableProjection, type BitwardenPortableSource } from './bitwarden-batch-resource';

/** One immutable archive per preview/execute state, rather than a whole-vault
 * download for every row and file. A later execution gets a fresh state/cache. */
export class BitwardenWebDavSources {
  private readonly snapshots = new WeakMap<VaultState, Map<string, Promise<Awaited<ReturnType<MonicaWebDavProvider['readTransferSnapshot']>>>>>();
  constructor(private readonly provider: Pick<MonicaWebDavProvider, 'readTransferSnapshot'>) {}

  async read(state: VaultState, account: ProviderAccount, item: VaultItem, preserveCategories: boolean, assertCurrent: () => Promise<void>): Promise<BitwardenPortableSource> {
    if (account.kind !== 'monica-webdav' || !account.enabled || item.providerRefs.length !== 1 || item.providerRefs[0].providerId !== account.id)
      throw new Error('WebDAV 来源身份不唯一。');
    await assertCurrent();
    const cache = this.snapshots.get(state) || new Map(); this.snapshots.set(state, cache);
    if (!cache.has(account.id)) cache.set(account.id, this.provider.readTransferSnapshot(account));
    const snapshot: Awaited<ReturnType<MonicaWebDavProvider['readTransferSnapshot']>> = await cache.get(account.id)!;
    await assertCurrent();
    const { document } = snapshot, ref = item.providerRefs[0];
    const matches = [...document.records.values()].filter(row => row.path === ref.remoteId && !row.container);
    const record = matches[0];
    if (matches.length !== 1 || !record || record.item.deletedAt || record.item.kind !== item.kind || record.item.kind === 'opaque'
      || !ref.revision || ref.revision !== record.item.updatedAt) throw new Error('WebDAV 原始项目或版本已变化，请先同步。');
    const portable = portableItem(item), native = portableItem(record.item);
    await assertBitwardenPortableProjection(portable, native); await assertBitwardenPortableProjection(native, portable);
    assertRawRepresented(record);
    if (item.kind === 'login') { assertProjectMembers(state, document, record, item); assertHistory(document, record); }
    if (preserveCategories && record.item.categoryId != null && !record.item.categoryName?.trim()) throw unsupported('categoryName');
    const files = await readFiles(document, record, item.id);
    await assertCurrent();
    return { item: portable, files, path: preserveCategories && record.item.categoryName ? [record.item.categoryName] : [],
      fingerprint: await hash({ file: snapshot.file, archiveSha256: snapshot.sha256, path: record.path }) };
  }
}

function portableItem(item: VaultItem): VaultItem {
  const result = structuredClone(item);
  // Only routing is replaced. Relationships still have to survive the target codec.
  for (const name of ['categoryId','categoryName','replicaGroupId','keepassDatabaseId','keepassGroupPath','keepassEntryUuid','keepassGroupUuid','mdbxDatabaseId','mdbxFolderId'] as const) delete result[name];
  result.providerRefs = []; if (result.sortOrder === 0) delete result.sortOrder;
  return result;
}
const routing = new Set(['id','categoryId','categoryName','replicaGroupId','replica_group_id','keepassDatabaseId','keepassGroupPath','keepassEntryUuid',
  'keepass_entry_uuid','keepassGroupUuid','keepass_group_uuid','mdbxDatabaseId','mdbx_database_id','mdbxFolderId','mdbx_folder_id','passkeyMode']);
function assertRawRepresented(record: AndroidBackupRecord): void {
  const projected = vaultItemToAndroidRecord(record.item, undefined, undefined, { allowPortablePasskeys: true });
  if (!projected) throw unsupported('type');
  for (const [name, value] of Object.entries(record.raw)) {
    if (routing.has(name) || canonical(value) === canonical(projected[name])) continue;
    if (value == null && projected[name] === '') continue;
    if (name === 'privateKeyAlias' && typeof value === 'string' && samePrivateKey(value, String(projected[name]))) continue;
    if (name === 'credentialId' && typeof value === 'string' && normalizeCredentialId(value) && normalizeCredentialId(value) === normalizeCredentialId(String(projected[name]))) continue;
    if (['itemData','imagePaths','wifiMetadata','sshKeyData','passkeyBindings'].includes(name)) {
      try { if (canonical(typeof value === 'string' ? parseLosslessJson(value) : value)
        === canonical(typeof projected[name] === 'string' ? parseLosslessJson(projected[name] as string) : projected[name])) continue; } catch { /* Name-only failure below. */ }
    }
    throw unsupported(name);
  }
}

function assertProjectMembers(state: VaultState, document: AndroidBackupDocument, record: AndroidBackupRecord, item: LoginItem): void {
  if (!item.passwordGroupId || record.item.kind !== 'login') return;
  if ([...document.records.values()].some(row => row.item.kind === 'opaque' && row.raw.passwordGroupId === item.passwordGroupId)) throw unsupported('passwordGroupId');
  const actual = passwordGroupMembers(record.item, document.items), expected = passwordGroupMembers(item, state.items);
  const ids = expected.map(row => row.providerRefs.length === 1 ? row.providerRefs[0].remoteId : undefined);
  if (actual.length !== expected.length || ids.includes(undefined) || new Set(ids).size !== expected.length
    || actual.some(row => !ids.includes(row.providerRefs[0].remoteId))) throw new Error('WebDAV 密码项目成员不完整，请先同步。');
}

function assertHistory(document: AndroidBackupDocument, record: AndroidBackupRecord): void {
  if (record.item.kind !== 'login' || record.item.passwordHistoryIncomplete) throw unsupported('password_history');
  const paths = Object.keys(document.entries).filter(path => path.toLowerCase() === 'password_history.json');
  if (paths.length > 1) throw unsupported('password_history');
  if ((document.passwordHistoryRaw || []).some(row => !object(row) || owner(row.entryId) === undefined)) throw unsupported('password_history owner');
  const owned = (document.passwordHistoryRaw || []).filter(row => object(row) && owner(row.entryId) === owner(record.raw.id));
  if (owned.length && [...document.records.values()].filter(row => row.item.kind === 'login' && owner(row.raw.id) === owner(record.raw.id)).length !== 1)
    throw unsupported('password_history owner');
  if (owned.length !== (record.item.passwordHistory || []).length) throw unsupported('password_history');
  for (let index = 0; index < owned.length; index++) {
    const raw = owned[index] as Record<string, unknown>, value = record.item.passwordHistory![index];
    if (Object.keys(raw).some(key => !['id','entryId','password','lastUsedAt'].includes(key)) || raw.password !== value.password
      || date(raw.lastUsedAt) !== Date.parse(value.lastUsedAt)) throw unsupported('password_history');
  }
}

async function readFiles(document: AndroidBackupDocument, record: AndroidBackupRecord, itemId: string): Promise<LocalItemAttachment[]> {
  const bytes = document.entries['attachments_portable/attachments_portable.json'];
  if (!bytes) return [];
  if (document.portableAttachmentsAllowed === false) throw unsupported('unencrypted attachments');
  let raw: unknown; try { raw = parseLosslessJson(strFromU8(bytes)); } catch { throw unsupported('attachments'); }
  const entries = Array.isArray(raw) ? raw : object(raw) && [1,2].includes(raw.version as number) && Array.isArray(raw.entries) ? raw.entries : undefined;
  if (!entries) throw unsupported('attachments');
  if (entries.some(row => !object(row) || (owner(row.parentPasswordId) === undefined) === (owner(row.parentSecureItemId) === undefined))) throw unsupported('attachment owner');
  const ownerField = record.item.kind === 'login' ? 'parentPasswordId' : 'parentSecureItemId';
  const rawId = owner(record.raw.id);
  const owned = entries.filter(row => object(row) && rawId !== undefined && owner(row[ownerField]) === rawId);
  const catalog = listAndroidPortableAttachments(document, record.item);
  if (catalog.length !== owned.length || catalog.length > 512 || new Set(catalog.map(row => row.attachmentId)).size !== catalog.length) throw unsupported('attachments');
  if (owned.length && [...document.records.values()].filter(row => (row.item.kind === 'login') === (record.item.kind === 'login') && owner(row.raw.id) === rawId).length !== 1)
    throw unsupported('attachment owner');
  const files: LocalItemAttachment[] = []; let total = 0;
  for (let index = 0; index < catalog.length; index++) {
    const attachment = catalog[index], raw = owned[index] as Record<string, unknown>;
    if (Object.keys(raw).some(key => !['attachmentId','parentPasswordId','parentSecureItemId','fileName','mimeType','sizeBytes','sha256Hex','payloadPath','createdAt','updatedAt'].includes(key))
      || raw.attachmentId !== undefined && raw.attachmentId !== attachment.attachmentId
      || raw.mimeType != null && typeof raw.mimeType !== 'string'
      || ['createdAt', 'updatedAt'].some(key => raw[key] != null && (typeof raw[key] !== 'number' || !Number.isSafeInteger(raw[key])))) throw unsupported('attachment fields');
    total += attachment.sizeBytes; if (total > LOCAL_ATTACHMENT_MAX_BYTES) throw new Error('WebDAV 来源附件合计超过 16 MiB。');
    const data = await readAndroidPortableAttachment(document, attachment);
    try { files.push({ itemId, attachmentId: attachment.attachmentId, fileName: attachment.fileName, mediaType: attachment.mimeType,
      sizeBytes: data.length, sha256: attachment.sha256Hex, dataBase64: bytesToBase64(data) }); } finally { data.fill(0); }
  }
  return files;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function owner(value: unknown): string | undefined { const text = jsonScalarText(value); return /^-?\d+$/.test(text) ? BigInt(text).toString() : undefined; }
function date(value: unknown): number { return typeof value === 'number' ? value : typeof value === 'string' ? /^\d+$/.test(value) ? Number(value) : Date.parse(value) : NaN; }
function samePrivateKey(a: string, b: string) { const key = parsePortablePasskeyPrivateKey(a)?.pkcs8Base64; return !!key && key === parsePortablePasskeyPrivateKey(b)?.pkcs8Base64; }
function canonical(value: unknown): string | undefined { const json = JSON as typeof JSON & { isRawJSON?: (row: unknown) => boolean };
  return JSON.stringify(value, (_key, row) => object(row) && !json.isRawJSON?.(row) ? Object.fromEntries(Object.entries(row).sort(([a],[b]) => a.localeCompare(b))) : row); }
function unsupported(field: string) { return new Error(`WebDAV 原生 ${field} 尚不能完整转入 Bitwarden，已保留来源。`); }
