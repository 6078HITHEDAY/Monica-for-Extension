import * as kdbxweb from 'kdbxweb';
import type { ProviderAccount, VaultItem } from '../../core/model';
import { passwordGroupKey } from '../../core/password-groups';
import { rebaseProjectCredentialFields, PROJECT_CREDENTIAL_FIELD } from '../../core/project-credentials';
import { resolveSsoAccount, ssoAccountCandidates, ssoLogicalId } from '../../core/sso-links';
import { parseLosslessJson } from '../../core/lossless-json';
import { validateLocalAttachments, LOCAL_ATTACHMENT_MAX_BYTES, type LocalItemAttachment } from '../../core/local-transfer';
import { mdbx2TransferOperationScope as hash, mdbx2TransferUuid as uuid, assertMdbx2TransferOperationId } from '../mdbx2/mdbx2-transfer-identity';
import { base64ToBytes, bytesToBase64 } from '../../security/encoding';
import { inspectPasskeyKey } from '../../passkey/capability';
import { assertPasskeyCounterNotRegressed, preserveLocalPasskeyUsage } from '../../passkey/ownership-policy';
import { normalizeCredentialId, passkeyAvailability } from '../../passkey/source-policy';
import { readKeePassPasskeyFields } from './keepass-passkey-codec';
import { keePassFieldText } from './keepass-login-codec';
import { readKeePassEntries } from './keepass-vault';
import { createKeePassEntry, prepareKeePassEntryWrite } from './keepass-writer';
import { isInRecycleBin, requireKeePassGroup } from './keepass-groups';
import { normalizeUuid } from './keepass-field-reference';

/** Authenticated source readback only; never accept these secrets from manager messages. */
export interface KeePassTransferRow {
  source: VaultItem;
  /** Complete native content checkpoint, including unknown fields and history. */
  nativeContentSha256?: string;
  /** Scoped native folder identity. Names alone do not merge folders from different sources. */
  folder?: { identities: string[]; segments: string[] };
  /** Required for foreign sources, including an explicitly empty catalog. Native files are cloned directly. */
  attachments?: LocalItemAttachment[];
}

export interface KeePassTransferDraft {
  operationId: string;
  createdAt: string;
  action: 'copy' | 'move';
  targetGroupUuid?: string;
  rows: KeePassTransferRow[];
}

export interface KeePassTransferNativeSource {
  database: kdbxweb.Kdbx;
  entry: kdbxweb.KdbxEntry;
  /** Recheck session identity and source content after asynchronous preparation. */
  assertCurrent(): void;
}

export interface KeePassTransferFileResult {
  inputSha256: string;
  outputSha256: string;
  bytes: Uint8Array;
  items: VaultItem[];
  entries: Array<{ sourceItemId: string; targetItemId: string; entryUuid: string }>;
  /** Ephemeral guard; never serialized into the durable receipt. */
  assertCurrent(): void;
}

export async function keePassTransferRequestHash(account: ProviderAccount, request: {
  expectedWorkingSha256: string; draft: KeePassTransferDraft;
}): Promise<string> {
  const keys = ['sourceMode', 'databaseId', 'webDavBaseUrl', 'webDavUsername', 'remotePath', 'oneDriveDriveId', 'oneDriveItemId', 'localFileSourceSha256'];
  return hash({ request, source: { id: account.id, kind: account.kind,
    config: Object.fromEntries(keys.map(key => [key, account.config[key]])),
    oneDriveConnectionId: (account.config.oneDriveConnection as { id?: unknown } | undefined)?.id } });
}

/** Compare persisted content, independent of randomized KDBX encryption headers.
 * Used only for explicit batch preparation, never on the autofill hot path. */
