import { parseLosslessJson } from '../../core/lossless-json';
import { bytesToBase64, randomBytes } from '../../security/encoding';
import { mdbx2TransferOperationScope as hash, assertMdbx2TransferOperationId } from '../mdbx2/mdbx2-transfer-identity';
import { assertWritableBitwardenPasskey, decodeBitwardenCipher, resolveBitwardenCipherKey } from './bitwarden-cipher-codec';
import { decryptBitwardenBytes, decryptBitwardenString, encryptBitwardenBytes, encryptBitwardenString, type BitwardenSymmetricKey } from './bitwarden-crypto';
import { bitwardenRemovalSnapshotSha256 } from './bitwarden-project-removal-transaction';
import { inspectPasskeyKey } from '../../passkey/capability';
import { normalizeCredentialId } from '../../passkey/source-policy';
import { PROJECT_CREDENTIAL_FIELD, rebaseProjectCredentialFields } from '../../core/project-credentials';

export const BITWARDEN_TRANSFER_MARKER = 'monica.cipher-transfer.v1';
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 50_000;
const serverFields = new Set(['id', 'object', 'creationDate', 'revisionDate', 'lastKnownRevisionDate', 'edit', 'viewPassword', 'organizationUseTotp']);
const known: Record<string, Set<string>> = Object.fromEntries(Object.entries({
  root: ['id', 'object', 'type', 'name', 'notes', 'favorite', 'reprompt', 'key', 'organizationId', 'collectionIds', 'folderId', 'fields',
    'login', 'card', 'identity', 'secureNote', 'sshKey', 'attachments', 'passwordHistory', 'archivedDate', 'deletedDate',
    'creationDate', 'revisionDate', 'lastKnownRevisionDate', 'edit', 'viewPassword', 'organizationUseTotp'],
  login: ['username', 'password', 'totp', 'uris', 'fido2Credentials', 'passwordRevisionDate', 'autofillOnPageLoad'],
  fields: ['name', 'value', 'type', 'linkedId'], uris: ['uri', 'match', 'uriChecksum'],
  fido2Credentials: ['credentialId', 'keyType', 'keyAlgorithm', 'keyCurve', 'keyValue', 'rpId', 'rpName', 'counter', 'userHandle', 'userName', 'userDisplayName', 'discoverable', 'creationDate'],
  card: ['cardholderName', 'brand', 'number', 'expMonth', 'expYear', 'code'],
  identity: ['title', 'firstName', 'middleName', 'lastName', 'address1', 'address2', 'address3', 'city', 'state', 'postalCode', 'country', 'company', 'email', 'phone', 'ssn', 'username', 'passportNumber', 'licenseNumber'],
  secureNote: ['type'], sshKey: ['privateKey', 'publicKey', 'keyFingerprint'], passwordHistory: ['password', 'lastUsedDate'],
  attachments: ['id', 'object', 'fileName', 'key', 'size', 'sizeName', 'url']
}).map(([name, fields]) => [name, new Set(fields)]));
const invalid = () => new Error('Bitwarden 完整记录无法无损复制，原记录与附件已保留。');
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
const identifier = (value: unknown): value is string => typeof value === 'string' && Boolean(value) && value.length <= 512 && !/[\u0000-\u001f]/.test(value);
const clear = (key: BitwardenSymmetricKey) => { key.encKey.fill(0); key.macKey.fill(0); };
const rawNumber = (value: unknown) => (JSON as typeof JSON & { isRawJSON?: (value: unknown) => boolean }).isRawJSON?.(value);

/** Canonicalize only known schema names; opaque keys, numeric lexemes and
 * array ordering remain data. Reject alias collisions instead of picking one. */
function canonical(value: unknown, shape = 'root', depth = 0, budget = { nodes: 0 }): unknown {
  if (++budget.nodes > MAX_NODES || depth > 64) throw invalid();
  if (rawNumber(value)) return value;
  if (Array.isArray(value)) return value.map(row => canonical(row, shape, depth + 1, budget));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = Object.create(null);
  for (const [name, child] of Object.entries(value)) {
    const candidate = name[0].toLowerCase() + name.slice(1);
    const key = known[shape]?.has(candidate) ? candidate : name;
    if (Object.prototype.hasOwnProperty.call(result, key)) throw invalid();
    result[key] = canonical(child, known[shape]?.has(key) && known[key] ? key : '', depth + 1, budget);
  }
  return result;
}

/** Unknown encrypted fields are authenticated and re-encrypted too. Merely
 * wrapping a legacy account-wide key would expose unrelated source Ciphers. */
