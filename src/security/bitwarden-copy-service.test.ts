import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createLoginItem, type ProviderAccount } from '../core/model';
import { readBitwardenCipherCopies, bitwardenCopySourceHash, type BitwardenCipherCopyRecord } from '../core/bitwarden-transfer-journal';
import { prepareBitwardenTransferCipher } from '../providers/bitwarden/bitwarden-transfer-cipher';
import { encodeBitwardenCipher } from '../providers/bitwarden/bitwarden-cipher-codec';
import { encryptBitwardenString } from '../providers/bitwarden/bitwarden-crypto';
import { executeBitwardenCipherCopy, type BitwardenCopyRemote } from '../providers/bitwarden/bitwarden-transfer-execution';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';
import { MemoryVaultDeviceKeyStore } from './vault-device-key';
import type { BitwardenSessionConfig } from '../providers/bitwarden/bitwarden-client';
import { encryptVaultState, importVaultKey } from './vault-crypto';

const key = (value: number) => ({ encKey: new Uint8Array(32).fill(value), macKey: new Uint8Array(32).fill(value + 1) });
const sourceKey = key(9), targetKey = key(24), stamp = '2026-10-12T00:00:00.000Z';
const target: ProviderAccount = { id: 'target', kind: 'bitwarden', name: 'Synthetic only', enabled: true, isDefaultSaveTarget: false,
  config: { apiUrl: 'https://example.invalid', email: 'synthetic@example.invalid', deviceId: 'synthetic' } };

