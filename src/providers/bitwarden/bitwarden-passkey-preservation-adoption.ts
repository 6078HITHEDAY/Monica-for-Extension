import type { ProviderAccount, ProviderSourceRecord, VaultItem } from '../../core/model';
import type { PasswordProjectRemovalRecord } from '../../core/password-project-removal-journal';
import { parseLosslessJson } from '../../core/lossless-json';
import { createSourceRecord } from '../../core/source-records';
import { preserveLocalPasskeyUsage, samePasskeyCredential } from '../../passkey/ownership-policy';
import { BitwardenClient, type BitwardenSessionConfig } from './bitwarden-client';
import { decodeBitwardenCipher } from './bitwarden-cipher-codec';
import { decryptBitwardenString } from './bitwarden-crypto';
import { resolveBitwardenOrganizationKeys } from './bitwarden-organization';
import { verifyBitwardenPasskeyPreservationCopy } from './bitwarden-passkey-preservation';
import type { BitwardenProjectRestorationReadback } from './bitwarden-project-removal-restoration';

export interface BitwardenPasskeyCopyReadback {
  sourceRecords: ProviderSourceRecord[];
  decodeContext: BitwardenProjectRestorationReadback['decodeContext'];
}

const fail = () => new Error('Passkey 副本回读或本地引用不一致，原始凭据和恢复记录已保留。');
const field = (raw: Record<string, unknown>, name: string): unknown => {
  const upper = name[0].toUpperCase() + name.slice(1);
  if (name in raw && upper in raw && JSON.stringify(raw[name]) !== JSON.stringify(raw[upper])) throw fail();
  return raw[name] ?? raw[upper];
};

/** Executed inside the final vault write, without network calls. Keep the local
 * live Passkey ID and all other-provider references; give its old-source trash
 * projection a separate local identity for subsequent ordinary sync. */
export async function adoptBitwardenPasskeyCopies(record: PasswordProjectRemovalRecord, current: VaultItem[], merged: VaultItem[],
  account: ProviderAccount, result?: BitwardenPasskeyCopyReadback): Promise<VaultItem[]> {
  const expected = (record.bitwardenPasskeyPreservation?.sources || []).flatMap(source => source.plan.copies.map((copy, index) => ({
    plan: source.plan, copy, progress: source.copies[index]
  })));
  if (!expected.length) { if (result) throw fail(); return merged; }
  if (!result || !Array.isArray(result.sourceRecords) || result.sourceRecords.length !== expected.length
    || !result.decodeContext || !Array.isArray(result.decodeContext.folders) || !Array.isArray(result.decodeContext.organizations)) throw fail();
  const vaultKey = new BitwardenClient().vaultKey(account.config as BitwardenSessionConfig);
  let organizations: Awaited<ReturnType<typeof resolveBitwardenOrganizationKeys>> | undefined;
  try {
    organizations = await resolveBitwardenOrganizationKeys({ profile: {
      organizations: result.decodeContext.organizations, privateKey: result.decodeContext.privateKey
    } }, vaultKey);
    const folders = new Map<string, string>();
    for (const folder of result.decodeContext.folders) {
      const id = field(folder, 'id'), name = field(folder, 'name');
      if (typeof id !== 'string' || typeof name !== 'string' || folders.has(id)) throw fail();
      folders.set(id, (await decryptBitwardenString(name, vaultKey)).trim().slice(0, 256));
    }
    const seen = new Set<string>(), replacements = new Map<string, VaultItem>(), additions: VaultItem[] = [];
    const ids = new Set(merged.map(row => row.id));
    for (const source of result.sourceRecords) {
      const saved = expected.find(row => row.progress.remoteId === source.remoteId);
      if (!saved || seen.has(source.remoteId) || saved.progress.stage !== 'verified' || source.providerId !== account.id
        || source.format !== 'bitwarden-cipher' || source.encoding !== 'json'
        || (await createSourceRecord({ ...source, payload: source.payload })).contentHash !== source.contentHash) throw fail();
      const raw = parseLosslessJson(source.payload) as Record<string, unknown>;
      if (field(raw, 'id') !== source.remoteId || source.revision !== field(raw, 'revisionDate')) throw fail();
      const organization = field(raw, 'organizationId'), key = organization ? organizations.keys.get(String(organization)) : vaultKey;
      if (!key) throw fail();
      await verifyBitwardenPasskeyPreservationCopy(saved.plan, saved.copy, raw, key);
      const decoded = await decodeBitwardenCipher(raw, account.id, key, folders.get(String(field(raw, 'folderId'))), { requireReadableProjectMembership: true });
      const login = decoded.items.find(row => row.kind === 'login'), passkey = decoded.items.find(row => row.kind === 'passkey');
      if (decoded.items.length !== 2 || !login || !passkey || decoded.warning || decoded.historyWarning || decoded.unsupported) throw fail();
      const originals = current.filter(row => row.kind === 'passkey' && row.providerRefs.some(ref => ref.providerId === account.id && ref.remoteId === saved.copy.sourceRemoteId));
      const local = originals[0], tombstone = local && merged.find(row => row.id === local.id);
      if (originals.length !== 1 || local.kind !== 'passkey' || tombstone?.kind !== 'passkey' || !tombstone.deletedAt
        || !samePasskeyCredential(local, passkey) || local.signCount !== passkey.signCount || replacements.has(local.id)
        || current.some(row => row.providerRefs.some(ref => ref.providerId === account.id && (ref.remoteId === source.remoteId || ref.remoteId?.startsWith(`${source.remoteId}#`))))
        || ids.has(login.id)) throw fail();
      const moved = preserveLocalPasskeyUsage(local, { ...passkey, id: local.id, createdAt: local.createdAt,
        providerRefs: [...local.providerRefs.filter(ref => ref.providerId !== account.id), ...passkey.providerRefs] });
      // A tombstone must not retain references to other still-live providers.
      const trashId = crypto.randomUUID(); if (ids.has(trashId)) throw fail(); ids.add(trashId); ids.add(login.id);
      additions.push({ ...tombstone, id: trashId, providerRefs: tombstone.providerRefs.filter(ref => ref.providerId === account.id) }, login);
      replacements.set(local.id, moved); seen.add(source.remoteId);
    }
    return [...merged.map(row => replacements.get(row.id) || row), ...additions];
  } finally {
    vaultKey.encKey.fill(0); vaultKey.macKey.fill(0);
    organizations?.keys.forEach(key => { key.encKey.fill(0); key.macKey.fill(0); });
  }
}
