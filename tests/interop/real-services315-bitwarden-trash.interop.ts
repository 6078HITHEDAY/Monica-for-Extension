import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderAccount } from '../../src/core/model';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { BitwardenProvider } from '../../src/providers/bitwarden/bitwarden-provider';
import { BitwardenDurableSyncCoordinator } from '../../src/providers/bitwarden/bitwarden-durable-sync';
import { decodeBitwardenCipher, encodeBitwardenCipher } from '../../src/providers/bitwarden/bitwarden-cipher-codec';
import { deriveBitwardenMasterKey, deriveBitwardenMasterPasswordHash, stretchBitwardenMasterKey } from '../../src/providers/bitwarden/bitwarden-crypto';
import { BitwardenAttachmentDownloadService } from '../../src/providers/bitwarden/bitwarden-attachments';
import { BitwardenAttachmentMutationService } from '../../src/providers/bitwarden/bitwarden-attachment-mutations';
import { MemoryBitwardenAttachmentMutationStore } from '../../src/providers/bitwarden/bitwarden-attachment-mutation-store';
import { SecureVaultService } from '../../src/security/secure-vault-service';
import { MemoryVaultStorage } from '../../src/security/vault-storage';
import { MemoryVaultSessionStore } from '../../src/security/vault-session';

const configPath = process.env.MONICA_315_REAL_SERVICES_CONFIG;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const field = (raw: Record<string, unknown>, name: string) => raw[name] ?? raw[name[0].toUpperCase() + name.slice(1)];
const revision = (raw: Record<string, unknown>) => String(field(raw, 'revisionDate'));

