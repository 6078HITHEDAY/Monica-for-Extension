import * as kdbxweb from 'kdbxweb';
import type { PasskeyItem, ProviderAccount } from '../../../src/core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../../../src/core/project-credentials';
import { base64ToBytes, bytesToBase64 } from '../../../src/security/encoding';
import { buildKeePassFixture } from '../../../src/providers/keepass/keepass-fixture';
import { KeePassProvider } from '../../../src/providers/keepass/keepass-provider';
import { KeePassLocalWorkingCopyService } from '../../../src/providers/keepass/keepass-local-working-copy';
import { KeePassRemoteSessionService } from '../../../src/providers/keepass/keepass-remote-session';
import { IndexedDbKeePassWorkingCopyStorage } from '../../../src/providers/keepass/keepass-working-copy-store';
import { createKeePassCacheEncryptionKey } from '../../../src/providers/keepass/keepass-receipt-crypto';
import { createKeePassEntry, restoreKeePassEntry } from '../../../src/providers/keepass/keepass-writer';
import { openKeePassVault } from '../../../src/providers/keepass/keepass-vault';
import type { KeePassSourceRemovalRequest } from '../../../src/providers/keepass/keepass-source-removal';

// Trusted synthetic module harness only. It is not an extension runtime command
// or a claim of target verification, manager UI, or cloud publication acceptance.
const password = 'Synthetic KeePass source removal master';
const databaseName = 'synthetic-keepass-source-removal';
const storage = new IndexedDbKeePassWorkingCopyStorage(databaseName);
const provider = new KeePassProvider();
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const serviceFor = (mode: string) => mode === 'local-file'
  ? new KeePassLocalWorkingCopyService(provider, storage) : new KeePassRemoteSessionService(provider, storage);
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

export async function first(mode: 'local-file' | 'webdav' | 'onedrive') {
  const now = new Date().toISOString(), projectId = crypto.randomUUID(), groupId = crypto.randomUUID();
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const passkey: PasskeyItem = { id: crypto.randomUUID(), kind: 'passkey', title: 'Original Key', favorite: false, notes: '',
    createdAt: now, updatedAt: now, providerRefs: [], credentialId: 'AQIDBA', userHandle: 'BQYH',
    privateKeyPkcs8: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey))),
    publicKey: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey))),
    rpId: 'source-removal.test', rpName: 'Synthetic', userName: 'Synthetic', userDisplayName: 'Synthetic',
    algorithm: -7, signCount: 0, sourceMode: 'browser-local', discoverable: true, backupEligible: true, backupState: true };
  const initial = await buildKeePassFixture({ password, kdf: 'argon2id', entries: [0, 1, 2].map(n => ({
    title: n === 2 ? 'Untouched' : `Member ${n}`, group: 'Original',
    protectedFields: { Password: `synthetic secret ${n}`, Unknown: ' future\r\nvalue ',
      ...(n < 2 ? { [PROJECT_CREDENTIAL_FIELD]: JSON.stringify({ version: 1, projectId, groupId, passwordId: crypto.randomUUID(),
        label: 'Main', primary: n === 0, groupOrder: 0, passwordOrder: n }) } : {}) },
    binaries: { 'file.bin': Uint8Array.of(1, 2, n, 255) }
  })) });
  const source = await openKeePassVault(initial, { password, databaseId: 1, providerId: 'source' });
  createKeePassEntry(source.database, passkey, 'Original');
  for (const entry of source.entriesByUuid.values()) {
    entry.pushHistory(); entry.history[0].fields.set('Password', kdbxweb.ProtectedValue.fromString('historical secret'));
    entry.history[0].binaries.set('history.bin', await source.database.createBinary(Uint8Array.of(8, 9, 255).buffer));
  }
  const bytes = new Uint8Array(await source.database.save()), sha = await digest(bytes);
  const account: ProviderAccount = { id: 'source', kind: 'keepass', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false,
    config: { sourceMode: mode, databaseId: 1, localFileSourceSha256: mode === 'local-file' ? sha : undefined,
      databasePassword: mode === 'local-file' ? undefined : password, cacheEncryptionKey: createKeePassCacheEncryptionKey(),
      webDavBaseUrl: 'https://synthetic.invalid', remotePath: '/source.kdbx', oneDriveDriveId: 'drive', oneDriveItemId: 'item' } };
  await provider.unlock(account, bytes, { password, sourceMode: mode });
  const items = (await provider.sync(account, { now, localItems: [] })).items, service = serviceFor(mode);
  if (service instanceof KeePassLocalWorkingCopyService) await service.initialize(account, bytes);
  else await storage.save({ providerId: account.id, baseBytes: bytes, workingBytes: bytes, baseSha256: sha, workingSha256: sha, updatedAt: now, baseEtag: '"original"' }, 0);
  const request: KeePassSourceRemovalRequest = { version: 1, operationId: crypto.randomUUID(), createdAt: now, targetProviderId: 'synthetic-target',
    targetProofSha256: 'b'.repeat(64), expectedWorkingSha256: sha, expectedContentSha256: await provider.transferNativeContentHash(account),
    sources: items.filter(item => item.title !== 'Untouched') };
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
    const result = put.apply(this, args);
    if (this.transaction.db.name === databaseName && this.name === 'working-copies')
      result.addEventListener('success', () => this.transaction.abort(), { once: true });
    return result;
  };
  let aborted = false;
  try { await service.persistSourceRemoval(account, request); } catch { aborted = true; }
  finally { IDBObjectStore.prototype.put = put; }
  const unchanged = await storage.read(account.id);
  assert(aborted && unchanged?.revision === 1 && await digest(unchanged.workingBytes) === sha
    && !await storage.readReceipt(account.id, request.operationId), 'Partial source file or receipt survived actual transaction abort');
  const save = storage.save.bind(storage);
  storage.save = async (...args) => { await save(...args); throw new Error('Synthetic lost committed response'); };
  let lost = false;
  try { await service.persistSourceRemoval(account, request); } catch { lost = true; }
  finally { storage.save = save; }
  const checkpoint = await storage.read(account.id), envelope = await storage.readReceipt(account.id, request.operationId);
  assert(lost && checkpoint?.revision === 2 && envelope, 'Missing complete committed checkpoint');
  assert(!JSON.stringify(envelope).includes('synthetic secret') && !JSON.stringify(envelope).includes(passkey.privateKeyPkcs8!), 'Unencrypted receipt');
  assert(provider.summarize(account.id).itemCount === 4, 'File preparation mutated the live session');
  return { account, request, passkey, aborted, lost };
}

