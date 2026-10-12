// Synthetic-origin harness; never exposed by extension runtime messages or dist.
import { SecureVaultService } from '../../../src/security/secure-vault-service';
import { IndexedDbVaultStorage } from '../../../src/security/vault-storage';
import { MemoryVaultSessionStore } from '../../../src/security/vault-session';
import { createLoginItem, type PasskeyItem, type ProviderAccount } from '../../../src/core/model';
import { bitwardenCopySourceHash } from '../../../src/core/bitwarden-transfer-journal';
import { BitwardenClient, type BitwardenSessionConfig } from '../../../src/providers/bitwarden/bitwarden-client';
import { prepareBitwardenTransferCipher } from '../../../src/providers/bitwarden/bitwarden-transfer-cipher';
import { encodeBitwardenCipher, encodeBitwardenPasskeyCipher } from '../../../src/providers/bitwarden/bitwarden-cipher-codec';
import { encryptBitwardenString } from '../../../src/providers/bitwarden/bitwarden-crypto';
import { BitwardenAttachmentDownloadService } from '../../../src/providers/bitwarden/bitwarden-attachments';
import { BitwardenAttachmentMutationService } from '../../../src/providers/bitwarden/bitwarden-attachment-mutations';
import { BitwardenTransferRemote } from '../../../src/providers/bitwarden/bitwarden-transfer-remote';
import { executeBitwardenCipherCopy } from '../../../src/providers/bitwarden/bitwarden-transfer-execution';
import { createPasskey, createAssertion } from '../../../src/passkey/webauthn-core';
import { bytesToBase64 } from '../../../src/security/encoding';

const password = 'Synthetic Bitwarden copy persistence acceptance only';
const storage = new IndexedDbVaultStorage(), vault = new SecureVaultService(storage, new MemoryVaultSessionStore());
const targetKey = { encKey: new Uint8Array(32).fill(24), macKey: new Uint8Array(32).fill(25) };
const stamp = '2026-10-12T00:00:00.000Z', origin = 'https://copy.example.test', challenge = bytesToBase64(new Uint8Array(32).fill(62));
const transportPolicy = { maxAttempts: 1, baseDelayMs: 0, jitterRatio: 0, timeoutMs: 5000 };

async function execute(copyId: string, loseReceipt = false) {
  const store = await vault.openBitwardenCipherCopyStore();
  const advance = store.advance;
  if (loseReceipt) store.advance = async (...args) => {
    const row = await advance(...args);
    if (row.stage === 'created' && row.attachmentReceipts.length === 1) throw new Error('Synthetic lost encrypted file receipt reply');
    return row;
  };
  const remote = new BitwardenTransferRemote(copyId, store, new BitwardenClient(fetch, transportPolicy),
    new BitwardenAttachmentDownloadService({ transportPolicy }), new BitwardenAttachmentMutationService({ transportPolicy }));
  try { return await executeBitwardenCipherCopy(copyId, store, remote, targetKey); }
  finally { remote.dispose(); }
}