async function fixture(label: string) {
  const config = JSON.parse(await readFile(resolve(configPath!), 'utf8'));
  expect(config.project).toBe('monica315-interop-20260930');
  const { baseUrl, password } = config.vaultwarden;
  expect(baseUrl).toBe('http://127.0.0.1:18316');
  const client = new BitwardenClient(), email = `trash-${randomUUID()}@example.invalid`;
  const master = await deriveBitwardenMasterKey(password, email, { type: 0, iterations: 600000 });
  const key = { encKey: crypto.getRandomValues(new Uint8Array(32)), macKey: crypto.getRandomValues(new Uint8Array(32)) };
  try {
    const registration = await fetch(`${baseUrl}/identity/accounts/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      email, name: 'Synthetic trash acceptance', masterPasswordHash: await deriveBitwardenMasterPasswordHash(master, password),
      key: await client.protectVaultKey(key, await stretchBitwardenMasterKey(master), crypto.getRandomValues(new Uint8Array(16))), kdf: 0, kdfIterations: 600000
    }) });
    expect(registration.ok).toBe(true);
  } finally { master.fill(0); key.encKey.fill(0); key.macKey.fill(0); }
  const login = await client.login({ vaultUrl: baseUrl, email, masterPassword: password, deviceId: randomUUID() });
  if (login.status !== 'authenticated') throw new Error('Synthetic account did not authenticate');
  const session = login.session;
  const account: ProviderAccount = { id: `trash-${label}`, kind: 'bitwarden', name: 'Trash acceptance', enabled: true, isDefaultSaveTarget: false, config: session };
  const created = await new BitwardenProvider().create(account, { ...createLoginItem({ title: label, username: 'synthetic', password: 'initial-password' }),
    customFields: [{ name: 'monica.content.future', value: '{"exact":9007199254740993}', protected: true }] });
  const cipherId = created.providerRefs.find(ref => ref.providerId === account.id)!.remoteId!;
  const read = async () => {
    const response = await client.getCipherDetails(session, cipherId);
    if (!response.payload) throw new Error('Synthetic Cipher unexpectedly absent');
    return response.payload;
  };
  const plain = async (raw: Record<string, unknown>): Promise<LoginItem> => {
    const item = (await decodeBitwardenCipher(raw, account.id, client.vaultKey(session))).items.find((row): row is LoginItem => row.kind === 'login');
    if (!item) throw new Error('Synthetic login unreadable');
    return item;
  };
  const update = async (raw: Record<string, unknown>, password: string) => {
    const payload = await encodeBitwardenCipher({ ...await plain(raw), password }, client.vaultKey(session), raw);
    payload.lastKnownRevisionDate = revision(raw);
    return (await client.updateCipher(session, cipherId, payload)).payload;
  };
  return { client, session, account, cipherId, read, plain, update };
}

async function recorded(label: string, run: (evidence: Record<string, unknown>, output: string) => Promise<void>) {
  await mkdir(resolve('.tmp/bw-trash-318'), { recursive: true });
  const output = await mkdtemp(join(resolve('.tmp/bw-trash-318'), `${label}-`));
  const evidence: Record<string, unknown> = { status: 'failed', layer: 'Actual isolated Vaultwarden HTTP', label, output };
  try { await run(evidence, output); evidence.status = 'passed'; }
  catch (cause) { evidence.error = cause instanceof Error ? cause.message : String(cause); throw cause; }
  finally { await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify({ output, status: evidence.status })); }
}

it.skipIf(!configPath)('measures actual revision checks and preserves current fields and attachment bytes through trash and restore', async () => recorded('contract', async (evidence, output) => {
  const f = await fixture('contract');
  const bytes = new TextEncoder().encode('Shared content, 中文, \u0000 exact attachment bytes');
  const attachments = new BitwardenAttachmentMutationService({ store: new MemoryBitwardenAttachmentMutationStore() });
  const upload = await attachments.upload({ providerId: f.account.id, itemId: 'synthetic', session: f.session, rawCipher: await f.read(),
    operationId: randomUUID(), fileName: 'shared.txt', bytes: bytes.slice(), sha256: hash(bytes) });
  expect(upload.changed).toBe(true);
  const before = await f.read();
  await f.update(before, 'concurrent-password');
  const latest = await f.read();
  const stalePayload = await encodeBitwardenCipher(await f.plain(before), f.client.vaultKey(f.session), before);
  stalePayload.lastKnownRevisionDate = '2000-01-01T00:00:00.000Z';
  await expect(f.client.updateCipher(f.session, f.cipherId, stalePayload)).rejects.toThrow();
  expect((await f.plain(await f.read())).password).toBe('concurrent-password');
  // Probe the real endpoint rather than assuming it honors update-style CAS or If-Match.
  const deletion = await fetch(`${f.session.apiUrl}/ciphers/${f.cipherId}/delete`, { method: 'PUT', headers: {
    Authorization: `Bearer ${f.session.accessToken}`, 'Content-Type': 'application/json', 'If-Match': '"deliberately-stale"'
  }, body: JSON.stringify({ lastKnownRevisionDate: '2000-01-01T00:00:00.000Z' }) });
  evidence.deleteWithStaleConditionsStatus = deletion.status;
  expect(deletion.ok).toBe(true);
  const trash = await f.read();
  expect(field(trash, 'deletedDate')).toBeTruthy();
  expect((await f.plain(trash)).password).toBe('concurrent-password');
  expect(field(trash, 'attachments')).toEqual(field(latest, 'attachments'));
  const sync = await f.client.sync(f.session);
  expect((field(sync.payload, 'ciphers') as Record<string, unknown>[]).some(row => field(row, 'id') === f.cipherId && field(row, 'deletedDate'))).toBe(true);
  const downloads = new BitwardenAttachmentDownloadService();
  for (const stage of ['trash', 'restore-response', 'fresh-read']) {
    const rawCipher = stage === 'trash' ? trash : stage === 'restore-response'
      ? (await f.client.restoreCipher(f.session, f.cipherId)).payload : await f.read();
    const page = await downloads.listAttachments({ providerId: f.account.id, itemId: 'synthetic', session: f.session, rawCipher });
    expect(page.items).toHaveLength(1);
    const read = await downloads.beginDownload({ providerId: f.account.id, itemId: 'synthetic', session: f.session, rawCipher, attachmentId: page.items[0].attachmentId });
    try { expect(hash(downloads.readChunk(f.account.id, read.readHandle, 0, 65536).bytes)).toBe(hash(bytes)); }
    finally { downloads.release(f.account.id, read.readHandle); }
  }
  const restored = await f.read();
  expect(field(restored, 'deletedDate')).toBeFalsy();
  const item = await f.plain(restored);
  expect(item.password).toBe('concurrent-password');
  expect(item.customFields).toContainEqual({ name: 'monica.content.future', value: '{"exact":9007199254740993}', protected: true });
  await writeFile(join(output, 'restored-synthetic-item.json'), JSON.stringify(item, null, 2));
  Object.assign(evidence, { staleUpdateRejected: true, deletionIgnoresRevisionAndIfMatch: true, latestFieldsRetained: true,
    trashVisibleInSyncAndDetails: true, sameCipherId: f.cipherId, attachmentSha256: hash(bytes), attachmentReadableInTrashAndAfterRestore: true,
    revisions: { before: revision(before), latest: revision(latest), trash: revision(trash), restored: revision(restored) } });
}));

it.skipIf(!configPath)('adopts the authoritative trash after a concurrent update instead of inventing a stale local tombstone', async () => recorded('concurrent-delete', async (evidence, output) => {
  const f = await fixture('concurrent-delete');
  const storage = new MemoryVaultStorage(), vault = new SecureVaultService(storage, new MemoryVaultSessionStore());
  const password = 'Synthetic durable trash vault';
  await vault.setup(password); await vault.upsertProvider(f.account);
  await new BitwardenDurableSyncCoordinator(new BitwardenProvider(), vault).synchronize(f.account);
  const original = (await vault.listItems())[0];
  await vault.deleteItem(original.id);
  let deletes = 0;
  const fetcher: typeof fetch = async (url, init) => {
    if (init?.method === 'PUT' && String(url).endsWith('/delete')) {
      deletes++;
      await f.update(await f.read(), 'changed-in-delete-window');
    }
    return fetch(url, init);
  };
  await new BitwardenDurableSyncCoordinator(new BitwardenProvider(fetcher), vault).synchronize(f.account);
  const actual = await f.read();
  const local = (await vault.readState()).items.find(row => row.id === original.id);
  expect(deletes).toBe(1);
  expect(local).toMatchObject({ password: 'changed-in-delete-window', deletedAt: new Date(String(field(actual, 'deletedDate'))).toISOString() });
  expect(local?.providerRefs[0].revision).toBe(new Date(revision(actual)).toISOString());
  expect((await vault.readState()).mutationQueue).toHaveLength(0);
  await writeFile(join(output, 'vault.encrypted.json'), JSON.stringify(storage.envelope));
  await vault.lock();
  const reopened = new SecureVaultService(storage, new MemoryVaultSessionStore()); await reopened.unlock(password);
  expect((await reopened.readState()).items.find(row => row.id === original.id)).toMatchObject({ password: 'changed-in-delete-window' });
  await reopened.restoreItem(original.id);
  await new BitwardenDurableSyncCoordinator(new BitwardenProvider(), reopened).synchronize(f.account);
  expect((await f.plain(await f.read())).password).toBe('changed-in-delete-window');
  expect(field(await f.read(), 'deletedDate')).toBeFalsy();
  Object.assign(evidence, { deletes, concurrentContentPreserved: true, authoritativeTrashRevision: revision(actual), encryptedRestartAndRestore: true });
}));

it.skipIf(!configPath).each(['delete-response', 'readback-response', 'concurrent-restore'] as const)(
  'recovers actual committed deletion with %s across encrypted restart without replaying it', async failure => recorded(failure, async (evidence, output) => {
    const f = await fixture(failure);
    const storage = new MemoryVaultStorage(), vault = new SecureVaultService(storage, new MemoryVaultSessionStore());
    const password = 'Synthetic restart trash vault';
    await vault.setup(password); await vault.upsertProvider(f.account);
    await new BitwardenDurableSyncCoordinator(new BitwardenProvider(), vault).synchronize(f.account);
    const original = (await vault.listItems())[0]; await vault.deleteItem(original.id);
    let deletes = 0;
    const fetcher: typeof fetch = async (url, init) => {
      if (init?.method === 'PUT' && String(url).endsWith('/delete')) {
        deletes++;
        await f.update(await f.read(), 'concurrent-durable-password');
        const response = await fetch(url, init);
        expect(response.ok).toBe(true);
        if (failure === 'concurrent-restore') await f.client.restoreCipher(f.session, f.cipherId);
        if (failure === 'delete-response') throw new TypeError('Synthetic response lost after actual commit');
        return response;
      }
      if (failure === 'readback-response' && deletes && String(url).endsWith('/details')) {
        throw new DOMException('Synthetic readback interrupted', 'AbortError');
      }
      return fetch(url, init);
    };
    const first = await new BitwardenDurableSyncCoordinator(new BitwardenProvider(fetcher), vault).synchronize(f.account);
    expect(first.conflicts.length).toBeGreaterThan(0);
    expect(deletes).toBe(1);
    expect((await vault.readState()).providerMutationReceipts).toEqual([expect.objectContaining({ stage: 'attempted', operation: 'delete' })]);
    await writeFile(join(output, 'pending-vault.encrypted.json'), JSON.stringify(storage.envelope)); await vault.lock();
    const reopened = new SecureVaultService(storage, new MemoryVaultSessionStore()); await reopened.unlock(password);
    let recoveryWrites = 0;
    const recoveryFetch: typeof fetch = async (url, init) => { if (init?.method && init.method !== 'GET') recoveryWrites++; return fetch(url, init); };
    const second = await new BitwardenDurableSyncCoordinator(new BitwardenProvider(recoveryFetch), reopened).synchronize(f.account);
    const state = await reopened.readState();
    expect(recoveryWrites).toBe(0);
    const raw = await f.read();
    expect((await f.plain(raw)).password).toBe('concurrent-durable-password');
    if (failure === 'concurrent-restore') {
      expect(field(raw, 'deletedDate')).toBeFalsy();
      expect(second.conflicts).toEqual([expect.objectContaining({ itemId: original.id, reason: expect.stringContaining('停止再次删除') })]);
      expect(state.mutationQueue).toHaveLength(1);
      expect(state.providerMutationReceipts[0].stage).toBe('attempted');
      await reopened.resolveProviderConflict(state.providerConflicts[0].id, 'use-remote');
      await new BitwardenDurableSyncCoordinator(new BitwardenProvider(recoveryFetch), reopened).synchronize(f.account);
      expect((await reopened.readState()).mutationQueue).toHaveLength(0);
      expect((await reopened.readState()).providerMutationReceipts).toHaveLength(0);
      expect((await reopened.readState()).items.find(row => row.id === original.id)).toMatchObject({ password: 'concurrent-durable-password' });
      expect(recoveryWrites).toBe(0);
    } else {
      expect(second.conflicts).toHaveLength(0);
      expect(field(raw, 'deletedDate')).toBeTruthy();
      expect(state.items.find(row => row.id === original.id)).toMatchObject({ password: 'concurrent-durable-password' });
      expect(state.mutationQueue).toHaveLength(0); expect(state.providerMutationReceipts).toHaveLength(0);
    }
    Object.assign(evidence, { deletes, recoveryWrites, concurrentContentPreserved: true, encryptedRestart: true,
      state: failure === 'concurrent-restore' ? 'conflict-preserved-no-redelete' : 'trash-confirmed-queue-drained' });
  })
);