export async function restart(saved: Awaited<ReturnType<typeof first>>) {
  const { account, request, passkey } = saved, service = serviceFor(String(account.config.sourceMode));
  // No live source session exists in this new browser process.
  const receipt = await service.persistSourceRemoval(account, request), record = await storage.read(account.id);
  assert(receipt.result.type === 'transfer-source-remove' && receipt.result.entries.length === 3 && record?.revision === 2, 'Recovery repeated a write');
  assert(await digest(record.baseBytes) === request.expectedWorkingSha256, 'Source base file changed');
  const opened = await openKeePassVault(record.workingBytes, { password, databaseId: 1, providerId: account.id });
  assert(opened.items.length === 4 && opened.items.filter(item => item.deletedAt).length === 3, 'Incomplete native recycle-bin move');
  const key = opened.items.find((item): item is PasskeyItem => item.kind === 'passkey');
  assert(key && key.privateKeyPkcs8 === passkey.privateKeyPkcs8 && key.credentialId === passkey.credentialId && key.signCount === 0, 'Original credential changed');
  const privateKey = await crypto.subtle.importKey('pkcs8', base64ToBytes(key.privateKeyPkcs8!).slice().buffer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const publicKey = await crypto.subtle.importKey('spki', base64ToBytes(passkey.publicKey).slice().buffer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const challenge = crypto.getRandomValues(new Uint8Array(32)), algorithm = { name: 'ECDSA', hash: 'SHA-256' };
  assert(await crypto.subtle.verify(algorithm, publicKey, await crypto.subtle.sign(algorithm, privateKey, challenge), challenge), 'Original-key signature failed');
  const binary = (value: kdbxweb.KdbxEntry['binaries'] extends Map<string, infer T> ? T : never) => {
    const raw = kdbxweb.KdbxBinaries.isKdbxBinaryWithHash(value) ? value.value : value;
    return new Uint8Array(raw instanceof kdbxweb.ProtectedValue ? raw.getBinary() : raw);
  };
  for (const entry of opened.entriesByUuid.values()) {
    const title = entry.fields.get('Title');
    if (typeof title !== 'string' || !title.startsWith('Member')) continue;
    assert(binary(entry.binaries.get('file.bin')!).join(',') === `1,2,${title.at(-1)},255`, 'Attachment changed');
    assert((entry.fields.get('Unknown') as kdbxweb.ProtectedValue).getText() === ' future\r\nvalue ', 'Unknown field changed');
    assert((entry.history[0].fields.get('Password') as kdbxweb.ProtectedValue).getText() === 'historical secret'
      && binary(entry.history[0].binaries.get('history.bin')!).join(',') === '8,9,255', 'History or historical attachment changed');
  }
  // A later user restore must not be overwritten by replaying the old operation.
  for (const item of opened.items.filter(item => item.deletedAt)) restoreKeePassEntry(opened.database, opened.entriesByUuid.get(item.keepassEntryUuid!)!);
  const restored = new Uint8Array(await opened.database.save()), restoredSha = await digest(restored);
  await storage.save({ ...record, workingBytes: restored, workingSha256: restoredSha }, record.revision);
  const replay = await service.persistSourceRemoval(account, request), final = await storage.read(account.id);
  assert(JSON.stringify(replay) === JSON.stringify(receipt) && final?.revision === 3 && final.workingSha256 === restoredSha, 'Replay overwrote later restoration');
  const finalFile = await openKeePassVault(final.workingBytes, { password, databaseId: 1, providerId: account.id });
  assert(finalFile.items.every(item => !item.deletedAt), 'A restored source was deleted again');
  return { aborted: saved.aborted, lost: saved.lost, removed: 3, retained: 1, restored: 4,
    encryptedReceipt: true, originalSignature: true, originalCounter: 0, attachmentsExact: true, historyExact: true,
    noSessionRecovery: true, baseUnchanged: true, laterRestorationPreserved: true };
}