export async function keePassTransferContentHash(database: kdbxweb.Kdbx): Promise<string> {
  const storesPreviousParent = database.versionIsAtLeast(4, 1);
  const encode = (value: unknown): unknown => {
    if (value instanceof kdbxweb.ProtectedValue) {
      const bytes = value.getBinary();
      try { return { protectedBytes: bytesToBase64(bytes) }; } finally { bytes.fill(0); }
    }
    if (value instanceof kdbxweb.KdbxUuid) return value.toString();
    if (value instanceof Date) return new Date(Math.floor(value.getTime() / 1000) * 1000).toISOString();
    if (value instanceof ArrayBuffer) return { bytes: bytesToBase64(new Uint8Array(value)) };
    if (value instanceof Uint8Array) return { bytes: bytesToBase64(value) };
    if (value instanceof Map) return [...value].map(([key, item]) => [key, encode(item)]);
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === 'object') {
      const native = value instanceof kdbxweb.KdbxGroup || value instanceof kdbxweb.KdbxEntry;
      const fields = value instanceof kdbxweb.KdbxGroup
        ? { ...value, notes: value.notes || '', defaultAutoTypeSeq: value.defaultAutoTypeSeq || '' }
        // Newly created entries leave these unset; KDBX reload reads empty XML
        // nodes as empty strings. Neither form sets a color or URL override.
        : value instanceof kdbxweb.KdbxEntry
          ? { ...value, fgColor: value.fgColor || '', bgColor: value.bgColor || '', overrideUrl: value.overrideUrl || '' } : value;
      return Object.fromEntries(Object.entries(fields)
        // kdbxweb sets this on moves even when the file format cannot store it.
        .filter(([key]) => !['parentGroup', '_editState', 'headerHash'].includes(key)
          && !(native && key === 'previousParentGroup' && !storesPreviousParent))
        .map(([key, item]) => [key, encode(item)]));
    }
    return value;
  };
  return hash({ groups: encode(database.groups), meta: encode(database.meta), deleted: encode(database.deletedObjects),
    version: [database.header.versionMajor, database.header.versionMinor], cipher: database.header.dataCipherUuid?.toString() });
}

