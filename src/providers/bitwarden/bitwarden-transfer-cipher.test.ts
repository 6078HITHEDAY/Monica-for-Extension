import { expect, it } from 'vitest';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createPasskey, createAssertion } from '../../passkey/webauthn-core';
import { parseLosslessJson } from '../../core/lossless-json';
import type { LoginItem, PasskeyItem } from '../../core/model';
import { encodeBitwardenCipher, encodeBitwardenPasskeyCipher, resolveBitwardenCipherKey } from './bitwarden-cipher-codec';
import { decryptBitwardenBytes, decryptBitwardenString, encryptBitwardenBytes, encryptBitwardenString, type BitwardenSymmetricKey } from './bitwarden-crypto';
import { BITWARDEN_TRANSFER_MARKER, prepareBitwardenTransferCipher, verifyBitwardenTransferCipher, hasBitwardenTransferMarker, bitwardenTransferSourceSha256 } from './bitwarden-transfer-cipher';

const key = (seed: number): BitwardenSymmetricKey => ({ encKey: new Uint8Array(32).fill(seed), macKey: new Uint8Array(32).fill(seed + 1) });
const sourceOwnerKey = key(12), targetOwnerKey = key(42), stamp = '2026-10-12T00:00:00.000Z';
const operationId = '11111111-1111-4111-8111-111111111111', copyId = '22222222-2222-4222-8222-222222222222';
const targetProjectId = '33333333-3333-4333-8333-333333333333';
const challenge = Buffer.alloc(32, 23).toString('base64url'), origin = 'https://copy.example.test';

it.each(['monica_sso_ref_entry_id', 'monica_sso_ref_logical_id'])('refuses unresolved source graph links (%s)', async name => {
  const f = await fixture(false);
  (f.raw.fields as unknown[]).push({ type: 1, name: await encryptBitwardenString(name, sourceOwnerKey),
    value: await encryptBitwardenString(name.endsWith('entry_id') ? '7' : 'password:source-only-identity', sourceOwnerKey) });
  await expect(prepareBitwardenTransferCipher(f.input)).rejects.toThrow('整组重建');
});

async function fixture(wrapped: boolean) {
  const cipherKey = wrapped ? key(26) : sourceOwnerKey;
  const login: LoginItem = { id: 'source-local', kind: 'login', title: 'Complete project', username: 'synthetic', password: 'private password',
    favorite: true, notes: 'private notes', createdAt: stamp, updatedAt: stamp, providerRefs: [], uris: [origin],
    totpSecret: 'otpauth://hotp/Test?secret=JBSWY3DPEHPK3PXP&counter=17', customFields: [
      { name: 'Repeated', value: 'first', protected: true }, { name: 'Repeated', value: 'second', protected: false },
      { name: 'monica.content.credential', protected: true, value: JSON.stringify({ version: 1, projectId: operationId, groupId: operationId,
        passwordId: copyId, label: 'Accounts', primary: true, groupOrder: 0, passwordOrder: 0 }) }],
    passwordHistory: [{ password: 'old password', lastUsedAt: stamp }] };
  let raw = await encodeBitwardenCipher(login, cipherKey);
  const passkeys: Array<{ item: PasskeyItem; spki: string }> = [];
  for (let index = 0; index < 2; index++) {
    const created = await createPasskey({ origin, challenge, rpName: 'Synthetic', userId: 'dXNlcg', userName: `user-${index}`,
      userDisplayName: `User ${index}`, algorithms: [-7], excludeCredentialIds: [], credentialIdFormat: 'uuid' });
    const item: PasskeyItem = { ...login, id: `passkey-${index}`, kind: 'passkey', credentialId: created.credentialId,
      rpId: 'copy.example.test', rpName: 'Synthetic', userHandle: 'dXNlcg', userName: `user-${index}`, userDisplayName: `User ${index}`,
      privateKeyPkcs8: created.privateKeyPkcs8, publicKey: created.publicKeySpki, algorithm: -7, signCount: index ? 19 : 0, discoverable: true,
      sourceMode: 'bitwarden' };
    raw = await encodeBitwardenPasskeyCipher(item, cipherKey, raw); passkeys.push({ item, spki: created.publicKeySpki });
  }
  raw = { ...raw, id: 'source-cipher', revisionDate: stamp, creationDate: stamp, folderId: 'source-folder', organizationId: 'source-organization',
    collectionIds: ['source-collection'], archivedDate: stamp, attachments: [{ id: 'original-file', fileName: await encryptBitwardenString('important.bin', cipherKey),
      key: await encryptBitwardenBytes(new Uint8Array(64).fill(63), cipherKey), size: '81', sizeName: '81 B', url: 'https://source.example.invalid/temporary' }],
    FutureNativeField: { binary: await encryptBitwardenBytes(new Uint8Array([255, 0, 42]), cipherKey), ordered: [null, '', false, 0],
      integer: (parseLosslessJson('{"n":18446744073709551615}') as Record<string, unknown>).n } };
  if (wrapped) raw.key = await encryptBitwardenBytes(new Uint8Array([...cipherKey.encKey, ...cipherKey.macKey]), sourceOwnerKey);
  return { raw, cipherKey, passkeys, input: { operationId, copyId, targetProjectId, targetProviderId: 'destination', targetFolderId: 'target-folder',
    source: raw, sourceOwnerKey, targetOwnerKey } };
}

