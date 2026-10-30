import * as kdbxweb from 'kdbxweb';
import type { LoginItem, ProviderAccount, VaultItem, VaultState } from '../../core/model';
import { parseLosslessJson } from '../../core/lossless-json';
import { readLocalTransferResource } from '../attachments/local-transfer-resource';
import type { Mdbx2TransferAttachmentService } from '../mdbx2/mdbx2-transfer-attachments';
import type { KeePassProvider } from '../keepass/keepass-provider';
import { keePassPatchFor } from '../keepass/keepass-writer';
import { keePassFieldText } from '../keepass/keepass-login-codec';
import { KEEPASS_PASSKEY_FIELDS } from '../keepass/keepass-passkey-codec';
import { KEEPASSDX_PASSKEY_FIELDS } from '../keepass/keepass-field-registry';
import { parsePortablePasskeyPrivateKey } from '../../passkey/private-key-portability';
import { normalizeCredentialId } from '../../passkey/source-policy';
import { mdbx2TransferOperationScope as hash } from '../mdbx2/mdbx2-transfer-identity';
import type { BitwardenPortableSource } from './bitwarden-batch-resource';

export async function readKeePassBitwardenSource(state: VaultState, account: ProviderAccount, item: VaultItem,
  preserveCategories: boolean, dependencies: {
    provider: KeePassProvider;
    files: Pick<Mdbx2TransferAttachmentService, 'listSourceAttachments' | 'readSourceAttachment'>;
    prepare(): Promise<void>;
    assertCurrent(): Promise<void>;
  }): Promise<BitwardenPortableSource> {
  await dependencies.assertCurrent(); await dependencies.prepare(); await dependencies.assertCurrent();
  const native = dependencies.provider.readTransferSource(account, item, state.items);
  const before = await dependencies.provider.transferNativeContentHash(account); native.assertCurrent();
  const portable = portableKeePassItem(item);
  assertKeePassFieldsRepresented(native.entry, portable);
  assertKeePassMetadataRepresented(native.entry);
  if (native.entry.history.length) {
    if (portable.kind !== 'login') throw unsupported('history');
    const history = passwordOnlyHistory(native.entry);
    // Both sources of history must be accounted for. Keep the order of native
    // snapshots; append only genuinely additional local history rows.
    portable.passwordHistory = [...history, ...(portable.passwordHistory || []).filter(row =>
      !history.some(original => original.password === row.password && original.lastUsedAt === row.lastUsedAt))];
  }
  const path = preserveCategories ? dependencies.provider.transferSourceFolder(account, item)?.segments || [] : [];
  const files = (await readLocalTransferResource(state, item, { files: dependencies.files, prepare: async () => undefined })).attachments;
  native.assertCurrent(); await dependencies.assertCurrent();
  if (before !== await dependencies.provider.transferNativeContentHash(account)) throw new Error('读取附件期间 KeePass 原生内容已变化。');
  native.assertCurrent(); await dependencies.assertCurrent();
  return { item: portable, files, path, fingerprint: await hash({ native: before, item, path }) };
}

function portableKeePassItem(item: VaultItem): VaultItem {
  const result = structuredClone(item);
  for (const key of ['keepassDatabaseId','keepassEntryUuid','keepassGroupUuid','keepassGroupPath','categoryId','categoryName'] as const) delete result[key];
  result.providerRefs = [];
  return result;
}

/** A fresh field map is essential: applying a patch to the old map would
 * preserve unknown native fields and falsely prove that the projection has them. */