export async function first(host: string) {
  const sourceKey = { encKey: new Uint8Array(32).fill(5), macKey: new Uint8Array(32).fill(6) };
  const login = createLoginItem({ title: 'Synthetic project', username: 'synthetic', password: 'private source password' });
  login.totpSecret = 'JBSWY3DPEHPK3PXP';
  login.passwordHistory = [{ password: 'private previous password', lastUsedAt: stamp }];
  login.customFields = [{ name: 'Repeated', value: 'first', protected: true }, { name: 'Repeated', value: 'second', protected: true }];
  let native = await encodeBitwardenCipher(login, sourceKey);
  const publicKeys: string[] = [], passkeys: PasskeyItem[] = [];
  for (const count of [0, 19]) {
    const created = await createPasskey({ origin, challenge, rpName: 'Synthetic', userId: 'dXNlcg', userName: `user-${count}`,
      userDisplayName: `User ${count}`, algorithms: [-7], excludeCredentialIds: [], credentialIdFormat: 'uuid' });
    const passkey: PasskeyItem = { ...login, id: crypto.randomUUID(), kind: 'passkey', credentialId: created.credentialId,
      rpId: 'copy.example.test', rpName: 'Synthetic', userHandle: 'dXNlcg', userName: `user-${count}`, userDisplayName: `User ${count}`,
      algorithm: -7, privateKeyPkcs8: created.privateKeyPkcs8, publicKey: created.publicKeySpki, signCount: count,
      discoverable: true, sourceMode: 'bitwarden' };
    native = await encodeBitwardenPasskeyCipher(passkey, sourceKey, native); passkeys.push(passkey); publicKeys.push(created.publicKeySpki);
  }
  const files = await Promise.all([0, 1].map(async index => {
    const bytes = new Uint8Array([index, 1, 42, 255]);
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    return { itemId: login.id, attachmentId: `source-file-${index}`, fileName: `synthetic-${index}.bin`, sizeBytes: bytes.length,
      sha256, dataBase64: bytesToBase64(bytes) };
  }));
  native = { ...native, id: 'native-source', revisionDate: stamp,
    FutureData: { secret: await encryptBitwardenString('private future field', sourceKey), sequence: [null, false, '', 0] },
    attachments: await Promise.all(files.map(async file => ({ id: file.attachmentId, fileName: await encryptBitwardenString(file.fileName, sourceKey) }))) };
  const session: BitwardenSessionConfig = { vaultUrl: host, apiUrl: `${host}/api`, identityUrl: `${host}/identity`, email: 'synthetic@example.invalid',
    deviceId: 'synthetic-copy-device', accessToken: 'synthetic-token', refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 3600_000,
    vaultKeyEnc: bytesToBase64(targetKey.encKey), vaultKeyMac: bytesToBase64(targetKey.macKey), kdf: { type: 0, iterations: 10_000 } };
  const target: ProviderAccount = { id: 'synthetic-target', kind: 'bitwarden', name: 'Synthetic target', enabled: true, isDefaultSaveTarget: false, config: session };
  await vault.setup(password, [login, ...passkeys]); await vault.upsertProvider(target);
  const prepared = await prepareBitwardenTransferCipher({ source: native, sourceOwnerKey: sourceKey, targetOwnerKey: targetKey,
    operationId: crypto.randomUUID(), copyId: crypto.randomUUID(), targetProviderId: target.id });
  const sourceItemIds = [login.id, ...passkeys.map(row => row.id)];
  await vault.stageBitwardenCipherCopy({ version: 1, revision: 0, target, sourceItemIds, prepared, files, attachmentReceipts: [], stage: 'prepared',
    sourceSnapshotSha256: await bitwardenCopySourceHash(await vault.readState(), sourceItemIds) });
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(...args: Parameters<IDBObjectStore['put']>) {
    const request = put.apply(this, args);
    if (this.name === 'vault') request.addEventListener('success', () => this.transaction.abort(), { once: true });
    return request;
  };
  let aborted = false;
  try { await execute(prepared.copyId); } catch { aborted = true; } finally { IDBObjectStore.prototype.put = put; }
  const store = await vault.openBitwardenCipherCopyStore();
  if (!aborted || (await store.read(prepared.copyId)).stage !== 'prepared') throw new Error('Aborted attempt was not atomic');
  let lost = false; try { await execute(prepared.copyId); } catch { lost = true; }
  if (!lost || (await store.read(prepared.copyId)).stage !== 'attempted') throw new Error('Lost create response did not retain attempted intent');
  const envelope = JSON.stringify(await storage.read());
  for (const secret of [login.password, files[0].dataBase64, 'private future field', prepared.copyId]) if (envelope.includes(secret)) throw new Error('Plaintext recovery storage');
  await vault.lock(); return { copyId: prepared.copyId, sourceItemIds, publicKeys, aborted, lost };
}

export async function second(copyId: string) {
  await vault.unlock(password);
  let lost = false; try { await execute(copyId, true); } catch (error) {
    if (!(error instanceof Error) || error.message !== 'Synthetic lost encrypted file receipt reply') throw error;
    lost = true;
  }
  const row = await (await vault.openBitwardenCipherCopyStore()).read(copyId);
  if (!lost || row.stage !== 'created' || row.attachmentReceipts.length !== 1) throw new Error('Missing durable attachment receipt');
  await vault.lock(); return { lost, receipts: row.attachmentReceipts.length };
}

export async function final(copyId: string) {
  await vault.unlock(password); const row = await execute(copyId), state = await vault.readState();
  const passkeys = row.verifiedItems!.filter((row): row is PasskeyItem => row.kind === 'passkey');
  const assertions = [];
  for (const copy of passkeys) {
    const source = state.items.find((row): row is PasskeyItem => row.kind === 'passkey' && row.credentialId === copy.credentialId)!;
    if (source.privateKeyPkcs8 !== copy.privateKeyPkcs8 || source.signCount !== copy.signCount) throw new Error('Passkey identity or counter changed');
    assertions.push(await createAssertion({ origin, challenge, rpId: copy.rpId, credentialId: copy.credentialId,
      userHandle: copy.userHandle, privateKeyPkcs8: copy.privateKeyPkcs8!, signCount: copy.signCount }));
  }
  const before = JSON.stringify(await storage.read()); await execute(copyId);
  if (before !== JSON.stringify(await storage.read())) throw new Error('Verified replay rewrote the vault');
  return { stage: row.stage, fileCount: row.attachmentReceipts.length, kinds: row.verifiedItems!.map(row => row.kind),
    counts: passkeys.map(row => row.signCount), sourceIds: state.items.map(row => row.id), assertions };
}