async function rewrite(value: unknown, sourceKey: BitwardenSymmetricKey, targetKey?: BitwardenSymmetricKey): Promise<unknown> {
  if (rawNumber(value)) return targetKey ? value : ['number', JSON.stringify(value)];
  if (Array.isArray(value)) {
    const rows = []; for (const row of value) rows.push(await rewrite(row, sourceKey, targetKey));
    return targetKey ? rows : ['array', rows];
  }
  if (value && typeof value === 'object') {
    const rows: Record<string, unknown> = Object.create(null);
    for (const name of Object.keys(value).sort()) rows[name] = await rewrite((value as Record<string, unknown>)[name], sourceKey, targetKey);
    return targetKey ? rows : ['object', rows];
  }
  if (typeof value === 'string' && /^(?:(?:\d+)?\.)?[A-Za-z0-9+/=_-]+\|/.test(value)) {
    // Integrity is required before exporting unknown field contents to a new account.
    if (!value.startsWith('2.') || value.split('|').length !== 3) throw invalid();
    const bytes = await decryptBitwardenBytes(value, sourceKey);
    try { return targetKey ? await encryptBitwardenBytes(bytes, targetKey) : ['encrypted-bytes', bytesToBase64(bytes)]; }
    finally { bytes.fill(0); }
  }
  return targetKey ? value : [typeof value, value];
}

function content(raw: Record<string, unknown>): Record<string, unknown> {
  const result = object(canonical(raw));
  for (const name of [...serverFields, 'key', 'attachments']) delete result[name];
  if (result.deletedDate == null) delete result.deletedDate;
  return result;
}

export interface BitwardenTransferCipher {
  version: 1;
  operationId: string;
  copyId: string;
  sourceCipherId: string;
  sourceSha256: string;
  targetProviderId: string;
  /** Ciphertext plus nonsecret provider metadata. Persist only in the encrypted vault journal. */
  payloadJson: string;
  contentSha256: string;
  /** Original IDs only route authenticated file reads; never install them on the new Cipher. */
  attachments: Array<{ sourceAttachmentId: string; fileName: string }>;
  credentialIds: string[];
}

/** Use this same normalization on the authenticated source refresh before
 * committing a prepared payload; API casing and expiring file URLs are not edits. */
export function bitwardenTransferSourceSha256(raw: Record<string, unknown>): Promise<string> {
  return bitwardenRemovalSnapshotSha256(object(canonical(raw)));
}

/** A complete native Cipher, including all FIDO2 siblings, OTP, history and
 * unknown fields. Attachments require a separate verified upload before the
 * transfer can be declared complete; this function performs no remote writes. */
