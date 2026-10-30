import { describe, expect, it, vi } from 'vitest';
import { createLoginItem, type PasskeyItem } from '../../core/model';
import { cloneLosslessJson, parseLosslessJson } from '../../core/lossless-json';
import { bytesToBase64 } from '../../security/encoding';
import { encodeBitwardenCipher, encodeBitwardenPasskeyCipher } from './bitwarden-cipher-codec';
import { decryptBitwardenString, encryptBitwardenBytes, encryptBitwardenString } from './bitwarden-crypto';
import { planBitwardenPasskeyPreservation, verifyBitwardenPasskeyPreservationCopy, verifyBitwardenPasskeyPreservationPlan } from './bitwarden-passkey-preservation';
import { assertBitwardenPasskeyPreservationTransition, BitwardenPasskeyPreservationTransaction,
  type BitwardenPasskeyPreservationJournal, type BitwardenPasskeyPreservationRemote, type BitwardenPasskeyPreservationStore } from './bitwarden-passkey-preservation-transaction';

const date = '2026-10-09T12:00:00.000Z';
const key = () => ({ encKey: crypto.getRandomValues(new Uint8Array(32)), macKey: crypto.getRandomValues(new Uint8Array(32)) });
async function fixture(wrapped = true, count = 2) {
  const vaultKey = key(), cipherKey = wrapped ? key() : vaultKey;
  const source: Record<string, unknown> = { ...await encodeBitwardenCipher({ ...createLoginItem({ title: 'Project source', username: 'source-user', password: 'Remove this password', notes: '  Original notes\r\n中文  ' }),
    totpSecret: 'otpauth://totp/Synthetic?secret=JBSWY3DPEHPK3PXP', passwordHistory: [{ password: 'Historical password', lastUsedAt: date }] }, cipherKey),
    id: crypto.randomUUID(), creationDate: date, revisionDate: date,
    key: wrapped ? await encryptBitwardenBytes(new Uint8Array([...cipherKey.encKey, ...cipherKey.macKey]), vaultKey) : null };
  // Imported native notes can contain whitespace which the new-item factory trims.
  source.notes = await encryptBitwardenString('  Original notes\r\n中文  ', cipherKey);
  const originals: PasskeyItem[] = [], publicKeys: CryptoKey[] = [], credentials: Record<string, unknown>[] = [];
  for (let index = 0; index < count; index++) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    publicKeys.push(pair.publicKey);
    const item: PasskeyItem = { id: crypto.randomUUID(), kind: 'passkey', title: 'Synthetic RP', notes: '  Original notes\r\n中文  ', favorite: false,
      createdAt: date, updatedAt: date, providerRefs: [], credentialId: index ? bytesToBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '') : crypto.randomUUID(),
      rpId: 'example.invalid', rpName: 'Synthetic RP', userHandle: 'c3ludGhldGlj', userName: `synthetic-${index}`, userDisplayName: 'Synthetic user',
      algorithm: -7, publicKey: '', privateKeyPkcs8: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))),
      signCount: index ? 23 : 0, discoverable: true, sourceMode: 'bitwarden' };
    originals.push(item);
    const body = await encodeBitwardenPasskeyCipher(item, cipherKey), native = (body.login as Record<string, unknown>).fido2Credentials as Record<string, unknown>[];
    native[0].futureEncrypted = await encryptBitwardenString('Future encrypted attribute', cipherKey);
    native[0].futureData = parseLosslessJson('{"integer":9007199254740993,"rawJSON":"ordinary","empty":null,"negativeZero":-0,"decimal":1.2300}');
    native[0]['__proto__'] = 'literal prototype key';
    // Define an own JSON key; assignment on an ordinary object would invoke the legacy setter.
    Object.defineProperty(native[0], '__proto__', { value: { kept: true }, enumerable: true });
    credentials.push(native[0]);
  }
  (source.login as Record<string, unknown>).fido2Credentials = credentials;
  const operationId = crypto.randomUUID(), plan = await planBitwardenPasskeyPreservation(operationId, source, vaultKey);
  const serverCopy = (index: number): Record<string, unknown> => ({ ...(parseLosslessJson(plan.copies[index].payloadJson) as Record<string, unknown>),
    id: crypto.randomUUID(), creationDate: date, revisionDate: date });
  return { source, vaultKey, cipherKey, originals, publicKeys, operationId, plan, serverCopy };
}