it.each([false, true])('copies a complete native Cipher across accounts without leaking the source key (wrapped=%s)', async wrapped => {
  const f = await fixture(wrapped), original = JSON.stringify(f.raw);
  const ownerBefore = Buffer.from([...sourceOwnerKey.encKey, ...sourceOwnerKey.macKey]);
  const plan = await prepareBitwardenTransferCipher(f.input), payload = JSON.parse(plan.payloadJson);
  expect(JSON.stringify(f.raw)).toBe(original);
  const differentlyCased = { ...f.raw, Name: f.raw.name }; delete (differentlyCased as Record<string, unknown>).name;
  expect(await bitwardenTransferSourceSha256(differentlyCased)).toBe(plan.sourceSha256);
  expect(Buffer.from([...sourceOwnerKey.encKey, ...sourceOwnerKey.macKey])).toEqual(ownerBefore);
  expect(payload).toMatchObject({ organizationId: null, collectionIds: null, folderId: 'target-folder', archivedDate: stamp });
  for (const property of ['id', 'revisionDate', 'creationDate', 'attachments']) expect(payload[property]).toBeUndefined();
  expect(plan.attachments).toEqual([{ sourceAttachmentId: 'original-file', fileName: 'important.bin' }]);
  const targetKey = await resolveBitwardenCipherKey(payload, targetOwnerKey);
  try {
    expect(targetKey.encKey).not.toEqual(f.cipherKey.encKey); expect(targetKey.encKey).not.toEqual(sourceOwnerKey.encKey);
    expect(await decryptBitwardenString(payload.login.password, targetKey)).toBe('private password');
    expect(await decryptBitwardenBytes(payload.FutureNativeField.binary, targetKey)).toEqual(new Uint8Array([255, 0, 42]));
    expect(payload.FutureNativeField.ordered).toEqual([null, '', false, 0]);
    expect(plan.payloadJson).toContain('18446744073709551615');
    expect(plan.payloadJson).not.toContain('source-collection'); expect(plan.payloadJson).not.toContain('private password');
    await expect(decryptBitwardenString(payload.login.password, sourceOwnerKey)).rejects.toThrow();
    await expect(decryptBitwardenString(f.raw.name as string, targetKey)).rejects.toThrow();
  } finally { targetKey.encKey.fill(0); targetKey.macKey.fill(0); }
  const returned = { ...parseLosslessJson(plan.payloadJson) as Record<string, unknown>, id: 'new-cipher', revisionDate: stamp, creationDate: stamp };
  const items = await verifyBitwardenTransferCipher(plan, returned, targetOwnerKey);
  expect(items.map(row => row.kind)).toEqual(['login', 'totp', 'passkey', 'passkey']);
  expect(items.find(row => row.kind === 'login')).toMatchObject({ password: 'private password', notes: 'private notes',
    passwordHistory: [{ password: 'old password', lastUsedAt: stamp }], passwordGroupId: targetProjectId });
  expect(items.find(row => row.kind === 'totp')).toMatchObject({ counter: 17 });
  expect(await hasBitwardenTransferMarker(plan, returned, targetOwnerKey)).toBe(true);
  expect(await hasBitwardenTransferMarker({ ...plan, copyId: crypto.randomUUID() }, returned, targetOwnerKey)).toBe(false);
  for (const row of f.passkeys) {
    const copied = items.find(item => item.kind === 'passkey' && item.credentialId === row.item.credentialId) as PasskeyItem;
    expect(Buffer.from(copied.privateKeyPkcs8!, 'base64')).toEqual(Buffer.from(row.item.privateKeyPkcs8!, 'base64'));
    expect(copied.signCount).toBe(row.item.signCount);
    const assertion = await createAssertion({ origin, challenge, rpId: copied.rpId, credentialId: copied.credentialId,
      userHandle: copied.userHandle, privateKeyPkcs8: copied.privateKeyPkcs8!, signCount: copied.signCount });
    const auth = Buffer.from(assertion.response.authenticatorData, 'base64url'), client = Buffer.from(assertion.response.clientDataJSON, 'base64url');
    expect(verify('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]),
      createPublicKey({ key: Buffer.from(row.spki, 'base64'), format: 'der', type: 'spki' }), Buffer.from(assertion.response.signature, 'base64url'))).toBe(true);
  }
});

