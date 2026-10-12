import type { VaultState, VaultItem, ProviderAccount } from '../../core/model';
import { isLocalTransferItem, validateLocalAttachments, type LocalItemAttachment } from '../../core/local-transfer';
import { bitwardenProjectCipherId } from '../../core/bitwarden-project-removal-local';
import { bitwardenTransferSourceSha256 } from './bitwarden-transfer-cipher';
import { decodeBitwardenCipher, encodeBitwardenCipher, encodeBitwardenPasskeyCipher } from './bitwarden-cipher-codec';
import { encryptBitwardenString, type BitwardenSymmetricKey } from './bitwarden-crypto';
import { BitwardenClient } from './bitwarden-client';
import type { BitwardenAttachmentVaultContext } from './bitwarden-attachments';
import { parseLosslessJson } from '../../core/lossless-json';
import { mdbx2TransferOperationScope as hash } from '../mdbx2/mdbx2-transfer-identity';
import { normalizeCredentialId } from '../../passkey/source-policy';
import { base64ToBytes } from '../../security/encoding';
import { assertBitwardenPasskeyPublicKey } from './bitwarden-passkey-public-key';
import { parsePortablePasskeyPrivateKey } from '../../passkey/private-key-portability';

export interface BitwardenBatchResource {
  raw: Record<string, unknown>;
  ownerKey: BitwardenSymmetricKey;
  files: LocalItemAttachment[];
  path: string[];
  fingerprint: string;
  dispose(): void;
}

export interface BitwardenPortableSource {
  item: VaultItem;
  files: LocalItemAttachment[];
  path: string[];
  fingerprint: string;
}