describe('lossless native Bitwarden Passkey preservation', () => {
  it.each(['unchanged', 'credential', 'password', 'extra', 'wrong-source-ref'] as const)('checks persisted %s plans against original native bytes', async mode => {
    const f = await fixture(true, 1), plan = structuredClone(f.plan);
    const payload = parseLosslessJson(plan.copies[0].payloadJson) as Record<string, unknown>, login = payload.login as Record<string, unknown>;
    if (mode === 'credential') (login.fido2Credentials as Record<string, unknown>[])[0].counter = await encryptBitwardenString('1', f.cipherKey);
    if (mode === 'password') login.password = (f.source.login as Record<string, unknown>).password;
    if (mode === 'extra') payload.futureSecret = 'Unexpected';
    if (mode === 'wrong-source-ref') plan.copies[0].sourceRemoteId += '-wrong';
    plan.copies[0].payloadJson = JSON.stringify(payload);
    if (mode === 'unchanged') await expect(verifyBitwardenPasskeyPreservationPlan(plan, f.source, f.vaultKey)).resolves.toBeUndefined();
    else await expect(verifyBitwardenPasskeyPreservationPlan(plan, f.source, f.vaultKey)).rejects.toThrow();
  });

  it.each([false, true])('copies exact credential ciphertext and signs with unchanged identity, wrapped key=%s', async wrapped => {
    const f = await fixture(wrapped), originalJson = JSON.stringify(f.source);
    expect(f.plan.copies).toHaveLength(2);
    for (let index = 0; index < 2; index++) {
      const copy = f.plan.copies[index], raw = f.serverCopy(index);
      const observed = await verifyBitwardenPasskeyPreservationCopy(f.plan, copy, raw, f.vaultKey);
      expect(observed.privateKeyPkcs8).toBe(f.originals[index].privateKeyPkcs8);
      expect(observed.signCount).toBe(f.originals[index].signCount); expect(observed.notes).toBe(f.originals[index].notes);
      expect(observed.notes).toBe(await decryptBitwardenString(f.source.notes as string, f.cipherKey));
      expect(observed.credentialId).toBe(f.plan.copies[index].credentialId);
      const signingKey = await crypto.subtle.importKey('pkcs8', Buffer.from(observed.privateKeyPkcs8!, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, challenge);
      expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, f.publicKeys[index], signature, challenge)).toBe(true);
      const login = raw.login as Record<string, unknown>, credential = (login.fido2Credentials as Record<string, unknown>[])[0];
      expect(await decryptBitwardenString(credential.futureEncrypted as string, f.cipherKey)).toBe('Future encrypted attribute');
      expect(copy.payloadJson).toContain('9007199254740993'); expect(copy.payloadJson).toContain('1.2300'); expect(copy.payloadJson).toContain('"negativeZero":-0');
      expect(copy.payloadJson).toContain('"__proto__":{"kept":true}');
      expect(login.password).toBeNull(); expect(login.totp).toBeNull(); expect(raw.passwordHistory).toBeUndefined();
      expect(copy.payloadJson).not.toContain((f.source.login as Record<string, unknown>).password as string);
    }
    expect(JSON.stringify(f.source)).toBe(originalJson);
    expect((await planBitwardenPasskeyPreservation(f.operationId, f.source, f.vaultKey)).copies.map(row => row.copyId)).toEqual(f.plan.copies.map(row => row.copyId));
  });

  it('accepts PascalCase native fields while preserving unknown field names and the same key domain', async () => {
    const f = await fixture(true, 1), source = cloneLosslessJson(f.source);
    source.organizationId = 'organization'; source.collectionIds = ['collection']; source.folderId = 'folder';
    const login = source.login as Record<string, unknown>, native = (login.fido2Credentials as Record<string, unknown>[])[0];
    native.CredentialId = native.credentialId; delete native.credentialId;
    login.Uris = [{ Uri: await encryptBitwardenString('https://example.invalid', f.cipherKey), Match: null }]; delete login.uris;
    const plan = await planBitwardenPasskeyPreservation(f.operationId, source, f.vaultKey);
    const raw: Record<string, unknown> = { ...(parseLosslessJson(plan.copies[0].payloadJson) as Record<string, unknown>), id: crypto.randomUUID(), revisionDate: date };
    expect((await verifyBitwardenPasskeyPreservationCopy(plan, plan.copies[0], raw, f.vaultKey)).privateKeyPkcs8).toBe(f.originals[0].privateKeyPkcs8);
    expect(raw.organizationId).toBe('organization'); expect(raw.collectionIds).toEqual(['collection']);
  });

  it.each(['duplicate', 'invalid-counter', 'missing-key', 'legacy-only', 'conflicting-alias', 'trashed'] as const)('refuses %s without touching the source', async mode => {
    const f = await fixture(true, 1), login = f.source.login as Record<string, unknown>, native = (login.fido2Credentials as Record<string, unknown>[])[0];
    if (mode === 'duplicate') login.fido2Credentials = [native, cloneLosslessJson(native)];
    if (mode === 'invalid-counter') native.counter = await encryptBitwardenString('not-a-counter', f.cipherKey);
    if (mode === 'missing-key') native.keyValue = null;
    if (mode === 'legacy-only') { login.fido2Credentials = []; f.source.name = await encryptBitwardenString('Legacy [Passkey]', f.cipherKey); }
    if (mode === 'conflicting-alias') native.CredentialId = await encryptBitwardenString(crypto.randomUUID(), f.cipherKey);
    if (mode === 'trashed') Object.assign(f.source, { deletedDate: date });
    const before = JSON.stringify(f.source);
    await expect(planBitwardenPasskeyPreservation(f.operationId, f.source, f.vaultKey)).rejects.toThrow();
    expect(JSON.stringify(f.source)).toBe(before);
  });

  it.each(['counter', 'unknown', 'marker', 'notes', 'organization', 'key', 'source-id', 'password', 'history', 'trash'] as const)('rejects a changed %s in the preservation readback', async mode => {
    const f = await fixture(true, 1), copy = f.plan.copies[0], raw = f.serverCopy(0), login = raw.login as Record<string, unknown>;
    if (mode === 'counter') (login.fido2Credentials as Record<string, unknown>[])[0].counter = await encryptBitwardenString('1', f.cipherKey);
    if (mode === 'unknown') delete (login.fido2Credentials as Record<string, unknown>[])[0].futureData;
    if (mode === 'marker') (raw.fields as Record<string, unknown>[])[0].value = await encryptBitwardenString('{}', f.cipherKey);
    if (mode === 'notes') raw.notes = await encryptBitwardenString('Changed notes', f.cipherKey);
    if (mode === 'organization') raw.organizationId = 'different-domain';
    if (mode === 'key') raw.key = null;
    if (mode === 'source-id') raw.id = f.plan.sourceCipherId;
    if (mode === 'password') login.password = (f.source.login as Record<string, unknown>).password;
    if (mode === 'history') raw.passwordHistory = f.source.passwordHistory;
    if (mode === 'trash') raw.deletedDate = date;
    await expect(verifyBitwardenPasskeyPreservationCopy(f.plan, copy, raw, f.vaultKey)).rejects.toThrow();
  });
});