it.each(['wrong-owner', 'changed-password', 'lost-sibling', 'changed-unknown', 'wrong-folder', 'deleted', 'changed-plan', 'changed-source-proof'])(
  'rejects unconfirmed native copy readback: %s', async scenario => {
    const f = await fixture(true), plan = await prepareBitwardenTransferCipher(f.input);
    const returned = { ...parseLosslessJson(plan.payloadJson) as Record<string, unknown>, id: 'new-cipher', revisionDate: stamp } as Record<string, any>;
    const cipherKey = await resolveBitwardenCipherKey(returned, targetOwnerKey);
    try {
      if (scenario === 'changed-password') returned.login.password = await encryptBitwardenString('changed', cipherKey);
      if (scenario === 'lost-sibling') returned.login.fido2Credentials.pop();
      if (scenario === 'changed-unknown') delete returned.FutureNativeField;
      if (scenario === 'wrong-folder') returned.folderId = 'elsewhere';
      if (scenario === 'deleted') returned.deletedDate = stamp;
      if (scenario === 'changed-plan') plan.payloadJson = JSON.stringify({ ...returned, favorite: false });
      if (scenario === 'changed-source-proof') plan.sourceSha256 = '0'.repeat(64);
      await expect(verifyBitwardenTransferCipher(plan, returned, scenario === 'wrong-owner' ? sourceOwnerKey : targetOwnerKey)).rejects.toThrow();
      // Even edited/deleted copies still carry their operation identity; never recreate them.
      if (scenario === 'deleted' || scenario === 'changed-password') expect(await hasBitwardenTransferMarker(plan, returned, targetOwnerKey)).toBe(true);
    } finally { cipherKey.encKey.fill(0); cipherKey.macKey.fill(0); }
  }
);

it.each(['alias', 'unreadable-unknown', 'bare-cipher', 'future-attachment', 'invalid-counter', 'duplicate-credential', 'same-project'])(
  'rejects incomplete or ambiguous source data before any write: %s', async scenario => {
    const f = await fixture(false), source = f.raw as Record<string, any>;
    if (scenario === 'alias') source.Name = source.name;
    if (scenario === 'unreadable-unknown') source.FutureNativeField.binary = '2.bad|bad|bad';
    if (scenario === 'bare-cipher') source.FutureNativeField.binary = source.FutureNativeField.binary.slice(2);
    if (scenario === 'future-attachment') source.attachments[0].FutureAnnotation = 'not yet transferable';
    if (scenario === 'invalid-counter') source.login.fido2Credentials[0].counter = await encryptBitwardenString('invalid', f.cipherKey);
    if (scenario === 'duplicate-credential') source.login.fido2Credentials.push(source.login.fido2Credentials[0]);
    if (scenario === 'same-project') f.input.targetProjectId = operationId;
    const original = JSON.stringify(source);
    await expect(prepareBitwardenTransferCipher(f.input)).rejects.toThrow(); expect(JSON.stringify(source)).toBe(original);
  }
);

