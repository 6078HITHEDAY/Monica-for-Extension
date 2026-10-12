import { expect, it, vi } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import type { PasskeyItem, ProviderAccount } from '../../core/model';
import { bytesToBase64, base64ToBytes } from '../../security/encoding';
import { PROJECT_CREDENTIAL_FIELD } from '../../core/project-credentials';
import { buildKeePassFixture } from './keepass-fixture';
import { openKeePassVault } from './keepass-vault';
import { KeePassProvider } from './keepass-provider';
import { createKeePassEntry } from './keepass-writer';
import { KeePassLocalWorkingCopyService } from './keepass-local-working-copy';
import { KeePassRemoteSessionService } from './keepass-remote-session';
import { MemoryKeePassWorkingCopyStorage, validateKeePassDurableMutationReceipt } from './keepass-working-copy-store';
import { createKeePassCacheEncryptionKey } from './keepass-receipt-crypto';
import { keePassTransferContentHash } from './keepass-transfer-file';
import { applyKeePassSourceRemoval, keePassSourceRemovalRequestHash, type KeePassSourceRemovalRequest } from './keepass-source-removal';
import { normalizeUuid } from './keepass-field-reference';

const password = 'Synthetic source-removal master', stamp = '2026-10-12T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))].map(byte => byte.toString(16).padStart(2, '0')).join('');
async function fixture(mode: 'local-file' | 'webdav' | 'onedrive' = 'local-file', version: 3 | 4 = 4, counter = 0,
  edit?: (db: kdbxweb.Kdbx) => void) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const passkey: PasskeyItem = { id: uuid(70), kind: 'passkey', title: 'Original Passkey', favorite: false, notes: 'Keep me', createdAt: stamp,
    updatedAt: stamp, providerRefs: [], credentialId: 'AQIDBA', privateKeyPkcs8: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))),
    rpId: 'source.example.invalid', rpName: 'Synthetic', userName: 'synthetic', userDisplayName: 'Synthetic', userHandle: 'BQYH', signCount: counter,
    publicKey: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))),
    algorithm: -7, sourceMode: 'browser-local', discoverable: true, backupEligible: true, backupState: true };
  const initial = await buildKeePassFixture({ password, version, entries: [0, 1, 2].map(n => ({ title: n === 2 ? 'Untouched' : `Member ${n}`,
    group: n === 2 ? 'Other' : 'Project', protectedFields: { Password: `secret ${n}`, Unknown: '  future\r\n\t',
      ...(n < 2 ? { [PROJECT_CREDENTIAL_FIELD]: JSON.stringify({ version: 1, projectId: uuid(1), groupId: uuid(2), passwordId: uuid(10 + n),
        label: `Member ${n}`, groupOrder: 0, passwordOrder: n, primary: n === 0 }) } : {}) }, binaries: { 'original.bin': Uint8Array.of(0, 255, n) } })) });
  const opened = await openKeePassVault(initial, { password, databaseId: 1, providerId: 'source' });
  if (version === 4) opened.database.header.versionMinor = 1;
  createKeePassEntry(opened.database, passkey, 'Keys');
  for (const entry of opened.entriesByUuid.values()) {
    if (version === 4) { entry.qualityCheck = false; entry.customData = new Map([['future', { value: 'native metadata' }]]); }
    entry.pushHistory(); entry.history[0].fields.set('Password', kdbxweb.ProtectedValue.fromString('historical secret'));
    entry.history[0].binaries.set('history.bin', await opened.database.createBinary(Uint8Array.of(8, 9, 10).buffer));
  }
  edit?.(opened.database);
  const bytes = new Uint8Array(await opened.database.save()), sha = await digest(bytes);
  const account: ProviderAccount = { id: 'source', kind: 'keepass', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false,
    config: { sourceMode: mode, databaseId: 1, localFileSourceSha256: mode === 'local-file' ? sha : undefined,
      databasePassword: mode === 'local-file' ? undefined : password, webDavBaseUrl: 'https://example.invalid', remotePath: '/source.kdbx',
      oneDriveDriveId: 'drive', oneDriveItemId: 'item', cacheEncryptionKey: createKeePassCacheEncryptionKey() } };
  const provider = new KeePassProvider(); await provider.unlock(account, bytes, { password, sourceMode: mode });
  const items = (await provider.sync(account, { now: stamp, localItems: [] })).items;
  const storage = new MemoryKeePassWorkingCopyStorage();
  const service = mode === 'local-file' ? new KeePassLocalWorkingCopyService(provider, storage) : new KeePassRemoteSessionService(provider, storage);
  if (service instanceof KeePassLocalWorkingCopyService) await service.initialize(account, bytes);
  else await storage.save({ providerId: account.id, baseBytes: bytes, workingBytes: bytes, baseSha256: sha, workingSha256: sha,
    baseEtag: '"original"', updatedAt: stamp }, 0);
  const request: KeePassSourceRemovalRequest = { version: 1, operationId: uuid(90), createdAt: stamp, targetProviderId: 'destination',
    targetProofSha256: 'b'.repeat(64), expectedWorkingSha256: sha, expectedContentSha256: await provider.transferNativeContentHash(account),
    sources: items.filter(item => item.title !== 'Untouched') };
  return { account, bytes, provider, storage, service, request, items, passkey, pair };
}