async function transactionFixture() {
  const f = await fixture(true, 1);
  const encryptionKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  let ciphertext: ArrayBuffer, iv: Uint8Array<ArrayBuffer>;
  const persist = async (value: BitwardenPasskeyPreservationJournal) => {
    iv = crypto.getRandomValues(new Uint8Array(12));
    ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encryptionKey, new TextEncoder().encode(JSON.stringify(value)));
  };
  const store: BitwardenPasskeyPreservationStore = {
    read: async () => JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, encryptionKey, ciphertext))),
    update: async (revision, value) => {
      const before = await store.read(); expect(before.revision).toBe(revision);
      assertBitwardenPasskeyPreservationTransition(before, value); await persist(value);
    }
  };
  await persist({ version: 1, revision: 1, plan: f.plan, copies: f.plan.copies.map(copy => ({ copyId: copy.copyId, stage: 'ready' })) });
  const copies: Record<string, unknown>[] = [];
  const remote: BitwardenPasskeyPreservationRemote = {
    readSource: async () => cloneLosslessJson(f.source), findCopies: async () => cloneLosslessJson(copies),
    createCopy: vi.fn(async () => { const copy = f.serverCopy(0); copies.push(copy); return cloneLosslessJson(copy); }),
    verifyCopy: (copy, raw) => verifyBitwardenPasskeyPreservationCopy(f.plan, copy, raw, f.vaultKey)
  };
  return { ...f, store, remote, copies, run: () => new BitwardenPasskeyPreservationTransaction(store, remote).resume(), encrypted: () => bytesToBase64(new Uint8Array(ciphertext)) };
}