/** Mutates a disposable database only. The caller owns opening, exact-byte persistence and adoption. */
export async function applyKeePassTransferFile(database: kdbxweb.Kdbx, account: ProviderAccount, input: KeePassTransferDraft,
  nativeSources: ReadonlyMap<string, KeePassTransferNativeSource>): Promise<Omit<KeePassTransferFileResult, 'inputSha256' | 'outputSha256' | 'bytes' | 'assertCurrent'>> {
  const draft = structuredClone(input);
  assertMdbx2TransferOperationId(draft.operationId);
  if (!Number.isFinite(Date.parse(draft.createdAt)) || !['copy', 'move'].includes(draft.action)
    || !Array.isArray(draft.rows) || !draft.rows.length || draft.rows.length > 200
    || new Set(draft.rows.map(row => row.source.id)).size !== draft.rows.length
    || draft.rows.some(row => !row.source.id || row.source.deletedAt)) throw new Error('KeePass 整组传输请求无效。');
  const current = readKeePassEntries(database, Number(account.config.databaseId), account.id);
  const parent = draft.targetGroupUuid ? requireKeePassGroup(database, draft.targetGroupUuid) : database.getDefaultGroup();
  if (isInRecycleBin(database, parent)) throw new Error('不能把传输目标放在回收站。');
  const credentials = new Set([...current.entriesByUuid.values()].map(entry =>
    normalizeCredentialId(readKeePassPasskeyFields(entry.fields)?.credentialId || '')).filter(Boolean));
  const targets = new Map<string, VaultItem>(), ids = new Map<string, kdbxweb.KdbxUuid>(), groups = new Map<string, string>();
  let fileBytes = 0;
  for (const row of draft.rows) {
    const source = row.source, native = nativeSources.get(source.id);
    native?.assertCurrent();
    const sameFile = source.providerRefs.length === 1 && source.providerRefs[0].providerId === account.id;
    if (source.keepassEntryUuid && !native) throw new Error('KeePass 原生来源不可用，不能用投影替代完整条目。');
    if (draft.action === 'move' && (!sameFile || !native)) throw new Error('跨库移动需要持久来源删除，请先使用复制。');
    if (row.folder && (!row.folder.segments.length || row.folder.segments.length > 128 || !Array.isArray(row.folder.identities)
      || row.folder.identities.length !== row.folder.segments.length || row.folder.identities.some(id => !id || id.length > 1024)
      || row.folder.segments.some(part => !part.trim() || part.length > 1024 || /[\u0000-\u001f]/.test(part)))) throw new Error('来源文件夹路径无效。');
    if (!native && !row.attachments) throw new Error('来源附件尚未完整读取。');
    if (row.attachments) {
      await validateLocalAttachments(row.attachments, source.id);
      if (new Set(row.attachments.map(file => file.fileName)).size !== row.attachments.length
        || row.attachments.some(file => /[\u0000-\u001f]/.test(file.fileName))) throw new Error('KeePass 附件名称重复或包含不支持的字符，无法无损写入。');
      fileBytes += row.attachments.reduce((sum, file) => sum + file.sizeBytes, 0);
    }
    if (native) fileBytes += nativeAttachmentBytes(native.entry);
    if (fileBytes > LOCAL_ATTACHMENT_MAX_BYTES) throw new Error('整组传输附件超过 16 MiB 上限。');
    if (draft.action === 'copy') {
      // The current Android KDBX contract has no carrier for these Room links.
      // Refuse to silently drop them; the generic graph adapter must supply one.
      if (source.boundNoteEntryId || source.boundNoteId != null || source.kind === 'login' && source.boundTotpItemId
        || (source.kind === 'passkey' || source.kind === 'totp') && source.boundPasswordId != null)
        throw new Error('此项目的笔记或验证码关联尚不能完整写入 KeePass，请保留来源。');
      const key = source.kind === 'passkey' ? source : native && readKeePassPasskeyFields(native.entry.fields);
      if (key) {
        if (source.kind === 'passkey') {
          assertPasskeyCounterNotRegressed(source);
          if (passkeyAvailability(source) !== 'ready') throw new Error('此 Passkey 不可在浏览器完整使用，原始记录已保留。');
        }
        if (await inspectPasskeyKey(key.privateKeyPkcs8, key.algorithm) !== 'usable') throw new Error('Passkey 私钥无法完整读取。');
        const credential = normalizeCredentialId(key.credentialId);
        if (!credential || credentials.has(credential)) throw new Error('目标 KeePass 已存在相同 Passkey 凭据，不能覆盖或重复复制。');
        credentials.add(credential);
      }
    }
    const id = draft.action === 'move' ? new kdbxweb.KdbxUuid(source.keepassEntryUuid!)
      : nativeUuid(await uuid(draft.operationId, `keepass-entry:${account.id}:${source.id}`));
    if (draft.action === 'copy' && current.entriesByUuid.has(id.toString())) throw new Error('目标条目身份已存在，请恢复原传输操作。');
    ids.set(source.id, id);
    const next = structuredClone(source);
    if (draft.action === 'copy') {
      next.id = `keepass:${account.id}:${id.toString()}`;
      delete next.replicaGroupId;
      delete next.mdbxDatabaseId; delete next.mdbxFolderId; delete next.categoryId; delete next.categoryName;
      next.createdAt = draft.createdAt;
      if (next.kind === 'login') {
        delete next.bitwardenCipherId; delete next.bitwardenCustomFieldsVersion; delete next.bitwardenSshKeyMode;
        if (next.passwordGroupId) {
          const key = passwordGroupKey(source as typeof next);
          if (!groups.has(key)) groups.set(key, await uuid(draft.operationId, `keepass-project:${key}`));
          next.passwordGroupId = groups.get(key)!;
          next.customFields = rebaseProjectCredentialFields(next.customFields, next.passwordGroupId);
        }
      }
    }
    next.updatedAt = draft.createdAt; next.keepassDatabaseId = Number(account.config.databaseId);
    next.keepassEntryUuid = id.toString(); next.providerRefs = [{ providerId: account.id, remoteId: id.toString() }];
    delete next.keepassGroupUuid; delete next.keepassGroupPath;
    targets.set(source.id, next);
  }
  if (draft.action === 'copy') for (const row of draft.rows) {
    if (row.source.kind !== 'login' || (!row.source.ssoRefLogicalId && row.source.ssoRefEntryId == null)) continue;
    const source = resolveSsoAccount(row.source, draft.rows.map(row => row.source));
    if (!source || !ssoAccountCandidates(row.source, draft.rows.map(row => row.source)).some(item => item.id === source.id))
      throw new Error('SSO 关联项目不完整或形成循环，未写入目标文件。');
    const next = targets.get(row.source.id)!;
    if (next.kind === 'login') { next.ssoRefLogicalId = ssoLogicalId(targets.get(source.id)! as typeof next); delete next.ssoRefEntryId; }
  }
  // Check all portable patches before any mutation of the disposable file.
  const writes = new Map(draft.rows.filter(row => !nativeSources.has(row.source.id)).map(row =>
    [row.source.id, prepareKeePassEntryWrite(targets.get(row.source.id)!)]));
  const destinationFolders = new Map<string, kdbxweb.KdbxGroup>();
  const existingGroupIds = new Set([...database.getDefaultGroup().allGroups()].map(group => group.uuid.toString()));
  for (const row of draft.rows) {
    const source = row.source, native = nativeSources.get(source.id), next = targets.get(source.id)!;
    let group = parent;
    if (row.folder) for (let n = 0; n < row.folder.segments.length; n++) {
      const scope = JSON.stringify([source.providerRefs.map(ref => ref.providerId), row.folder.identities.slice(0, n + 1)]);
      let destination = destinationFolders.get(scope);
      if (!destination) {
        const folderId = nativeUuid(await uuid(draft.operationId, `keepass-folder:${scope}`));
        if (existingGroupIds.has(folderId.toString())) throw new Error('目标文件夹身份已存在，请恢复原传输操作。');
        destination = database.createGroup(group, row.folder.segments[n]);
        destination.uuid = folderId; existingGroupIds.add(folderId.toString());
        destinationFolders.set(scope, destination);
      }
      group = destination;
    }
    let entry: kdbxweb.KdbxEntry;
    if (draft.action === 'move') {
      entry = current.entriesByUuid.get(source.keepassEntryUuid!)!;
      if (!entry || !entry.parentGroup || isInRecycleBin(database, entry.parentGroup)) throw new Error('待移动条目已变化。');
      database.move(entry, group);
    } else if (native) {
      // Import preserves raw fields, history and binaries. kdbxweb omits some
      // metadata in copyFrom, so restore those fields explicitly below.
      entry = importNativeEntry(database, native, group);
      entry.uuid = ids.get(source.id)!;
      const originalRows = [native.entry, ...native.entry.history];
      [entry, ...entry.history].forEach((copied, index) => {
        copied.uuid = entry.uuid; copied.customData = cloneCustomData(originalRows[index].customData);
        copied.qualityCheck = originalRows[index].qualityCheck;
        copied.previousParentGroup = undefined;
        for (const [name, value] of copied.fields) {
          const raw = keePassFieldText(value);
          const changed = raw.replace(/\{REF:([A-Za-z])@([A-Za-z]):([^}]+)\}/gi, (token, field: string, search: string, reference: string) => {
            if (search.toUpperCase() !== 'I' || !'TUPANIO'.includes(field.toUpperCase()))
              throw new Error('KeePass 名称字段引用需要先明确关联身份，不能生成可能指向来源的副本。');
            const matches = draft.rows.filter(row => row.source.providerRefs.length === 1 && row.source.providerRefs[0].providerId === source.providerRefs[0].providerId
              && row.source.keepassEntryUuid && normalizeUuid(row.source.keepassEntryUuid) === normalizeUuid(reference));
            if (matches.length === 1) return `{REF:${field.toUpperCase()}@I:${normalizeUuid(ids.get(matches[0].source.id)!.toString()).toUpperCase()}}`;
            if (source.providerRefs[0].providerId === account.id && matches.length === 0) return token;
            throw new Error('KeePass 字段引用的关联条目未完整选择，不能跨库复制。');
          });
          if (raw !== changed) copied.fields.set(name, value instanceof kdbxweb.ProtectedValue ? kdbxweb.ProtectedValue.fromString(changed) : changed);
        }
        for (const name of ['MonicaLocalId', 'MonicaSecureItemId', 'MonicaSsoRefEntryId']) copied.fields.delete(name);
        if (next.kind === 'login') {
          const fields = rebaseProjectCredentialFields([...copied.fields].map(([name, value]) =>
            ({ name, value: keePassFieldText(value), protected: value instanceof kdbxweb.ProtectedValue })), next.passwordGroupId || '');
          const project = fields.find(field => field.name === PROJECT_CREDENTIAL_FIELD);
          if (project && next.passwordGroupId) copied.fields.set(PROJECT_CREDENTIAL_FIELD, project.protected ? kdbxweb.ProtectedValue.fromString(project.value) : project.value);
          if (next.ssoRefLogicalId) copied.fields.set('MonicaSsoRefLogicalId', next.ssoRefLogicalId);
        }
      });
    } else {
      entry = createKeePassEntry(database, next, undefined, writes.get(source.id)!).entry;
      database.move(entry, group); entry.uuid = ids.get(source.id)!;
      for (const file of row.attachments!) {
        const bytes = base64ToBytes(file.dataBase64);
        try {
          entry.binaries.set(file.fileName, await database.createBinary(file.protected ? kdbxweb.ProtectedValue.fromBinary(bytes.slice().buffer) : bytes.slice().buffer));
        } finally { bytes.fill(0); }
      }
      if (next.kind === 'login') for (const previous of next.passwordHistory || []) {
        const history = new kdbxweb.KdbxEntry(); history.copyFrom(entry);
        history.fields.set('Password', kdbxweb.ProtectedValue.fromString(previous.password));
        history.times.lastModTime = new Date(previous.lastUsedAt);
        if (!Number.isFinite(history.times.lastModTime.getTime())) throw new Error('密码历史日期无效。');
        entry.history.push(history);
      }
      entry.history.sort((a, b) => a.lastModTime - b.lastModTime);
    }
  }
  for (const source of nativeSources.values()) source.assertCurrent();
  const output = readKeePassEntries(database, Number(account.config.databaseId), account.id);
  const entries = draft.rows.map(row => ({ sourceItemId: row.source.id, targetItemId: targets.get(row.source.id)!.id, entryUuid: ids.get(row.source.id)!.toString() }));
  const items: VaultItem[] = [];
  for (const row of entries) {
    const found = output.items.find(item => item.keepassEntryUuid === row.entryUuid), next = targets.get(row.sourceItemId)!;
    if (!found || found.kind !== next.kind) throw new Error('KeePass 整组回读不完整，原文件已保留。');
    if (!nativeSources.has(row.sourceItemId)) assertPortableProjection(next, found);
    const content = next.kind === 'passkey' && found.kind === 'passkey' ? preserveLocalPasskeyUsage(next, found) : found;
    items.push({ ...content, id: next.id, favorite: next.favorite, archivedAt: next.archivedAt,
      ...(next.kind === 'login' ? { passwordHistory: next.passwordHistory } : {}) } as VaultItem);
  }
  return { items, entries };
}

