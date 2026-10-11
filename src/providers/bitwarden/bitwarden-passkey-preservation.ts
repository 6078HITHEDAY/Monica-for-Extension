import type { PasskeyItem } from '../../core/model';
import { bitwardenProjectLocalSha256 } from '../../core/bitwarden-project-removal-local';
import { cloneLosslessJson, parseLosslessJson } from '../../core/lossless-json';
import { normalizeCredentialId } from '../../passkey/source-policy';
import { assertPasskeyCounter } from '../../passkey/ownership-policy';
import { decodeBitwardenCipher, resolveBitwardenCipherKey } from './bitwarden-cipher-codec';
import { decryptBitwardenString, encryptBitwardenString, type BitwardenSymmetricKey } from './bitwarden-crypto';
import { bitwardenRemovalSnapshotSha256 } from './bitwarden-project-removal-transaction';

export const BITWARDEN_PASSKEY_PRESERVATION_FIELD = 'monica.passkey-preservation.v1';

export interface BitwardenPasskeyPreservationCopy {
  copyId: string;
  credentialId: string;
  sourceRemoteId: string;
  credentialSha256: string;
  /** Contains ciphertext only; persist in the encrypted recovery journal. */
  payloadJson: string;
}
export interface BitwardenPasskeyPreservationPlan {
  version: 1;
  operationId: string;
  sourceCipherId: string;
  sourceSha256: string;
  copies: BitwardenPasskeyPreservationCopy[];
}

const invalid = () => new Error('无法无损保留 Bitwarden Passkey，原密码与凭据尚未删除。');
const field = (raw: Record<string, unknown>, name: string) => {
  const upper = name[0].toUpperCase() + name.slice(1);
  if (name in raw && upper in raw && JSON.stringify(raw[name]) !== JSON.stringify(raw[upper])) throw invalid();
  return raw[name] ?? raw[upper];
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
const fidoNames = new Set(['credentialId', 'keyType', 'keyAlgorithm', 'keyCurve', 'keyValue', 'rpId', 'rpName', 'counter',
  'userHandle', 'userName', 'userDisplayName', 'discoverable', 'creationDate']);
const canonicalKnownFields = (raw: Record<string, unknown>, names: Set<string>) => {
  const result: Record<string, unknown> = Object.create(null);
  for (const [name, value] of Object.entries(raw)) {
    const lower = name[0].toLowerCase() + name.slice(1), key = names.has(lower) ? lower : name;
    if (key in result && JSON.stringify(result[key]) !== JSON.stringify(value)) throw invalid();
    result[key] = cloneLosslessJson(value);
  }
  return result;
};
const canonicalFido = (raw: Record<string, unknown>) => canonicalKnownFields(raw, fidoNames);
const canonicalUris = (value: unknown) => {
  if (value == null) return [];
  if (!Array.isArray(value)) throw invalid();
  return value.map(row => canonicalKnownFields(object(row), new Set(['uri', 'match', 'uriChecksum'])));
};
const credentialHash = (value: unknown) => {
  const stable = (value: unknown): unknown => {
    if ((JSON as typeof JSON & { isRawJSON?: (value: unknown) => boolean }).isRawJSON?.(value)) return value;
    return Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)])) : value;
  };
  return bitwardenProjectLocalSha256(JSON.stringify(stable(value)));
};
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;

/** Preserve each native FIDO2 object under the same existing Cipher key. The
 * destination stays in the same account/organization, so its wrapped key can be
 * reused without rewriting any credential bytes. Passwords, OTP and project
 * membership remain with the original password; the copy is a standalone login.
 */