describe('journaled Passkey preservation creation', () => {
  it.each(['complete', 'response-loss', 'verified-save-loss'] as const)('recovers %s using encrypted intent without duplicate creation', async mode => {
    const f = await transactionFixture(), create = f.remote.createCopy, update = f.store.update;
    let injected = false;
    if (mode === 'response-loss') f.remote.createCopy = vi.fn(async copy => { const result = await create(copy); if (!injected) { injected = true; throw new Error('Synthetic response loss'); } return result; });
    if (mode === 'verified-save-loss') f.store.update = async (revision, journal) => {
      if (journal.copies[0].stage === 'verified' && !injected) { injected = true; throw new Error('Synthetic save loss'); } await update(revision, journal);
    };
    if (mode !== 'complete') { await expect(f.run()).rejects.toThrow('Synthetic'); expect((await f.store.read()).copies[0].stage).toBe('attempted'); }
    expect((await f.run()).copies[0].stage).toBe('verified');
    expect((await f.run()).copies[0].remoteId).toBe(f.copies[0].id);
    expect(create).toHaveBeenCalledTimes(1); expect(f.encrypted()).not.toContain(f.plan.copies[0].copyId);
  });

  it('sends no create if the attempted intent cannot be saved', async () => {
    const f = await transactionFixture(), before = f.encrypted(); f.store.update = async () => { throw new Error('Synthetic intent failure'); };
    await expect(f.run()).rejects.toThrow('intent failure'); expect(f.remote.createCopy).not.toHaveBeenCalled(); expect(f.encrypted()).toBe(before);
  });

  it('does not retry an attempted create that cannot be found after restart', async () => {
    const f = await transactionFixture(); f.remote.createCopy = vi.fn(async () => { throw new Error('Synthetic unknown result'); });
    await expect(f.run()).rejects.toThrow('unknown result'); await expect(f.run()).rejects.toThrow('停止重复创建');
    expect(f.remote.createCopy).toHaveBeenCalledTimes(1);
  });

  it.each(['source-change', 'duplicate-copy', 'lost-copy', 'changed-copy'] as const)('stops for %s after a copy has been verified', async mode => {
    const f = await transactionFixture(); await f.run();
    if (mode === 'source-change') f.source.notes = await encryptBitwardenString('New source note', f.cipherKey);
    if (mode === 'duplicate-copy') f.copies.push({ ...cloneLosslessJson(f.copies[0]), id: crypto.randomUUID() });
    if (mode === 'lost-copy') f.copies.length = 0;
    if (mode === 'changed-copy') f.copies[0].notes = await encryptBitwardenString('New copy note', f.cipherKey);
    await expect(f.run()).rejects.toThrow(); expect(f.remote.createCopy).toHaveBeenCalledTimes(1);
  });
});