it.each(['local-file', 'webdav', 'onedrive'] as const)('atomically preserves whole native entries in the recycle bin for %s and replays after restart', async mode => {
  const f = await fixture(mode), before = await openKeePassVault(f.bytes, { password, databaseId: 1, providerId: f.account.id });
  const receipt = await f.service.persistSourceRemoval(f.account, f.request);
  expect(receipt).toMatchObject({ kind: 'transfer-source-remove', result: { type: 'transfer-source-remove', entries: expect.any(Array) } });
  expect(receipt.result.type === 'transfer-source-remove' && receipt.result.entries.length).toBe(3);
  const record = (await f.storage.read(f.account.id))!;
  expect(record.baseBytes).toEqual(f.bytes); expect(record.revision).toBe(2);
  const after = await openKeePassVault(record.workingBytes, { password, databaseId: 1, providerId: f.account.id });
  expect(after.items).toHaveLength(4);
  expect(after.items.filter(item => item.deletedAt)).toHaveLength(3);
  expect(after.items.find(item => item.title === 'Untouched')).toEqual(before.items.find(item => item.title === 'Untouched'));
  for (const [id, original] of before.entriesByUuid) {
    const current = after.entriesByUuid.get(id)!;
    const fields = (entry: kdbxweb.KdbxEntry) => [...entry.fields].map(([key, value]) => [key, value instanceof kdbxweb.ProtectedValue ? { protected: value.getText() } : value]);
    expect(fields(current)).toEqual(fields(original)); expect(current.history.map(fields)).toEqual(original.history.map(fields));
    expect(current.binaries).toEqual(original.binaries); expect(current.history.map(entry => entry.binaries)).toEqual(original.history.map(entry => entry.binaries));
    expect(current.customData).toEqual(original.customData); expect(current.qualityCheck).toBe(original.qualityCheck);
  }
  const key = after.items.find(item => item.kind === 'passkey') as PasskeyItem;
  expect(key).toMatchObject({ credentialId: f.passkey.credentialId, privateKeyPkcs8: f.passkey.privateKeyPkcs8, signCount: 0 });
  const privateKey = await crypto.subtle.importKey('pkcs8', base64ToBytes(key.privateKeyPkcs8!).buffer as ArrayBuffer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const data = new TextEncoder().encode('Synthetic restored credential');
  expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, f.pair.publicKey,
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data), data)).toBe(true);
  const envelope = await f.storage.readReceipt(f.account.id, f.request.operationId);
  expect(JSON.stringify(envelope)).not.toContain('secret'); expect(JSON.stringify(receipt)).not.toContain(f.passkey.privateKeyPkcs8);
  const nextProvider = new KeePassProvider(), next = mode === 'local-file' ? new KeePassLocalWorkingCopyService(nextProvider, f.storage) : new KeePassRemoteSessionService(nextProvider, f.storage);
  expect(await next.persistSourceRemoval(f.account, f.request)).toEqual(receipt); expect(await f.storage.read(f.account.id)).toEqual(record);
  expect(f.provider.summarize(f.account.id).itemCount).toBe(4); // no live mutation or implicit publication
});

it.each([3, 4] as const)('preserves KDBX %s format and existing positive counter while soft-deleting', async version => {
  const f = await fixture('local-file', version, 19);
  await f.service.persistSourceRemoval(f.account, f.request);
  const file = await openKeePassVault((await f.storage.read(f.account.id))!.workingBytes, { password, databaseId: 1, providerId: f.account.id });
  expect(file.database.header.versionMajor).toBe(version);
  expect(file.items.find(item => item.kind === 'passkey')).toMatchObject({ signCount: 19, privateKeyPkcs8: f.passkey.privateKeyPkcs8 });
});