export async function prepareBitwardenTransferCipher(input: {
  operationId: string; copyId: string; targetProviderId: string; targetFolderId?: string;
  /** Shared by all records in a copied password project. Never reuse the source project ID. */
  targetProjectId?: string;
  source: Record<string, unknown>; sourceOwnerKey: BitwardenSymmetricKey; targetOwnerKey: BitwardenSymmetricKey;
}): Promise<BitwardenTransferCipher> {
  assertMdbx2TransferOperationId(input.operationId); assertMdbx2TransferOperationId(input.copyId);
  if (!identifier(input.targetProviderId) || input.targetFolderId !== undefined && !identifier(input.targetFolderId)) throw invalid();
  const json = JSON.stringify(input.source);
  if (new TextEncoder().encode(json).length > MAX_JSON_BYTES) throw invalid();
  const source = object(canonical(parseLosslessJson(json)));
  if (!identifier(source.id) || ![1, 2, 3, 4, 5].includes(Number(source.type)) || source.deletedDate
    || typeof source.revisionDate !== 'string' || !Number.isFinite(Date.parse(source.revisionDate))) throw invalid();
  const decoded = await decodeBitwardenCipher(source, 'transfer-source', input.sourceOwnerKey, undefined, { requireReadableProjectMembership: true });
  if (!decoded.items.length || decoded.unsupported || decoded.warning || decoded.historyWarning) throw invalid();
  const sourceLogin = decoded.items.find(row => row.kind === 'login');
  // Graph-wide rebinding requires the enclosing batch's confirmed identities.
  // Until that planner supplies a lossless rewrite, refuse stale source links.
  if (sourceLogin && (sourceLogin.boundNoteEntryId || sourceLogin.boundNoteId != null || sourceLogin.ssoRefLogicalId
    || sourceLogin.ssoRefEntryId != null || sourceLogin.boundTotpItemId))
    throw new Error('此 Bitwarden 记录包含需要整组重建的关联，尚不能单独无损复制。');
  if (sourceLogin?.passwordGroupId) {
    if (!input.targetProjectId || input.targetProjectId === sourceLogin.passwordGroupId) throw new Error('复制完整密码项目必须使用新的项目身份。');
    assertMdbx2TransferOperationId(input.targetProjectId);
  } else if (input.targetProjectId) throw invalid();
  const credentials: string[] = [];
  for (const item of decoded.items) if (item.kind === 'passkey') {
    assertWritableBitwardenPasskey(item);
    if (await inspectPasskeyKey(item.privateKeyPkcs8, item.algorithm) !== 'usable') throw invalid();
    const id = normalizeCredentialId(item.credentialId);
    if (!identifier(id) || credentials.includes(id)) throw invalid();
    credentials.push(id);
  }
  const sourceKey = await resolveBitwardenCipherKey(source, input.sourceOwnerKey);
  const material = randomBytes(64), targetKey = { encKey: material.slice(0, 32), macKey: material.slice(32) };
  try {
    const nativeCredentials = source.login && object(source.login).fido2Credentials;
    if (nativeCredentials != null && (!Array.isArray(nativeCredentials) || nativeCredentials.length !== credentials.length)) throw invalid();
    for (const value of (nativeCredentials || []) as unknown[]) {
      const credential = object(value), rawCounter = credential.counter;
      if (rawCounter != null) {
        if (typeof rawCounter !== 'string') throw invalid();
        const counter = rawCounter.startsWith('2.') ? await decryptBitwardenString(rawCounter, sourceKey) : rawCounter;
        if (!/^\d+$/.test(counter) || !Number.isSafeInteger(Number(counter)) || Number(counter) > 0xffffffff) throw invalid();
      }
    }
    const attachments: BitwardenTransferCipher['attachments'] = [], ids = new Set<string>();
    if (source.attachments != null && !Array.isArray(source.attachments)) throw invalid();
    for (const entry of (source.attachments || []) as unknown[]) {
      const raw = object(entry);
      if (attachments.length >= 512 || Object.keys(raw).some(name => !known.attachments.has(name))
        || !identifier(raw.id) || ids.has(raw.id) || typeof raw.fileName !== 'string') throw invalid();
      const fileName = await decryptBitwardenString(raw.fileName, sourceKey);
      if (!fileName || fileName.length > 1024) throw invalid();
      ids.add(raw.id); attachments.push({ sourceAttachmentId: raw.id, fileName });
    }
    const payload = object(await rewrite(content(source), sourceKey, targetKey));
    if (sourceLogin?.passwordGroupId && input.targetProjectId) {
      const rebased = rebaseProjectCredentialFields(sourceLogin.customFields, input.targetProjectId)
        .find(row => row.name === PROJECT_CREDENTIAL_FIELD);
      if (!rebased || !Array.isArray(payload.fields)) throw invalid();
      let replaced = 0;
      for (const field of payload.fields) {
        const row = object(field);
        if (await decryptBitwardenString(String(row.name), targetKey) !== PROJECT_CREDENTIAL_FIELD) continue;
        row.value = await encryptBitwardenString(rebased.value, targetKey); replaced++;
      }
      if (replaced !== 1) throw invalid();
    }
    payload.key = await encryptBitwardenBytes(material, input.targetOwnerKey);
    payload.organizationId = null; payload.collectionIds = null; payload.folderId = input.targetFolderId || null;
    const sourceSha256 = await bitwardenTransferSourceSha256(source);
    const marker = { version: 1, operationId: input.operationId, copyId: input.copyId, sourceSha256, targetProviderId: input.targetProviderId };
    if (payload.fields != null && !Array.isArray(payload.fields)) throw invalid();
    payload.fields = [...((payload.fields || []) as unknown[]), { type: 1,
      name: await encryptBitwardenString(BITWARDEN_TRANSFER_MARKER, targetKey), value: await encryptBitwardenString(JSON.stringify(marker), targetKey) }];
    const payloadJson = JSON.stringify(payload);
    if (new TextEncoder().encode(payloadJson).length > MAX_JSON_BYTES) throw invalid();
    return { version: 1, operationId: input.operationId, copyId: input.copyId, sourceCipherId: source.id, sourceSha256,
      targetProviderId: input.targetProviderId, payloadJson, contentSha256: await hash(await rewrite(content(payload), targetKey)),
      attachments, credentialIds: credentials };
  } finally { material.fill(0); clear(targetKey); if (sourceKey !== input.sourceOwnerKey) clear(sourceKey); }
}