export function assertKeePassFieldsRepresented(entry: kdbxweb.KdbxEntry, item: VaultItem): void {
  const fields = keePassPatchFor(item)?.replacementFields;
  if (!fields) throw unsupported('type');
  for (const [name, value] of entry.fields) {
    if (['MonicaLocalId','MonicaSecureItemId'].includes(name)) continue;
    const projected = fields.get(name), expected = keePassFieldText(value), actual = keePassFieldText(projected);
    if (projected !== undefined && expected === actual) {
      // Standard values are native Cipher properties. Custom values must retain
      // their protection bit; native encryption protects both representations.
      if (['Title','UserName','Password','URL','Notes'].includes(name)
        || !(value instanceof kdbxweb.ProtectedValue) || projected instanceof kdbxweb.ProtectedValue) continue;
    }
    if (projected === undefined && !expected && ['Title','UserName','Password','URL','Notes'].includes(name)) continue;
    if (name === KEEPASSDX_PASSKEY_FIELDS.privateKey && samePrivateKey(expected, actual)) continue;
    if ([KEEPASSDX_PASSKEY_FIELDS.credentialId, KEEPASS_PASSKEY_FIELDS.credentialId].some(field => field === name)
      && normalizeCredentialId(expected) && normalizeCredentialId(expected) === normalizeCredentialId(actual)) continue;
    if (name === KEEPASS_PASSKEY_FIELDS.data) {
      try {
        const source = parseLosslessJson(expected), target = parseLosslessJson(actual);
        if (source && target && typeof source === 'object' && typeof target === 'object' && !Array.isArray(source) && !Array.isArray(target)
          && Object.entries(source).every(([key, value]) => canonical(value) === canonical((target as Record<string, unknown>)[key])
            || key === 'privateKeyAlias' && typeof value === 'string' && samePrivateKey(value, String((target as Record<string, unknown>)[key])))) continue;
      } catch { /* Report only the field name. */ }
    }
    throw unsupported(name);
  }
}

function assertKeePassMetadataRepresented(entry: kdbxweb.KdbxEntry): void {
  if (entry.tags.length || entry.customData?.size || entry.customIcon && !entry.customIcon.empty || entry.fgColor || entry.bgColor
    || entry.overrideUrl || entry.icon != null && entry.icon !== 0 || entry.qualityCheck === false) throw unsupported('native metadata');
  if (entry.times.expires || entry.autoType.enabled === false || entry.autoType.obfuscation !== 0
    || entry.autoType.defaultSequence || entry.autoType.items.length) throw unsupported('expiration/autoType');
}

function passwordOnlyHistory(entry: kdbxweb.KdbxEntry): NonNullable<LoginItem['passwordHistory']> {
  if (entry.history.length > 1000) throw unsupported('history');
  return entry.history.map(previous => {
    assertKeePassMetadataRepresented(previous);
    if (previous.binaries.size || previous.history.length || previous.uuid.toString() !== entry.uuid.toString()) throw unsupported('history');
    const currentFields = [...entry.fields].filter(([key]) => key !== 'Password'), oldFields = [...previous.fields].filter(([key]) => key !== 'Password');
    if (currentFields.length !== oldFields.length || oldFields.some(([name, value]) => !entry.fields.has(name)
      || keePassFieldText(entry.fields.get(name)) !== keePassFieldText(value)
      || value instanceof kdbxweb.ProtectedValue !== (entry.fields.get(name) instanceof kdbxweb.ProtectedValue))) throw unsupported('history fields');
    const date = previous.times.lastModTime;
    if (!previous.fields.has('Password') || !date || !Number.isFinite(date.getTime())) throw unsupported('history date/password');
    return { password: keePassFieldText(previous.fields.get('Password')), lastUsedAt: date.toISOString() };
  });
}
function samePrivateKey(a: string, b: string) { const key = parsePortablePasskeyPrivateKey(a)?.pkcs8Base64; return !!key && key === parsePortablePasskeyPrivateKey(b)?.pkcs8Base64; }
function canonical(value: unknown): string | undefined { const json = JSON as typeof JSON & { isRawJSON?: (row: unknown) => boolean };
  return JSON.stringify(value, (_key, row) => row && typeof row === 'object' && !Array.isArray(row) && !json.isRawJSON?.(row)
    ? Object.fromEntries(Object.entries(row).sort(([a],[b]) => a.localeCompare(b))) : row); }
function unsupported(field: string) { return new Error(`KeePass ${field} 尚不能完整转入 Bitwarden，已保留来源。`); }