export async function readBitwardenBatchResource(state: VaultState, items: VaultItem[], preserveCategories: boolean, dependencies: {
  context(account: ProviderAccount, item: VaultItem): Promise<BitwardenAttachmentVaultContext>;
  files(state: VaultState, item: VaultItem): Promise<LocalItemAttachment[]>;
  portableSource?(account: ProviderAccount, item: VaultItem, preserveCategories: boolean): Promise<BitwardenPortableSource>;
}): Promise<BitwardenBatchResource> {
  const first = items[0]; if (!first || items.some(row => row.deletedAt || row.kind === 'opaque')) throw new Error('所选原生类型尚不能完整转入 Bitwarden。');
  let key: BitwardenSymmetricKey | undefined, context: BitwardenAttachmentVaultContext | undefined;
  const dispose = () => { key?.encKey.fill(0); key?.macKey.fill(0); for (const row of context?.organizationKeys?.values() || []) { row.encKey.fill(0); row.macKey.fill(0); } };
  try {
    let raw: Record<string, unknown>, files: LocalItemAttachment[], fingerprint: string;
    const local = isLocalTransferItem(first, state.providers);
    const account = first.providerRefs.length === 1 ? state.providers.find(row => row.id === first.providerRefs[0].providerId) : undefined;
    let foreign: BitwardenPortableSource | undefined;
    if (!local && account?.enabled && account.kind !== 'bitwarden' && items.length === 1 && dependencies.portableSource)
      foreign = await dependencies.portableSource(account, first, preserveCategories);
    if (local || foreign) {
      if (items.length !== 1 || local && (state.localItemOrigins || []).some(row => row.itemId === first.id && row.records.length))
        throw new Error('此本地项目保留了原生来源数据，尚不能完整写入 Bitwarden。');
      key = { encKey: crypto.getRandomValues(new Uint8Array(32)), macKey: crypto.getRandomValues(new Uint8Array(32)) };
      const portable = structuredClone(foreign?.item || first); portable.providerRefs = [];
      raw = { ...await (portable.kind === 'passkey' ? encodeBitwardenPasskeyCipher(portable, key) : encodeBitwardenCipher(portable, key)), id: first.id, revisionDate: first.updatedAt };
      const decoded = await decodeBitwardenCipher(raw, 'transfer-source', key);
      const matches = decoded.items.filter(row => row.kind === first.kind && (row.kind !== 'passkey' || first.kind === 'passkey' && normalizeCredentialId(row.credentialId) === normalizeCredentialId(first.credentialId)));
      if (decoded.warning || decoded.historyWarning || decoded.unsupported || matches.length !== 1) throw new Error('Bitwarden 无法完整表示所选项目。');
      await assertBitwardenPortableProjection(portable, matches[0]);
      files = foreign?.files || structuredClone((state.localItemAttachments || []).filter(row => row.itemId === first.id)); await validateLocalAttachments(files, first.id);
      // The source attachment metadata is synthetic but authenticated, and binds
      // exactly the bytes staged in the encrypted journal.
      raw.attachments = await Promise.all(files.map(async file => ({ id: file.attachmentId, fileName: await encryptBitwardenString(file.fileName, key!) })));
      fingerprint = await hash({ item: first, files, ...(foreign ? { native: foreign.fingerprint } : {}) });
    } else {
      if (!account?.enabled || account.kind !== 'bitwarden') throw new Error('此来源的原生扩展字段与历史尚不能完整转入 Bitwarden，请保留原库。');
      const cipherId = bitwardenProjectCipherId(first.providerRefs[0].remoteId || '');
      if (!cipherId || items.some(row => row.providerRefs.length !== 1 || row.providerRefs[0].providerId !== account.id
        || bitwardenProjectCipherId(row.providerRefs[0].remoteId || '') !== cipherId)) throw new Error('Bitwarden 来源身份不唯一。');
      context = await dependencies.context(account, first); raw = context.rawCipher;
      const owner = new BitwardenClient().vaultKey(context.session), org = raw.organizationId ?? raw.OrganizationId;
      if (org != null) {
        owner.encKey.fill(0); owner.macKey.fill(0);
        const organizationKey = typeof org === 'string' && context.organizationKeys?.get(org);
        if (!organizationKey) throw new Error('Bitwarden 来源组织密钥不可用。');
        key = { encKey: organizationKey.encKey.slice(), macKey: organizationKey.macKey.slice() };
      } else key = owner;
      const records = state.sourceRecords.filter(row => row.providerId === account.id && row.remoteId === cipherId);
      if (records.length !== 1 || records[0].format !== 'bitwarden-cipher' || records[0].encoding !== 'json'
        || (raw.id ?? raw.Id) !== cipherId || await bitwardenTransferSourceSha256(raw)
          !== await bitwardenTransferSourceSha256(parseLosslessJson(records[0].payload) as Record<string, unknown>))
        throw new Error('Bitwarden 原生来源已变化，请先同步再预览。');
      const decoded = await decodeBitwardenCipher(raw, account.id, key);
      // Never copy an unshown native sibling without including it in the plan.
      if (decoded.items.length !== items.length || decoded.items.some(row => !items.some(item => item.kind === row.kind
        && item.providerRefs[0].remoteId === row.providerRefs[0].remoteId))) throw new Error('Bitwarden 来源包含未同步的关联项目，请先同步。');
      files = await dependencies.files(state, first);
      const after = await dependencies.context(account, first);
      try { if (await bitwardenTransferSourceSha256(after.rawCipher) !== await bitwardenTransferSourceSha256(raw)) throw new Error('读取附件期间来源已变化。'); }
      finally { for (const row of after.organizationKeys?.values() || []) { row.encKey.fill(0); row.macKey.fill(0); } }
      fingerprint = await hash({ native: await bitwardenTransferSourceSha256(raw), files });
    }
    if (!foreign && preserveCategories && !first.categoryName?.trim() && (first.categoryId != null || first.providerRefs.some(row => row.remoteFolderId)))
      throw new Error('来源文件夹名称缺失，请先同步或取消保留分类。');
    const path = foreign?.path || (preserveCategories && first.categoryName ? [first.categoryName] : []);
    return { raw, ownerKey: key, files, path, fingerprint: await hash({ fingerprint, path }), dispose };
  } catch (error) { dispose(); throw error; }
}