function nativeUuid(value: string): kdbxweb.KdbxUuid {
  const hex = value.replace(/-/g, '');
  return new kdbxweb.KdbxUuid(Uint8Array.from({ length: 16 }, (_, n) => parseInt(hex.slice(n * 2, n * 2 + 2), 16)).buffer);
}

function cloneCustomData(value: kdbxweb.KdbxEntry['customData']) {
  return value && new Map([...value].map(([name, row]) => [name, { value: row.value, lastModified: row.lastModified && new Date(row.lastModified) }]));
}

function nativeAttachmentBytes(entry: kdbxweb.KdbxEntry): number {
  let total = 0;
  for (const row of [entry, ...entry.history]) for (const binary of row.binaries.values()) {
    const value = kdbxweb.KdbxBinaries.isKdbxBinaryWithHash(binary) ? binary.value : binary;
    total += value instanceof kdbxweb.ProtectedValue ? value.byteLength : value.byteLength;
    if (total > LOCAL_ATTACHMENT_MAX_BYTES) throw new Error('原生附件及历史附件超过 16 MiB 上限。');
  }
  return total;
}

function importNativeEntry(database: kdbxweb.Kdbx, source: KeePassTransferNativeSource, group: kdbxweb.KdbxGroup) {
  if (!database.versionIsAtLeast(4, 1) && [source.entry, ...source.entry.history].some(entry =>
    entry.qualityCheck !== undefined || [...(entry.customData?.values() || [])].some(row => row.lastModified !== undefined)))
    throw new Error('目标 KDBX 版本无法完整保留来源的 4.1 元数据，请先升级目标文件格式。');
  for (const entry of [source.entry, ...source.entry.history]) if (entry.customIcon) {
    const id = entry.customIcon.toString(), old = database.meta.customIcons.get(id), icon = source.database.meta.customIcons.get(id);
    if (!icon) throw new Error('原生自定义图标不存在。');
    if (!database.versionIsAtLeast(4, 1) && (icon.name !== undefined || icon.lastModified !== undefined))
      throw new Error('目标 KDBX 版本无法完整保留来源的 4.1 图标元数据。');
    if (old && (old.name !== icon.name || old.lastModified?.getTime() !== icon.lastModified?.getTime()
      || old.data.byteLength !== icon.data.byteLength || new Uint8Array(old.data).some((byte, index) => byte !== new Uint8Array(icon.data)[index])))
      throw new Error('目标存在身份相同但内容不同的图标，不能覆盖。');
  }
  return database.importEntry(source.entry, group, source.database);
}