it.each((['local-file', 'webdav', 'onedrive'] as const).flatMap(source => (['before', 'reply', 'race'] as const).map(failure => ({ source, failure }))))('handles $source/$failure storage failures without partial source deletion', async ({ source, failure: mode }) => {
  const f = await fixture(source), save = f.storage.save.bind(f.storage);
  vi.spyOn(f.storage, 'save').mockImplementationOnce(async (input, revision, receipt) => {
    if (mode === 'before') throw new Error('Disk full');
    if (mode === 'race') await save({ ...input, workingBytes: f.bytes, workingSha256: f.request.expectedWorkingSha256 }, revision);
    const result = await save(input, revision, receipt);
    if (mode === 'reply') throw new Error('Saved reply lost'); return result;
  });
  await expect(f.service.persistSourceRemoval(f.account, f.request)).rejects.toThrow();
  if (mode !== 'reply') expect((await f.storage.read(f.account.id))!.workingBytes).toEqual(f.bytes);
  await f.service.persistSourceRemoval(f.account, f.request);
  expect((await openKeePassVault((await f.storage.read(f.account.id))!.workingBytes, { password, databaseId: 1, providerId: f.account.id })).items.filter(item => item.deletedAt)).toHaveLength(3);
});

it.each(['working-file', 'native-content', 'item', 'partial-project', 'database-binding', 'session-mode'] as const)('refuses stale or incomplete %s before any persisted removal', async problem => {
  const f = await fixture();
  if (problem === 'working-file') f.request.expectedWorkingSha256 = 'a'.repeat(64);
  if (problem === 'native-content') f.request.expectedContentSha256 = 'a'.repeat(64);
  if (problem === 'item') f.request.sources[0].notes = 'Uncommitted local change';
  if (problem === 'partial-project') f.request.sources = f.request.sources.filter(item => item.title !== 'Member 1');
  if (problem === 'database-binding') f.account.config.databaseId = 2;
  if (problem === 'session-mode') f.account.config.sourceMode = 'webdav';
  const before = await f.storage.read(f.account.id);
  await expect(f.service.persistSourceRemoval(f.account, f.request)).rejects.toThrow();
  expect(await f.storage.read(f.account.id)).toEqual(before); expect(await f.storage.readReceipt(f.account.id, f.request.operationId)).toBeUndefined();
});

it.each((['local-file', 'webdav', 'onedrive'] as const).flatMap(source => (['lock', 'edit'] as const).map(event => ({ source, event }))))('rejects $source/$event between preparation and encrypted commit', async ({ source, event }) => {
  const f = await fixture(source), prepare = f.provider.prepareSourceRemovalFile.bind(f.provider);
  vi.spyOn(f.provider, 'prepareSourceRemovalFile').mockImplementationOnce(async (...args) => {
    const result = await prepare(...args);
    if (event === 'lock') f.provider.lock(); else f.provider.createGroup(f.account, uuid(55), 'Later group');
    return result;
  });
  await expect(f.service.persistSourceRemoval(f.account, f.request)).rejects.toThrow('锁定或变化');
  expect((await f.storage.read(f.account.id))!.workingBytes).toEqual(f.bytes);
});

it('rejects a changed destination proof or scope on replay and never replays over a later restoration', async () => {
  const f = await fixture(), receipt = await f.service.persistSourceRemoval(f.account, f.request);
  await expect(f.service.persistSourceRemoval(f.account, { ...f.request, targetProofSha256: 'c'.repeat(64) })).rejects.toThrow();
  await expect(f.service.persistSourceRemoval(f.account, { ...f.request, targetProviderId: 'different' })).rejects.toThrow();
  const record = (await f.storage.read(f.account.id))!;
  await f.storage.save({ ...record, workingBytes: f.bytes, workingSha256: f.request.expectedWorkingSha256 }, record.revision);
  const restored = await f.storage.read(f.account.id); f.provider.lock();
  expect(await f.service.persistSourceRemoval(f.account, f.request)).toEqual(receipt); expect(await f.storage.read(f.account.id)).toEqual(restored);
});