it('retains previous operation markers when a completed copy is copied again', async () => {
  const f = await fixture(false), first = await prepareBitwardenTransferCipher(f.input);
  const source = { ...parseLosslessJson(first.payloadJson) as Record<string, unknown>, id: 'first-copy', revisionDate: stamp };
  const next = await prepareBitwardenTransferCipher({ ...f.input, source, sourceOwnerKey: targetOwnerKey,
    targetOwnerKey: sourceOwnerKey, operationId: crypto.randomUUID(), copyId: crypto.randomUUID(), targetProjectId: crypto.randomUUID(), targetProviderId: 'third-vault' });
  const raw: Record<string, unknown> = { ...parseLosslessJson(next.payloadJson) as Record<string, unknown>, id: 'second-copy', revisionDate: stamp };
  expect(await hasBitwardenTransferMarker(first, raw, sourceOwnerKey)).toBe(true);
  expect(await hasBitwardenTransferMarker(next, raw, sourceOwnerKey)).toBe(true);
  await expect(verifyBitwardenTransferCipher(next, raw, sourceOwnerKey)).resolves.toHaveLength(4);
  const targetKey = await resolveBitwardenCipherKey(raw, sourceOwnerKey);
  try {
    const names = await Promise.all((raw.fields as Array<{ name: string }>).map(row => decryptBitwardenString(row.name, targetKey)));
    expect(names.filter(name => name === BITWARDEN_TRANSFER_MARKER)).toHaveLength(2);
  } finally { targetKey.encKey.fill(0); targetKey.macKey.fill(0); }
});

it.each([2, 3, 4, 5])('re-encrypts complete native type %s without reinterpreting its opaque extensions', async type => {
  const encrypted = (value: string) => encryptBitwardenString(value, sourceOwnerKey);
  const source: Record<string, unknown> = { id: `native-${type}`, type, name: await encrypted('Synthetic'), notes: await encrypted('Private notes'),
    revisionDate: stamp, favorite: false, fields: [{ type: 1, name: await encrypted('Custom'), value: await encrypted('Value') }],
    UnknownPrivateExtension: await encrypted('Preserve all bytes') };
  if (type === 2) source.secureNote = { type: 0 };
  if (type === 3) source.card = { number: await encrypted('4111111111111111'), code: await encrypted('123'), FutureCardField: await encrypted('card extension') };
  if (type === 4) source.identity = { firstName: await encrypted('Synthetic'), passportNumber: await encrypted('TEST-ONLY') };
  if (type === 5) source.sshKey = { privateKey: await encrypted('synthetic private key'), publicKey: await encrypted('synthetic public key'), keyFingerprint: await encrypted('synthetic fingerprint') };
  const plan = await prepareBitwardenTransferCipher({ operationId, copyId, targetProviderId: 'destination', source, sourceOwnerKey, targetOwnerKey });
  const returned: Record<string, unknown> = { ...parseLosslessJson(plan.payloadJson) as Record<string, unknown>, id: 'destination-cipher', revisionDate: stamp };
  const result = await verifyBitwardenTransferCipher(plan, returned, targetOwnerKey);
  expect(result).toHaveLength(1); expect(result[0].kind).toBe(({ 2: 'secure-note', 3: 'card', 4: 'identity', 5: 'login' } as Record<number, string>)[type]);
  const key = await resolveBitwardenCipherKey(returned, targetOwnerKey);
  try { expect(await decryptBitwardenString(String(returned.UnknownPrivateExtension), key)).toBe('Preserve all bytes'); }
  finally { key.encKey.fill(0); key.macKey.fill(0); }
});