export async function planBitwardenPasskeyPreservation(operationId: string, source: Record<string, unknown>,
  accountOrOrganizationKey: BitwardenSymmetricKey): Promise<BitwardenPasskeyPreservationPlan> {
  const sourceId = field(source, 'id');
  if (!identifier(operationId) || !identifier(sourceId) || /[:#]/.test(sourceId) || field(source, 'type') !== 1 || field(source, 'deletedDate')) throw invalid();
  const login = object(field(source, 'login')), native = field(login, 'fido2Credentials');
  if (native != null && !Array.isArray(native) || Array.isArray(native) && native.length > 100) throw invalid();
  const decoded = await decodeBitwardenCipher(source, 'preservation', accountOrOrganizationKey, undefined, { requireReadableProjectMembership: true });
  const passkeys = decoded.items.filter((item): item is PasskeyItem => item.kind === 'passkey');
  if (decoded.warning || decoded.historyWarning || decoded.unsupported || passkeys.length !== (Array.isArray(native) ? native.length : 0)) throw invalid();
  const sourceSha256 = await bitwardenRemovalSnapshotSha256(source), copies: BitwardenPasskeyPreservationCopy[] = [];
  const result: BitwardenPasskeyPreservationPlan = { version: 1, operationId, sourceCipherId: sourceId, sourceSha256, copies };
  if (!passkeys.length) return result;
  const cipherKey = await resolveBitwardenCipherKey(source, accountOrOrganizationKey);
  try {
    const ids = new Set<string>();
    for (let index = 0; index < passkeys.length; index++) {
      const passkey = passkeys[index], credentialId = normalizeCredentialId(passkey.credentialId);
      if (!identifier(credentialId) || ids.has(credentialId) || passkey.algorithm !== -7 || !passkey.privateKeyPkcs8 || !passkey.rpId || !passkey.userHandle) throw invalid();
      assertPasskeyCounter(passkey.signCount); ids.add(credentialId);
      const credential = canonicalFido(object((native as unknown[])[index]));
      const counter = field(credential, 'counter');
      if (counter != null && typeof counter !== 'string') throw invalid();
      const counterText = typeof counter === 'string' && /^(?:0|2)\.|^\./.test(counter)
        ? await decryptBitwardenString(counter, cipherKey) : counter;
      if (counterText != null && (typeof counterText !== 'string' || !/^\d+$/.test(counterText) || Number(counterText) !== passkey.signCount)) throw invalid();
      const credentialSha256 = await credentialHash(credential);
      const copyId = await bitwardenProjectLocalSha256([operationId, sourceId, credentialId, credentialSha256]);
      const marker = JSON.stringify({ version: 1, operationId, sourceCipherId: sourceId, credentialId, credentialSha256, copyId });
      const payload = {
        type: 1, name: field(source, 'name'), notes: field(source, 'notes') ?? null,
        favorite: field(source, 'favorite') === true, reprompt: field(source, 'reprompt') ?? 0,
        key: field(source, 'key') ?? null, organizationId: field(source, 'organizationId') ?? null,
        collectionIds: field(source, 'collectionIds') ?? null, folderId: field(source, 'folderId') ?? null,
        archivedDate: field(source, 'archivedDate') ?? null,
        fields: [{ type: 1, name: await encryptBitwardenString(BITWARDEN_PASSKEY_PRESERVATION_FIELD, cipherKey),
          value: await encryptBitwardenString(marker, cipherKey) }],
        login: { username: field(login, 'username') ?? null, password: null, totp: null,
          uris: canonicalUris(field(login, 'uris')), fido2Credentials: [credential] }
      };
      copies.push({ copyId, credentialId, sourceRemoteId: passkey.providerRefs[0].remoteId!, credentialSha256, payloadJson: JSON.stringify(payload) });
    }
    return result;
  } finally { if (cipherKey !== accountOrOrganizationKey) { cipherKey.encKey.fill(0); cipherKey.macKey.fill(0); } }
}

/** Compare the observed copy to its persisted ciphertext intent. This is a
 * preservation proof, not an authorization to remove the source password.
 */
export async function verifyBitwardenPasskeyPreservationCopy(plan: BitwardenPasskeyPreservationPlan,
  copy: BitwardenPasskeyPreservationCopy, raw: Record<string, unknown>, accountOrOrganizationKey: BitwardenSymmetricKey): Promise<PasskeyItem> {
  if (plan.version !== 1 || !plan.copies.some(row => row.copyId === copy.copyId)
    || !identifier(field(raw, 'id')) || field(raw, 'id') === plan.sourceCipherId || field(raw, 'type') !== 1 || field(raw, 'deletedDate')) throw invalid();
  await bitwardenRemovalSnapshotSha256(raw);
  const payload = object(parseLosslessJson(copy.payloadJson));
  const login = object(field(raw, 'login')), expectedLogin = object(payload.login), credentials = field(login, 'fido2Credentials');
  const history = field(raw, 'passwordHistory');
  if (!Array.isArray(credentials) || credentials.length !== 1 || field(login, 'password') || field(login, 'totp')
    || history != null && (!Array.isArray(history) || history.length !== 0)
    || await credentialHash(canonicalFido(object(credentials[0]))) !== copy.credentialSha256) throw invalid();
  for (const name of ['name', 'notes', 'key', 'organizationId', 'folderId', 'archivedDate']) {
    if (JSON.stringify(field(raw, name) ?? null) !== JSON.stringify(payload[name] ?? null)) throw invalid();
  }
  if ((field(raw, 'favorite') === true) !== payload.favorite || (field(raw, 'reprompt') ?? 0) !== payload.reprompt
    || JSON.stringify(field(raw, 'collectionIds') ?? []) !== JSON.stringify(payload.collectionIds ?? [])
    || JSON.stringify(field(login, 'username') ?? null) !== JSON.stringify(expectedLogin.username ?? null)
    || JSON.stringify(canonicalUris(field(login, 'uris'))) !== JSON.stringify(expectedLogin.uris ?? [])) throw invalid();
  const cipherKey = await resolveBitwardenCipherKey(raw, accountOrOrganizationKey);
  try {
    const fields = field(raw, 'fields');
    if (!Array.isArray(fields) || fields.length !== 1) throw invalid();
    const markerField = object(fields[0]);
    if (field(markerField, 'type') !== 1 || await decryptBitwardenString(String(field(markerField, 'name')), cipherKey) !== BITWARDEN_PASSKEY_PRESERVATION_FIELD) throw invalid();
    const marker = JSON.parse(await decryptBitwardenString(String(field(markerField, 'value')), cipherKey));
    if (JSON.stringify(marker) !== JSON.stringify({ version: 1, operationId: plan.operationId, sourceCipherId: plan.sourceCipherId,
      credentialId: copy.credentialId, credentialSha256: copy.credentialSha256, copyId: copy.copyId })) throw invalid();
    const decoded = await decodeBitwardenCipher(raw, 'preservation', accountOrOrganizationKey);
    const passkeys = decoded.items.filter((item): item is PasskeyItem => item.kind === 'passkey');
    if (decoded.warning || decoded.historyWarning || decoded.unsupported || passkeys.length !== 1 || !passkeys[0].privateKeyPkcs8
      || normalizeCredentialId(passkeys[0].credentialId) !== copy.credentialId) throw invalid();
    assertPasskeyCounter(passkeys[0].signCount);
    return passkeys[0];
  } finally { if (cipherKey !== accountOrOrganizationKey) { cipherKey.encKey.fill(0); cipherKey.macKey.fill(0); } }
}

/** A complete discovery scan must fail on unreadable candidate metadata. It
 * includes trash so a deleted copy cannot be mistaken for permission to retry. */
export async function hasBitwardenPasskeyPreservationMarker(copy: BitwardenPasskeyPreservationCopy,
  raw: Record<string, unknown>, accountOrOrganizationKey: BitwardenSymmetricKey): Promise<boolean> {
  const fields = field(raw, 'fields');
  if (fields == null) return false;
  if (!Array.isArray(fields)) throw invalid();
  const cipherKey = await resolveBitwardenCipherKey(raw, accountOrOrganizationKey);
  try {
    let found = false;
    for (const entry of fields) {
      const name = field(object(entry), 'name');
      if (typeof name !== 'string') throw invalid();
      if (await decryptBitwardenString(name, cipherKey) !== BITWARDEN_PASSKEY_PRESERVATION_FIELD) continue;
      const value = field(object(entry), 'value');
      if (typeof value !== 'string') throw invalid();
      const marker = object(JSON.parse(await decryptBitwardenString(value, cipherKey)));
      if (marker.copyId === copy.copyId) found = true;
    }
    return found;
  } finally { if (cipherKey !== accountOrOrganizationKey) { cipherKey.encKey.fill(0); cipherKey.macKey.fill(0); } }
}

/** Re-derive the intended native credentials before using a persisted plan.
 * Marker encryption uses random IVs, so compare its authenticated plaintext
 * through the normal copy verifier instead of comparing regenerated ciphertext. */
export async function verifyBitwardenPasskeyPreservationPlan(plan: BitwardenPasskeyPreservationPlan,
  source: Record<string, unknown>, accountOrOrganizationKey: BitwardenSymmetricKey): Promise<void> {
  const expected = await planBitwardenPasskeyPreservation(plan.operationId, source, accountOrOrganizationKey);
  if (plan.version !== expected.version || plan.sourceCipherId !== expected.sourceCipherId || plan.sourceSha256 !== expected.sourceSha256
    || plan.copies.length !== expected.copies.length) throw invalid();
  for (let index = 0; index < expected.copies.length; index++) {
    const saved = plan.copies[index], original = expected.copies[index];
    if (saved.copyId !== original.copyId || saved.credentialId !== original.credentialId || saved.sourceRemoteId !== original.sourceRemoteId
      || saved.credentialSha256 !== original.credentialSha256) throw invalid();
    const payload = object(parseLosslessJson(saved.payloadJson)), shape = object(parseLosslessJson(original.payloadJson));
    if (JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(Object.keys(shape).sort())
      || JSON.stringify(Object.keys(object(payload.login)).sort()) !== JSON.stringify(Object.keys(object(shape.login)).sort())) throw invalid();
    // Supply the source revision only for the verifier's native schema check;
    // this local validation is not a server-copy readback or creation receipt.
    await verifyBitwardenPasskeyPreservationCopy(expected, original, { ...payload, id: crypto.randomUUID(),
      revisionDate: field(source, 'revisionDate') }, accountOrOrganizationKey);
  }
}