/** Explicit field-loss refusal. Error messages name the field, never its value. */
export async function assertBitwardenPortableProjection(source: VaultItem, projected: VaultItem) {
  if (source.kind === 'passkey' && projected.kind === 'passkey') {
    // Native FIDO2 carries PKCS#8, not SPKI. Prove that the saved private key
    // still authenticates against the source public key before accepting this omission.
    await assertBitwardenPasskeyPublicKey(source.publicKey, projected);
  }
  const routing = new Set(['id','providerRefs','createdAt','updatedAt','categoryId','categoryName',
    'sourceMode','passkeyMode','keyAlgorithm','lastUsedAt','useCount','signCountHighWaterMark']);
  const jsonFields = new Set(['sshKeyData','wifiMetadata','barcodeData','steamRawJson','passkeyBindings']);
  for (const [name, value] of Object.entries(source)) {
    if (routing.has(name) || value === undefined) continue;
    const actual = (projected as unknown as Record<string, unknown>)[name];
    if (source.kind === 'login' && projected.kind === 'login' && name === 'loginType' && value === 'PASSWORD' && actual === undefined) continue;
    if (source.kind === 'passkey' && projected.kind === 'passkey') {
      if (name === 'publicKey' && !actual) continue; // Proven above, not discarded blindly.
      if ((name === 'backupEligible' || name === 'backupState') && value === true && actual === undefined) continue;
      if (name === 'transports' && canonical(value) === '["internal"]' && actual === undefined) continue;
    }
    if ((name !== 'boundTotpItemId' && value === '' || Array.isArray(value) && !value.length) && actual === undefined || canonical(value) === canonical(actual)) continue;
    if (name === 'customFields' && Array.isArray(value) && Array.isArray(actual)
      && canonical(value.map(normalizeField)) === canonical(actual.map(normalizeField))) continue;
    if (source.kind === 'passkey' && typeof value === 'string' && typeof actual === 'string') {
      if (name === 'credentialId' && normalizeCredentialId(value) === normalizeCredentialId(actual)) continue;
      if (['privateKeyPkcs8','publicKey','userHandle'].includes(name)) {
        let a: Uint8Array | undefined, b: Uint8Array | undefined;
        try { a = base64ToBytes(name === 'privateKeyPkcs8' ? parsePortablePasskeyPrivateKey(value)?.pkcs8Base64 || '' : value.replace(/-/g, '+').replace(/_/g, '/'));
          b = base64ToBytes(actual.replace(/-/g, '+').replace(/_/g, '/'));
          if (a.length === b.length && a.every((v,i) => v === b![i])) continue;
        } catch { /* Report the field name only. */ } finally { a?.fill(0); b?.fill(0); }
      }
    }
    if (jsonFields.has(name) && typeof value === 'string' && typeof actual === 'string') {
      try { if (canonical(parseLosslessJson(value)) === canonical(parseLosslessJson(actual))) continue; } catch { /* Name-only error below. */ }
    }
    throw new Error(`Bitwarden 无法完整保存 ${name} 字段，已保留来源。`);
  }
}
function normalizeField(field: Record<string, unknown>) {
  const { id: _id, fieldType, ...rest } = field;
  // TEXT/HIDDEN are the same native text types represented by `protected` on
  // readback. Retain every other type/attribute so actual losses still refuse.
  return { ...rest, protected: rest.protected === true || fieldType === 'HIDDEN',
    ...(fieldType !== undefined && fieldType !== 'TEXT' && fieldType !== 'HIDDEN' ? { fieldType } : {}) };
}
function canonical(value: unknown) { const json = JSON as typeof JSON & { isRawJSON?: (row: unknown) => boolean };
  return JSON.stringify(value, (_key, row) => row && typeof row === 'object' && !Array.isArray(row) && !json.isRawJSON?.(row)
    ? Object.fromEntries(Object.entries(row).sort(([a],[b]) => a.localeCompare(b))) : row); }