/** Server readback proves Cipher content only. Attachment byte verification and
 * atomic vault adoption belong to the enclosing transfer transaction. */
export async function verifyBitwardenTransferCipher(plan: BitwardenTransferCipher, raw: Record<string, unknown>, targetOwnerKey: BitwardenSymmetricKey) {
  assertMdbx2TransferOperationId(plan.operationId); assertMdbx2TransferOperationId(plan.copyId);
  if (plan.version !== 1 || !identifier(plan.targetProviderId) || !identifier(plan.sourceCipherId)
    || !/^[a-f0-9]{64}$/.test(plan.sourceSha256) || !/^[a-f0-9]{64}$/.test(plan.contentSha256)
    || typeof plan.payloadJson !== 'string' || new TextEncoder().encode(plan.payloadJson).length > MAX_JSON_BYTES
    || new TextEncoder().encode(JSON.stringify(raw)).length > MAX_JSON_BYTES) throw invalid();
  const expected = object(canonical(parseLosslessJson(plan.payloadJson)));
  const expectedKey = await resolveBitwardenCipherKey(expected, targetOwnerKey);
  try {
    if (typeof expected.key !== 'string' || expected.organizationId !== null || expected.collectionIds !== null
      || await hash(await rewrite(content(expected), expectedKey)) !== plan.contentSha256
      || !await hasBitwardenTransferMarker(plan, expected, targetOwnerKey)) throw invalid();
    const fields = expected.fields;
    if (!Array.isArray(fields)) throw invalid();
    let sourceBound = false;
    for (const field of fields) {
      const row = object(field);
      if (await decryptBitwardenString(String(row.name), expectedKey) !== BITWARDEN_TRANSFER_MARKER) continue;
      const marker = object(parseLosslessJson(await decryptBitwardenString(String(row.value), expectedKey)));
      if (marker.operationId === plan.operationId && marker.copyId === plan.copyId && marker.targetProviderId === plan.targetProviderId
        && marker.sourceSha256 === plan.sourceSha256) sourceBound = true;
    }
    if (!sourceBound) throw invalid();
  } finally { if (expectedKey !== targetOwnerKey) clear(expectedKey); }
  const candidate = object(canonical(raw));
  if (!identifier(candidate.id) || candidate.id === plan.sourceCipherId || candidate.deletedDate
    || typeof candidate.revisionDate !== 'string' || !Number.isFinite(Date.parse(candidate.revisionDate))) throw invalid();
  const key = await resolveBitwardenCipherKey(candidate, targetOwnerKey);
  try {
    if (await hash(await rewrite(content(candidate), key)) !== plan.contentSha256) throw invalid();
    const decoded = await decodeBitwardenCipher(candidate, plan.targetProviderId, targetOwnerKey, undefined, { requireReadableProjectMembership: true });
    if (decoded.warning || decoded.historyWarning || decoded.unsupported) throw invalid();
    const ids = decoded.items.filter(row => row.kind === 'passkey').map(row => normalizeCredentialId(row.credentialId));
    if (JSON.stringify(ids) !== JSON.stringify(plan.credentialIds)) throw invalid();
    return decoded.items;
  } finally { if (key !== targetOwnerKey) clear(key); }
}

/** Search includes trash; a deleted or edited copy is never permission to create
 * it again. Unreadable markers stop recovery instead of looking like absence. */
export async function hasBitwardenTransferMarker(plan: Pick<BitwardenTransferCipher, 'operationId' | 'copyId' | 'targetProviderId'>,
  raw: Record<string, unknown>, targetOwnerKey: BitwardenSymmetricKey): Promise<boolean> {
  const candidate = object(canonical(raw)), fields = candidate.fields;
  if (fields == null) return false;
  if (!Array.isArray(fields) || fields.length > 10_000) throw invalid();
  const key = await resolveBitwardenCipherKey(candidate, targetOwnerKey);
  try {
    let found = false;
    for (const field of fields) {
      const row = object(field);
      if (typeof row.name !== 'string') throw invalid();
      if (await decryptBitwardenString(row.name, key) !== BITWARDEN_TRANSFER_MARKER) continue;
      if (typeof row.value !== 'string') throw invalid();
      const marker = object(parseLosslessJson(await decryptBitwardenString(row.value, key)));
      if (marker.version === 1 && marker.operationId === plan.operationId && marker.copyId === plan.copyId && marker.targetProviderId === plan.targetProviderId) found = true;
    }
    return found;
  } finally { if (key !== targetOwnerKey) clear(key); }
}
