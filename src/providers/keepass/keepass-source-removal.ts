import type * as kdbxweb from 'kdbxweb';
import type { ProviderAccount, VaultItem } from '../../core/model';
import { PROJECT_CREDENTIAL_FIELD, readProjectCredential } from '../../core/project-credentials';
import { resolveSsoAccount } from '../../core/sso-links';
import { mdbx2TransferDependencies } from '../mdbx2/mdbx2-transfer-dependencies';
import { assertMdbx2TransferOperationId, mdbx2TransferOperationScope as hash } from '../mdbx2/mdbx2-transfer-identity';
import { readKeePassEntries } from './keepass-vault';
import { keePassTransferContentHash } from './keepass-transfer-file';
import { keePassFieldText, keePassFieldValue } from './keepass-login-codec';
import { buildKeePassReferenceContext, normalizeUuid, resolveKeePassReferenceValue } from './keepass-field-reference';
import { isInRecycleBin } from './keepass-groups';
import { removeKeePassEntry, validateKeePassEntryRemoval } from './keepass-writer';

/** Internal deletion authorization. The coordinator must first durably save
 * this request after authenticating every destination item and attachment. */
export interface KeePassSourceRemovalRequest {
  version: 1;
  operationId: string;
  createdAt: string;
  targetProviderId: string;
  targetProofSha256: string;
  expectedWorkingSha256: string;
  expectedContentSha256: string;
  sources: VaultItem[];
}
export interface KeePassSourceRemovalResult {
  inputSha256: string;
  outputSha256: string;
  recycleBinUuid: string;
  entries: Array<{ sourceItemId: string; entryUuid: string }>;
}
export interface KeePassSourceRemovalFileResult extends KeePassSourceRemovalResult {
  bytes: Uint8Array;
  assertCurrent(): void;
}
const invalid = () => new Error('KeePass 来源移除请求无效，原文件已保留。');
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function readKeePassSourceRemoval(account: ProviderAccount, input: KeePassSourceRemovalRequest): KeePassSourceRemovalRequest {
  if (account?.kind !== 'keepass' || !account.enabled || !['local-file', 'webdav', 'onedrive'].includes(String(account.config.sourceMode))
    || !Number.isSafeInteger(Number(account.config.databaseId)) || Number(account.config.databaseId) <= 0
    || !input || input.version !== 1 || typeof input.createdAt !== 'string' || !Number.isFinite(Date.parse(input.createdAt))
    || typeof input.targetProviderId !== 'string' || !input.targetProviderId || input.targetProviderId.length > 128 || input.targetProviderId === account.id
    || ![input.targetProofSha256, input.expectedWorkingSha256, input.expectedContentSha256].every(digest)
    || !Array.isArray(input.sources) || !input.sources.length || input.sources.length > 200) throw invalid();
  assertMdbx2TransferOperationId(input.operationId);
  const ids = new Set<string>(), nativeIds = new Set<string>();
  for (const item of input.sources) {
    const uuid = item?.keepassEntryUuid, ref = item?.providerRefs?.[0];
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 4096 || ids.has(item.id) || item.deletedAt || item.kind === 'opaque'
      || typeof uuid !== 'string' || !/^[a-f0-9]{32}$/.test(normalizeUuid(uuid)) || nativeIds.has(normalizeUuid(uuid))
      || item.providerRefs?.length !== 1 || !ref || ref.providerId !== account.id || ref.remoteId !== uuid || typeof ref.etag !== 'string' || !ref.etag) throw invalid();
    ids.add(item.id); nativeIds.add(normalizeUuid(uuid));
  }
  return structuredClone(input);
}

export function keePassSourceRemovalRequestHash(account: ProviderAccount, input: KeePassSourceRemovalRequest): Promise<string> {
  const request = readKeePassSourceRemoval(account, input);
  const keys = ['sourceMode', 'databaseId', 'webDavBaseUrl', 'webDavUsername', 'remotePath', 'oneDriveDriveId', 'oneDriveItemId', 'localFileSourceSha256'];
  return hash({ request, account: { id: account.id, kind: account.kind,
    config: Object.fromEntries(keys.map(key => [key, account.config[key]])),
    connectionId: (account.config.oneDriveConnection as { id?: unknown } | undefined)?.id } });
}

/** Inspect the native catalog, including entries absent from the local index.
 * Field-reference targets are resolved by the same UUID/name/search rules used
 * by the reader. Crossing a selection boundary would strand a live relation. */