it.each(['uuid', 'name', 'broken'] as const)('detects unselected incoming native field references by %s', async kind => {
  const f = await fixture('local-file', 4, 0, db => {
    const entries = [...db.getDefaultGroup().allEntries()], target = entries.find(entry => entry.fields.get('Title') === 'Member 0')!, owner = entries.find(entry => entry.fields.get('Title') === 'Untouched')!;
    owner.fields.set('UserName', kind === 'uuid' ? `{REF:U@I:${normalizeUuid(target.uuid.toString()).toUpperCase()}}` : kind === 'name' ? '{REF:U@T:Member 0}' : '{REF:broken');
  });
  await expect(f.service.persistSourceRemoval(f.account, f.request)).rejects.toThrow('字段引用');
  expect((await f.storage.read(f.account.id))!.workingBytes).toEqual(f.bytes);
});

it('accepts a fully selected native reference component without rewriting its fields', async () => {
  const f = await fixture('local-file', 4, 0, db => {
    const entries = [...db.getDefaultGroup().allEntries()], owner = entries.find(entry => entry.fields.get('Title') === 'Member 0')!, target = entries.find(entry => entry.fields.get('Title') === 'Member 1')!;
    owner.fields.set('UserName', `{REF:U@I:${normalizeUuid(target.uuid.toString()).toUpperCase()}}`);
  });
  await f.service.persistSourceRemoval(f.account, f.request);
  expect((await openKeePassVault((await f.storage.read(f.account.id))!.workingBytes, { password, databaseId: 1, providerId: f.account.id })).items.filter(item => item.deletedAt)).toHaveLength(3);
});

it('repairs a disabled recycle bin without permanent deletion and refuses a root recycle bin', async () => {
  const f = await fixture('local-file', 4, 0, db => { db.meta.recycleBinEnabled = false; });
  await f.service.persistSourceRemoval(f.account, f.request);
  expect((await openKeePassVault((await f.storage.read(f.account.id))!.workingBytes, { password, databaseId: 1, providerId: f.account.id })).items).toHaveLength(4);
  const broken = await fixture('local-file', 4, 0, db => { db.meta.recycleBinUuid = db.getDefaultGroup().uuid; });
  await expect(broken.service.persistSourceRemoval(broken.account, broken.request)).rejects.toThrow();
  expect((await broken.storage.read(broken.account.id))!.workingBytes).toEqual(broken.bytes);
});

it('rejects malformed source identity and removal receipts without exposing native payloads', async () => {
  const f = await fixture();
  for (const request of [{ ...f.request, version: 2 }, { ...f.request, targetProviderId: f.account.id },
    { ...f.request, sources: [...f.request.sources, f.request.sources[0]] }])
    expect(() => keePassSourceRemovalRequestHash(f.account, request as KeePassSourceRemovalRequest)).toThrow();
  const receipt = await f.service.persistSourceRemoval(f.account, f.request);
  if (receipt.result.type !== 'transfer-source-remove') throw new Error('Wrong receipt');
  const result = receipt.result;
  expect(() => validateKeePassDurableMutationReceipt({ ...receipt, result: { ...result, entries: [...result.entries, result.entries[0]] } })).toThrow();
  expect(() => validateKeePassDurableMutationReceipt({ ...receipt, result: { ...result, recycleBinUuid: 'broken' } })).toThrow();
  expect(() => validateKeePassDurableMutationReceipt({ ...receipt, result: { ...result, entries: [{ ...result.entries[0], entryUuid: result.recycleBinUuid }] } })).toThrow();
  expect(() => validateKeePassDurableMutationReceipt({ ...receipt, result: { ...result, entries: [result.entries[0], { sourceItemId: 'other', entryUuid: normalizeUuid(result.entries[0].entryUuid) }] } })).toThrow();
  expect(() => validateKeePassDurableMutationReceipt({ ...receipt, kind: 'batch-transfer' })).toThrow();
});

it.each(['attachment', 'history', 'metadata'] as const)('refuses %s-only file changes even with a fresh file digest', async change => {
  const f = await fixture('webdav'), file = await openKeePassVault(f.bytes, { password, databaseId: 1, providerId: f.account.id });
  const entry = file.entriesByUuid.get(f.request.sources[0].keepassEntryUuid!)!;
  if (change === 'attachment') entry.binaries.set('original.bin', await file.database.createBinary(Uint8Array.of(11, 12).buffer));
  if (change === 'history') entry.history[0].fields.set('Password', kdbxweb.ProtectedValue.fromString('New historical secret'));
  if (change === 'metadata') entry.customData!.set('future', { value: 'Later native metadata' });
  const bytes = new Uint8Array(await file.database.save()), sha = await digest(bytes), record = (await f.storage.read(f.account.id))!;
  await f.storage.save({ ...record, workingBytes: bytes, workingSha256: sha }, record.revision);
  await f.provider.unlock(f.account, bytes, { password, sourceMode: 'webdav' });
  await expect(f.service.persistSourceRemoval(f.account, { ...f.request, expectedWorkingSha256: sha })).rejects.toThrow('已变化');
  expect((await f.storage.read(f.account.id))!.workingBytes).toEqual(bytes);
  expect(await f.storage.readReceipt(f.account.id, f.request.operationId)).toBeUndefined();
});