async function fixture(count = 2) {
  const source = createLoginItem({ title: 'Journal synthetic source', password: 'Private password', username: 'synthetic' });
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore(), keys = new MemoryVaultDeviceKeyStore();
  let vault = new SecureVaultService(storage, sessions, Date.now, keys);
  await vault.setup('', [source]); await vault.upsertProvider(target);
  const files = Array.from({ length: count }, (_, index) => {
    const bytes = Buffer.from(`Private file ${index}`);
    return { itemId: source.id, attachmentId: `file-${index}`, fileName: `file-${index}.bin`, sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') };
  });
  const native = { ...await encodeBitwardenCipher(source, sourceKey), id: 'native-source', revisionDate: stamp,
    attachments: await Promise.all(files.map(async file => ({ id: file.attachmentId, fileName: await encryptBitwardenString(file.fileName, sourceKey) }))) };
  const prepared = await prepareBitwardenTransferCipher({ source: native, sourceOwnerKey: sourceKey, targetOwnerKey: targetKey,
    operationId: crypto.randomUUID(), copyId: crypto.randomUUID(), targetProviderId: target.id });
  const candidate: BitwardenCipherCopyRecord = { version: 1, revision: 0, stage: 'prepared', target, prepared,
    sourceItemIds: [source.id], sourceSnapshotSha256: await bitwardenCopySourceHash(await vault.readState(), [source.id]), files, attachmentReceipts: [] };
  await vault.stageBitwardenCipherCopy(candidate);
  const ciphers = new Map<string, Record<string, unknown>>(), operations = new Map<string, string>(), uploaded = new Map<string, typeof files[number]>();
  const remote = {
    list: vi.fn(async () => structuredClone([...ciphers.values()])),
    read: vi.fn(async (id: string) => structuredClone(ciphers.get(id) || null)),
    create: vi.fn(async (payload: Record<string, unknown>) => {
      const raw = { ...structuredClone(payload), id: `copy-${ciphers.size}`, revisionDate: stamp };
      ciphers.set(raw.id, raw); return structuredClone(raw);
    }),
    upload: vi.fn(async (remoteId: string, operationId: string, file: typeof files[number]) => {
      const previous = operations.get(operationId); if (previous) return previous;
      const id = `target-file-${uploaded.size}`; operations.set(operationId, id); uploaded.set(id, structuredClone(file));
      const raw = ciphers.get(remoteId)!; raw.attachments = [...(raw.attachments as unknown[] || []), { id }];
      return id;
    }),
    readFile: vi.fn(async (_: string, id: string) => ({ fileName: uploaded.get(id)!.fileName, bytes: new Uint8Array(Buffer.from(uploaded.get(id)!.dataBase64, 'base64')) }))
  } satisfies BitwardenCopyRemote;
  return { source, storage, sessions, candidate, files, remote, ciphers, uploaded, operations,
    get vault() { return vault; },
    restart: () => { vault = new SecureVaultService(storage, sessions, Date.now, keys); },
    run: async () => executeBitwardenCipherCopy(prepared.copyId, await vault.openBitwardenCipherCopyStore(), remote, targetKey),
    saved: async () => (await vault.openBitwardenCipherCopyStore()).read(prepared.copyId) };
}

it('persists private recovery data only in the encrypted vault and replays verified copies without network', async () => {
  const f = await fixture();
  const done = await f.run(); expect(done.stage).toBe('verified'); expect(done.attachmentReceipts).toHaveLength(2);
  expect(done.verifiedItems?.[0]).toMatchObject({ password: f.source.password });
  const envelope = JSON.stringify(await f.storage.read());
  for (const privateValue of [f.source.password, f.files[0].dataBase64, f.files[0].fileName, f.candidate.prepared.copyId]) expect(envelope).not.toContain(privateValue);
  expect((await f.vault.readState()).items).toEqual([f.source]); // No premature adoption or source deletion.
  f.restart(); for (const mock of Object.values(f.remote)) mock.mockClear();
  expect(await f.run()).toEqual(done);
  for (const mock of Object.values(f.remote)) expect(mock).not.toHaveBeenCalled();
});

it('recovers a committed Cipher after response loss and process restart without another POST', async () => {
  const f = await fixture(), create = f.remote.create.getMockImplementation()!;
  f.remote.create.mockImplementationOnce(async payload => { await create(payload); throw new Error('response lost'); });
  await expect(f.run()).rejects.toThrow('response lost'); expect((await f.saved()).stage).toBe('attempted');
  f.restart(); expect((await f.run()).stage).toBe('verified'); expect(f.remote.create).toHaveBeenCalledTimes(1);
  expect(f.ciphers.size).toBe(1); expect(f.uploaded.size).toBe(2);
});

it.each(['absent', 'duplicate', 'edited', 'deleted'] as const)('never retries creation when the attempted result is %s', async mode => {
  const f = await fixture(0), create = f.remote.create.getMockImplementation()!;
  f.remote.create.mockImplementationOnce(async payload => { if (mode !== 'absent') await create(payload); throw new Error('lost'); });
  await expect(f.run()).rejects.toThrow('lost');
  const raw = f.ciphers.get('copy-0');
  if (mode === 'duplicate') f.ciphers.set('copy-other', { ...raw, id: 'copy-other' });
  if (mode === 'edited') raw!.favorite = !raw!.favorite;
  if (mode === 'deleted') raw!.deletedDate = stamp;
  f.restart(); await expect(f.run()).rejects.toThrow(); expect(f.remote.create).toHaveBeenCalledTimes(1);
  expect((await f.saved()).stage).toBe('attempted'); expect((await f.vault.readState()).items).toEqual([f.source]);
});

it('resumes a lost upload response under the same operation ID and records every completed file', async () => {
  const f = await fixture(), upload = f.remote.upload.getMockImplementation()!;
  f.remote.upload.mockImplementationOnce(async (...args) => { await upload(...args); throw new Error('file response lost'); });
  await expect(f.run()).rejects.toThrow('file response lost'); f.restart();
  expect((await f.run()).stage).toBe('verified'); expect(f.uploaded.size).toBe(2);
  expect(f.remote.upload.mock.calls[0][1]).toBe(f.remote.upload.mock.calls[1][1]);
});

it('uses encrypted per-file receipts if the lower attachment journal has expired completed entries', async () => {
  const f = await fixture(), upload = f.remote.upload.getMockImplementation()!;
  f.remote.upload.mockImplementationOnce(upload).mockImplementationOnce(async () => { throw new Error('paused'); });
  await expect(f.run()).rejects.toThrow('paused'); expect((await f.saved()).attachmentReceipts).toHaveLength(1);
  f.operations.clear(); f.restart(); f.remote.upload.mockClear();
  expect((await f.run()).stage).toBe('verified'); expect(f.remote.upload).toHaveBeenCalledTimes(1);
  expect(f.remote.upload.mock.calls[0][2].attachmentId).toBe(f.files[1].attachmentId); expect(f.uploaded.size).toBe(2);
});

it.each(['bytes', 'name', 'length'] as const)('does not confirm a file with mismatched %s on fresh download', async mode => {
  const f = await fixture(1), read = f.remote.readFile.getMockImplementation()!;
  let returned: Uint8Array | undefined;
  f.remote.readFile.mockImplementationOnce(async (...args) => {
    const value = await read(...args);
    if (mode === 'bytes') value.bytes[0] ^= 1;
    if (mode === 'length') value.bytes = value.bytes.slice(1);
    if (mode === 'name') value.fileName = 'changed.bin';
    returned = value.bytes; return value;
  });
  await expect(f.run()).rejects.toThrow('回读不一致'); expect(returned?.every(n => n === 0)).toBe(true);
  expect((await f.saved()).attachmentReceipts).toHaveLength(0);
  expect((await f.saved()).stage).toBe('created'); expect((await f.run()).stage).toBe('verified');
});

it('rejects corrupt prepared file bytes and payload before any network operation', async () => {
  const f = await fixture(1), store = await f.vault.openBitwardenCipherCopyStore();
  for (const broken of [ { ...f.candidate, files: [{ ...f.files[0], dataBase64: 'AAAA' }] },
    { ...f.candidate, prepared: { ...f.candidate.prepared, contentSha256: 'f'.repeat(64) } } ]) {
    await expect(executeBitwardenCipherCopy(broken.prepared.copyId, { ...store, read: async () => broken }, f.remote, targetKey)).rejects.toThrow();
  }
  for (const mock of Object.values(f.remote)) expect(mock).not.toHaveBeenCalled();
  await expect(f.vault.stageBitwardenCipherCopy({ ...f.candidate, files: [{ ...f.files[0], dataBase64: 'AAAA' }] })).rejects.toThrow('完整性');
});

it('rejects swapped readback IDs before uploading any attachment', async () => {
  const f = await fixture(); f.remote.read.mockImplementationOnce(async () => ({ ...f.ciphers.get('copy-0'), id: 'swapped' }));
  await expect(f.run()).rejects.toThrow('身份'); expect(f.remote.upload).not.toHaveBeenCalled();
});

it('rejects duplicate IDs in a full scan before any creation', async () => {
  const f = await fixture(0); f.remote.list.mockResolvedValueOnce([{ id: 'duplicate' }, { id: 'duplicate' }]);
  await expect(f.run()).rejects.toThrow('清单身份'); expect(f.remote.create).not.toHaveBeenCalled();
});

it('does not finalize when a peer edits the Cipher after the last file upload', async () => {
  const f = await fixture(1), upload = f.remote.upload.getMockImplementation()!;
  f.remote.upload.mockImplementationOnce(async (...args) => { const result = await upload(...args); f.ciphers.get('copy-0')!.favorite = true; return result; });
  await expect(f.run()).rejects.toThrow(); expect((await f.saved()).stage).toBe('created');
  expect((await f.vault.readState()).items).toEqual([f.source]);
});

it('binds execution to the original unlock session, including lock followed by unlock with the same key', async () => {
  const f = await fixture(0), store = await f.vault.openBitwardenCipherCopyStore();
  const old = await f.sessions.read(); await f.vault.lock(); await f.sessions.write({ ...old!, id: crypto.randomUUID() });
  await expect(executeBitwardenCipherCopy(f.candidate.prepared.copyId, store, f.remote, targetKey)).rejects.toThrow('locked');
  expect(f.remote.list).not.toHaveBeenCalled(); expect((await f.run()).stage).toBe('verified');
});

it('stops after locking during a network response and recovers the original copy later', async () => {
  const f = await fixture(), create = f.remote.create.getMockImplementation()!, session = await f.sessions.read();
  f.remote.create.mockImplementationOnce(async payload => { const raw = await create(payload); await f.vault.lock(); return raw; });
  await expect(f.run()).rejects.toThrow('locked'); expect(f.remote.upload).not.toHaveBeenCalled();
  await f.sessions.write({ ...session!, id: crypto.randomUUID() }); f.restart();
  expect((await f.run()).stage).toBe('verified'); expect(f.remote.create).toHaveBeenCalledTimes(1);
});

it('rejects target reconfiguration, but permits independently rotated access tokens', async () => {
  const f = await fixture(0);
  await f.vault.upsertProvider({ ...target, config: { ...target.config, accessToken: 'rotated' } });
  expect((await f.saved()).stage).toBe('prepared');
  await f.vault.upsertProvider({ ...target, config: { ...target.config, apiUrl: 'https://changed.invalid' } });
  await expect(f.run()).rejects.toThrow('目标已变化'); expect(f.remote.create).not.toHaveBeenCalled();
});

it('uses revision CAS and rejects stage skips, identity reuse and backwards transitions', async () => {
  const f = await fixture(0), store = await f.vault.openBitwardenCipherCopyStore(), id = f.candidate.prepared.copyId;
  await expect(store.advance(id, 0, { stage: 'verified', remoteId: 'copy-0', attachmentReceipts: [] })).rejects.toThrow();
  const next = await store.advance(id, 0, { stage: 'attempted', attachmentReceipts: [] }); expect(next.revision).toBe(1);
  await expect(store.advance(id, 0, { stage: 'created', remoteId: 'copy-0', attachmentReceipts: [] })).rejects.toThrow();
  await expect(store.advance(id, 1, { stage: 'prepared', attachmentReceipts: [] })).rejects.toThrow();
  await expect(f.vault.stageBitwardenCipherCopy({ ...f.candidate, prepared: { ...f.candidate.prepared, sourceSha256: 'a'.repeat(64) } })).rejects.toThrow('身份');
  expect((await f.saved()).stage).toBe('attempted');
});

it('rejects a source edit between preview and the first remote mutation', async () => {
  const f = await fixture(0);
  await f.vault.upsertItem({ ...f.source, password: 'edited after preview' });
  await expect(f.run()).rejects.toThrow('来源已变化'); expect(f.remote.create).not.toHaveBeenCalled();
  expect((await f.saved()).stage).toBe('prepared');
});

it('preserves source edits made after an uncertain creation while recovering the reviewed original', async () => {
  const f = await fixture(0), create = f.remote.create.getMockImplementation()!;
  f.remote.create.mockImplementationOnce(async payload => { await create(payload); throw new Error('lost'); });
  await expect(f.run()).rejects.toThrow('lost'); await f.vault.upsertItem({ ...f.source, password: 'new local edit' });
  f.restart(); const row = await f.run(); expect(row.verifiedItems?.[0]).toMatchObject({ password: f.source.password });
  expect((await f.vault.readState()).items[0]).toMatchObject({ password: 'new local edit' });
});

it('cannot change immutable payloads by injecting extra transition properties', async () => {
  const f = await fixture(0), store = await f.vault.openBitwardenCipherCopyStore();
  await expect(store.advance(f.candidate.prepared.copyId, 0, { stage: 'attempted', attachmentReceipts: [],
    prepared: { ...f.candidate.prepared, targetProviderId: 'other' } } as never)).rejects.toThrow();
  expect((await f.saved()).stage).toBe('prepared');
});

it('does not overwrite a newer refresh token or unrelated provider settings', async () => {
  const f = await fixture(0), store = await f.vault.openBitwardenCipherCopyStore(), id = f.candidate.prepared.copyId;
  const initial = await store.account(id);
  const first = { ...initial.config, accessToken: 'first', refreshToken: 'first-refresh', expiresAt: Date.now() + 3600_000 } as BitwardenSessionConfig;
  await store.saveSession(id, initial, first);
  const current = await store.account(id);
  await f.vault.upsertProvider({ ...current, name: 'Renamed', config: { ...current.config, untouched: 'preserved',
    accessToken: 'newest', refreshToken: 'newest-refresh' } });
  const result = await store.saveSession(id, current, { ...first, accessToken: 'stale', refreshToken: 'stale-refresh' });
  expect(result).toMatchObject({ name: 'Renamed', config: { accessToken: 'newest', refreshToken: 'newest-refresh', untouched: 'preserved' } });
  await expect(store.saveSession(id, result, { ...first, email: 'different@example.invalid' })).rejects.toThrow('身份');
  await f.vault.lock(); await expect(store.saveSession(id, result, first)).rejects.toThrow('locked');
});

it('refuses corrupt persisted copy records after decryption rather than dropping them', async () => {
  const f = await fixture(0), state = await f.vault.readState(), envelope = (await f.storage.read())!, session = (await f.sessions.read())!;
  state.bitwardenCipherCopies![0].version = 9 as never;
  await f.storage.write(await encryptVaultState(state, await importVaultKey(session.rawKey), envelope.kdf));
  f.restart(); await expect(f.vault.readState()).rejects.toThrow('Vault payload is invalid or unsupported');
  expect(await f.storage.read()).not.toBeNull();
});

it('rejects duplicated manifests, out-of-order file receipts and cross-provider verified items', async () => {
  const f = await fixture();
  const brokenManifest = structuredClone(f.candidate); brokenManifest.prepared.attachments[1] = brokenManifest.prepared.attachments[0];
  expect(() => readBitwardenCipherCopies([brokenManifest])).toThrow();
  const done = await f.run();
  const changed = structuredClone(done); changed.attachmentReceipts.reverse();
  expect(() => readBitwardenCipherCopies([changed])).toThrow();
  done.verifiedItems![0].providerRefs[0].providerId = 'other'; expect(() => readBitwardenCipherCopies([done])).toThrow();
});

it.each([null, {}, [{ version: 2 }]])('does not silently discard an invalid recovery journal', value => {
  expect(() => readBitwardenCipherCopies(value)).toThrow();
});