export function assertKeePassRemovalClosure(database: kdbxweb.Kdbx, account: ProviderAccount, request: KeePassSourceRemovalRequest): void {
  // The reader's UUID map collapses duplicate entries. Inspect the tree first,
  // including the recycle bin, so an ambiguous file cannot authorize deletion.
  if (database.groups.length !== 1) throw invalid();
  const all = [...database.getDefaultGroup().allEntries()], seen = new Set<string>();
  for (const entry of database.getDefaultGroup().allGroupsAndEntries()) {
    const id = normalizeUuid(entry.uuid.toString());
    if (!/^[a-f0-9]{32}$/.test(id) || seen.has(id)) throw invalid();
    seen.add(id);
  }
  const native = readKeePassEntries(database, Number(account.config.databaseId), account.id);
  const selected = new Set(request.sources.map(item => item.keepassEntryUuid!));
  const items = native.items.filter(item => !item.deletedAt);
  const ids = items.filter(item => selected.has(item.keepassEntryUuid!)).map(item => item.id);
  if (ids.length !== selected.size || mdbx2TransferDependencies(ids, items, 'move').selectedIds.length !== ids.length)
    throw new Error('KeePass 来源包含未选择的原生项目成员或关联，原文件已保留。');
  const active = all.filter(entry => !entry.parentGroup || !isInRecycleBin(database, entry.parentGroup));
  const byUuid = new Map(items.map(item => [item.keepassEntryUuid, item]));
  const relationError = () => new Error('KeePass 原生关联无法完整确认，原文件已保留。');
  for (const entry of active) {
    const item = byUuid.get(entry.uuid.toString());
    // A template/opaque row can still contain project membership omitted by
    // the decoded catalog. Unknown/malformed membership must not be ignored.
    if (entry.fields.has(PROJECT_CREDENTIAL_FIELD)) {
      const metadata = readProjectCredential([{ name: PROJECT_CREDENTIAL_FIELD, value: keePassFieldText(entry.fields.get(PROJECT_CREDENTIAL_FIELD)), type: 'text', protected: false }]);
      if (!metadata || item?.kind !== 'login' || item.passwordGroupId !== metadata.projectId) throw relationError();
    }
    const logical = keePassFieldValue(entry.fields, 'MonicaSsoRefLogicalId');
    const numeric = keePassFieldValue(entry.fields, 'MonicaSsoRefEntryId', 'SsoRefEntryId', 'MonicaSsoRefId');
    if (logical || numeric) {
      if (item?.kind !== 'login' || !logical) throw relationError();
      const target = resolveSsoAccount(item, items);
      if (!target || selected.has(entry.uuid.toString()) !== selected.has(target.keepassEntryUuid!)) throw relationError();
    }
    // Room numeric links are not stable KDBX identities. The reader can omit
    // them (notably from Passkey payloads), so inspect their native containers.
    for (const field of ['MonicaItemData', 'MonicaPasskeyData']) {
      const raw = keePassFieldValue(entry.fields, field);
      if (!raw) continue;
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(raw); } catch { throw relationError(); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw relationError();
      for (const name of ['boundPasswordId', 'boundNoteId', 'boundNoteEntryId', 'boundTotpItemId'])
        if (payload[name] != null && payload[name] !== '') throw relationError();
    }
  }
  const references = active.map(entry => ({ uuid: entry.uuid.toString(), fields: entry.fields }));
  const context = buildKeePassReferenceContext(references);
  for (const entry of references) for (const value of entry.fields.values()) {
    const text = keePassFieldText(value);
    if (!/\{REF:/i.test(text)) continue;
    const tokens = [...text.matchAll(/\{REF:([A-Za-z])@([A-Za-z]):([^{}]+)\}/gi)];
    if (!tokens.length || /\{REF:/i.test(text.replace(/\{REF:([A-Za-z])@([A-Za-z]):([^{}]+)\}/gi, '')))
      throw new Error('KeePass 字段引用无法完整确认，原文件已保留。');
    for (const token of tokens) {
      if (!'TUPANIO'.includes(token[1].toUpperCase())) throw new Error('KeePass 字段引用无法完整确认，原文件已保留。');
      const identity = resolveKeePassReferenceValue(`{REF:I@${token[2]}:${token[3]}}`, entry, context);
      const matches = context.entriesByNormalizedUuid.get(normalizeUuid(identity));
      if (!matches || matches.length !== 1) throw new Error('KeePass 字段引用无法完整确认，原文件已保留。');
      if (selected.has(entry.uuid) !== selected.has(matches[0].uuid))
        throw new Error('KeePass 字段引用跨越所选项目，原文件已保留。');
    }
  }
}

/** Mutates only a disposable authenticated file. The caller saves the exact
 * bytes and encrypted receipt atomically; this never publishes or adopts them. */
export async function applyKeePassSourceRemoval(database: kdbxweb.Kdbx, account: ProviderAccount, input: KeePassSourceRemovalRequest) {
  const request = readKeePassSourceRemoval(account, input);
  if (await keePassTransferContentHash(database) !== request.expectedContentSha256)
    throw new Error('KeePass 来源原生内容、历史或附件已变化，原文件已保留。');
  assertKeePassRemovalClosure(database, account, request);
  const native = readKeePassEntries(database, Number(account.config.databaseId), account.id);
  const entries = request.sources.map(source => {
    const entry = native.entriesByUuid.get(source.keepassEntryUuid!);
    const item = native.items.find(item => item.keepassEntryUuid === source.keepassEntryUuid);
    if (!entry || !item || item.deletedAt || item.kind !== source.kind) throw invalid();
    validateKeePassEntryRemoval(database, entry);
    return { source, entry };
  });
  for (const { entry } of entries) removeKeePassEntry(database, entry);
  const recycleBinUuid = database.meta.recycleBinUuid?.toString();
  if (!recycleBinUuid || entries.some(({ entry }) => !entry.parentGroup || !isInRecycleBin(database, entry.parentGroup))) throw invalid();
  return { recycleBinUuid, entries: entries.map(({ source, entry }) => ({ sourceItemId: source.id, entryUuid: entry.uuid.toString() })) };
}