/** Fail closed when the target codec cannot carry a source field. Native copies
 * preserve the entry itself; portable rows need an explicit projection check. */
function assertPortableProjection(source: VaultItem, projected: VaultItem) {
  const overlays = new Set(['id', 'providerRefs', 'createdAt', 'updatedAt', 'favorite', 'archivedAt', 'categoryId', 'categoryName',
    'keepassDatabaseId', 'keepassGroupPath', 'keepassGroupUuid', 'keepassEntryUuid', 'passwordHistory', 'passwordHistoryIncomplete',
    'sourceMode', 'passkeyMode', 'keyAlgorithm', 'lastUsedAt', 'useCount', 'signCountHighWaterMark']);
  const jsonFields = new Set(['sshKeyData', 'wifiMetadata', 'barcodeData', 'steamRawJson', 'passkeyBindings']);
  for (const [name, value] of Object.entries(source)) {
    if (overlays.has(name) || value === undefined) continue;
    const actual = (projected as unknown as Record<string, unknown>)[name];
    if ((value === '' || Array.isArray(value) && !value.length) && actual === undefined) continue;
    if (canonical(value) === canonical(actual)) continue;
    if (source.kind === 'passkey' && typeof value === 'string' && typeof actual === 'string') {
      if (name === 'credentialId' && normalizeCredentialId(value) === normalizeCredentialId(actual)) continue;
      if (['privateKeyPkcs8', 'publicKey', 'userHandle'].includes(name) && sameEncodedBytes(value, actual)) continue;
    }
    if (jsonFields.has(name) && typeof value === 'string' && typeof actual === 'string') {
      try {
        const original = parseLosslessJson(value), result = parseLosslessJson(actual);
        if (original && result && typeof original === 'object' && typeof result === 'object'
          && Object.entries(original).every(([key, field]) => canonical(field) === canonical((result as Record<string, unknown>)[key]))) continue;
      } catch { /* The outer error names a field, never its secret value. */ }
    }
    throw new Error(`KeePass 无法完整保存所选项目的 ${name} 字段，未写入目标文件。`);
  }
}

/** KDBX's PEM reader canonicalizes Base64URL to Base64. Compare bytes, not
 * textual padding/alphabet, without relaxing preservation of key material. */
function sameEncodedBytes(left: string, right: string): boolean {
  let a: Uint8Array | undefined, b: Uint8Array | undefined;
  try {
    a = base64ToBytes(left.replace(/-/g, '+').replace(/_/g, '/'));
    b = base64ToBytes(right.replace(/-/g, '+').replace(/_/g, '/'));
    return a.length > 0 && a.length === b.length && a.every((byte, index) => byte === b![index]);
  } catch { return false; }
  finally { a?.fill(0); b?.fill(0); }
}

function canonical(value: unknown): string | undefined {
  const json = JSON as typeof JSON & { isRawJSON?: (value: unknown) => boolean };
  return JSON.stringify(value, (_key, row) => row && typeof row === 'object' && !Array.isArray(row) && !json.isRawJSON?.(row)
    ? Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))) : row);
}