it.each(['skipped-project', 'malformed-project', 'numeric-sso', 'missing-sso', 'passkey-binding', 'malformed-payload'] as const)('refuses native %s relationships missing from the indexed catalog', async kind => {
  const f = await fixture('local-file', 4, 0, db => {
    const entries = [...db.getDefaultGroup().allEntries()], owner = entries.find(entry => entry.fields.get('Title') === 'Untouched')!;
    if (kind === 'skipped-project' || kind === 'malformed-project') {
      owner.fields.set(PROJECT_CREDENTIAL_FIELD, kind === 'malformed-project' ? '{broken' : entries.find(entry => entry.fields.get('Title') === 'Member 0')!.fields.get(PROJECT_CREDENTIAL_FIELD)!);
      if (kind === 'skipped-project') { owner.fields.set('MonicaItemType', 'FUTURE_TYPE'); }
    }
    if (kind === 'numeric-sso') owner.fields.set('MonicaSsoRefEntryId', '17');
    if (kind === 'missing-sso') owner.fields.set('MonicaSsoRefLogicalId', 'password:missing');
    if (kind === 'passkey-binding' || kind === 'malformed-payload') {
      const key = entries.find(entry => entry.fields.has('MonicaPasskeyData'))!;
      const value = key.fields.get('MonicaPasskeyData') as kdbxweb.ProtectedValue;
      key.fields.set('MonicaPasskeyData', kdbxweb.ProtectedValue.fromString(kind === 'malformed-payload' ? '{broken' : JSON.stringify({ ...JSON.parse(value.getText()), boundPasswordId: 17 })));
    }
  });
  await expect(f.service.persistSourceRemoval(f.account, f.request)).rejects.toThrow('关联');
  expect((await f.storage.read(f.account.id))!.workingBytes).toEqual(f.bytes);
});

it('rejects duplicate native UUIDs before touching either entry', async () => {
  const f = await fixture(), file = await openKeePassVault(f.bytes, { password, databaseId: 1, providerId: f.account.id });
  const entries = [...file.database.getDefaultGroup().allEntries()]; entries[1].uuid = entries[0].uuid;
  const expectedContentSha256 = await keePassTransferContentHash(file.database);
  await expect(applyKeePassSourceRemoval(file.database, f.account, { ...f.request, expectedContentSha256 })).rejects.toThrow();
  expect(await keePassTransferContentHash(file.database)).toBe(expectedContentSha256);
});

it('rejects duplicate group identity and additional roots before moving any entries', async () => {
  for (const kind of ['group', 'root']) {
    const f = await fixture(), file = await openKeePassVault(f.bytes, { password, databaseId: 1, providerId: f.account.id });
    const root = file.database.getDefaultGroup();
    if (kind === 'group') root.groups[0].uuid = root.uuid;
    else file.database.groups.push(kdbxweb.KdbxGroup.create('Unexpected root'));
    const expectedContentSha256 = await keePassTransferContentHash(file.database);
    await expect(applyKeePassSourceRemoval(file.database, f.account, { ...f.request, expectedContentSha256 })).rejects.toThrow();
    expect(await keePassTransferContentHash(file.database)).toBe(expectedContentSha256);
  }
});

it.each(['local-file', 'webdav', 'onedrive'] as const)('commits simultaneous %s retries once and recovers the same receipt', async mode => {
  const f = await fixture(mode);
  const other = mode === 'local-file' ? new KeePassLocalWorkingCopyService(f.provider, f.storage) : new KeePassRemoteSessionService(f.provider, f.storage);
  const results = await Promise.allSettled([f.service.persistSourceRemoval(f.account, f.request), other.persistSourceRemoval(f.account, f.request)]);
  expect(results.some(result => result.status === 'fulfilled')).toBe(true);
  const saved = await f.storage.read(f.account.id); expect(saved!.revision).toBe(2);
  expect(await other.persistSourceRemoval(f.account, f.request)).toEqual(await f.service.persistSourceRemoval(f.account, f.request));
  expect(await f.storage.read(f.account.id)).toEqual(saved);
});
