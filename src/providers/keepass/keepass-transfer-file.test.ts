import { expect, it, vi } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { createLoginItem, type LoginItem, type PasskeyItem, type ProviderAccount } from '../../core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../../core/project-credentials';
import { buildKeePassFixture } from './keepass-fixture';
import { openKeePassVault } from './keepass-vault';
import { KeePassProvider } from './keepass-provider';
import { KeePassLocalWorkingCopyService } from './keepass-local-working-copy';
import { KeePassRemoteSessionService } from './keepass-remote-session';
import { MemoryKeePassWorkingCopyStorage } from './keepass-working-copy-store';
import { createKeePassCacheEncryptionKey } from './keepass-receipt-crypto';
import type { KeePassTransferDraft } from './keepass-transfer-file';
import { base64ToBytes, bytesToBase64 } from '../../security/encoding';
import { normalizeUuid } from './keepass-field-reference';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const password = 'fixture master password';
const digest = async (value: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', value.slice().buffer))].map(b => b.toString(16).padStart(2, '0')).join('');

async function fixture(mode: 'local-file' | 'webdav' | 'onedrive' = 'local-file', version: 3 | 4 = 4, targetMinor = 1) {
  const source = await buildKeePassFixture({ version, entries: [0, 1].map(n => ({ title: `Source ${n}`, group: 'Source / group',
    fields: { UserName: '  original user  ', URL: 'https://example.invalid/', Notes: 'original notes' },
    protectedFields: { Password: `original secret ${n}`, UnknownFuture: '  \r\n中文\t  ', [PROJECT_CREDENTIAL_FIELD]: JSON.stringify({
      version: 1, projectId: id(1), groupId: id(2), passwordId: id(3 + n), label: 'Group', primary: true, groupOrder: 0, passwordOrder: n
    }).replace(/}$/, ',"future":9007199254740993}') }, binaries: { 'current.bin': Uint8Array.of(1, 3, n) } })) });
  const opened = await openKeePassVault(source, { password, databaseId: 1, providerId: 'source' });
  if (version === 4) opened.database.header.versionMinor = 1;
  for (const entry of opened.entriesByUuid.values()) {
    entry.customData = new Map([['future', { value: 'native metadata', lastModified: new Date('2026-10-01T00:00:00Z') }]]);
    entry.qualityCheck = false;
    entry.pushHistory();
    entry.history[0].fields.set('Password', kdbxweb.ProtectedValue.fromString('older secret'));
    entry.history[0].customData = new Map([['history-future', { value: 'history metadata' }]]);
    entry.history[0].qualityCheck = false;
    entry.history[0].binaries.set('old.bin', await opened.database.createBinary(Uint8Array.of(9, 7, 5).buffer));
  }
  const sourceBytes = new Uint8Array(await opened.database.save());
  let targetBytes = await buildKeePassFixture({ version, entries: [{ title: 'Untouched', protectedFields: { Password: 'target secret' }, group: 'Destination' }] });
  if (version === 4) {
    const targetFile = await openKeePassVault(targetBytes, { password, databaseId: 2, providerId: 'target' });
    targetFile.database.header.versionMinor = targetMinor; targetBytes = new Uint8Array(await targetFile.database.save());
  }
  const account = (providerId: string, bytes: Uint8Array, sourceMode: typeof mode, databaseId: number): ProviderAccount => ({
    id: providerId, kind: 'keepass', name: providerId, enabled: true, isDefaultSaveTarget: false, config: {
      sourceMode, databaseId, databasePassword: sourceMode === 'local-file' ? undefined : password,
      webDavBaseUrl: 'http://127.0.0.1:8787', remotePath: '/synthetic.kdbx', oneDriveDriveId: 'synthetic-drive', oneDriveItemId: 'synthetic-item',
      cacheEncryptionKey: createKeePassCacheEncryptionKey() } });
  const sourceAccount = account('source', sourceBytes, 'local-file', 1), target = account('target', targetBytes, mode, 2);
  sourceAccount.config.localFileSourceSha256 = await digest(sourceBytes);
  if (mode === 'local-file') target.config.localFileSourceSha256 = await digest(targetBytes);
  const provider = new KeePassProvider();
  await provider.unlock(sourceAccount, sourceBytes, { password, sourceMode: 'local-file' });
  await provider.unlock(target, targetBytes, { password, sourceMode: mode });
  const originals = (await provider.sync(sourceAccount, { now: '2026-10-11T00:00:00Z', localItems: [] })).items as LoginItem[];
  const storage = new MemoryKeePassWorkingCopyStorage();
  const local = new KeePassLocalWorkingCopyService(provider, storage), remote = new KeePassRemoteSessionService(provider, storage);
  const sha = await digest(targetBytes);
  if (mode === 'local-file') await local.initialize(target, targetBytes);
  else await storage.save({ providerId: target.id, baseBytes: targetBytes, workingBytes: targetBytes, baseSha256: sha,
    workingSha256: sha, baseEtag: '"original"', updatedAt: '2026-10-11T00:00:00Z' }, 0);
  const destination = provider.listGroups(target).items.find(row => row.name === 'Destination')!;
  const draft: KeePassTransferDraft = { operationId: id(90), createdAt: '2026-10-11T00:00:01Z', action: 'copy',
    targetGroupUuid: provider.groupUuidForHandle(target.id, destination.groupId), rows: originals.map(source => ({ source })) };
  const service = mode === 'local-file' ? local : remote;
  return { provider, sourceAccount, sourceBytes, target, targetBytes, originals, storage, service, request: { expectedWorkingSha256: sha, draft } };
}

it.each(['local-file', 'webdav', 'onedrive'] as const)('atomically persists a native project with history, unknown fields and files for %s', async mode => {
  const f = await fixture(mode);
  const receipt = await f.service.persistTransfer(f.target, f.request);
  expect(receipt.result.type).toBe('batch-transfer');
  if (receipt.result.type !== 'batch-transfer') throw new Error('Wrong receipt');
  expect(receipt.result.entries).toHaveLength(2);
  expect(f.provider.summarize(f.target.id).itemCount).toBe(1);
  const stored = (await f.storage.read(f.target.id))!;
  expect(stored.baseBytes).toEqual(f.targetBytes); expect(stored.revision).toBe(2);
  const opened = await openKeePassVault(stored.workingBytes, { password, providerId: f.target.id, databaseId: 2 });
  expect(opened.items).toHaveLength(3);
  const copied = opened.items.filter(row => row.title.startsWith('Source')) as LoginItem[];
  expect(new Set(copied.map(row => row.passwordGroupId)).size).toBe(1);
  expect(copied[0].passwordGroupId).not.toBe(id(1));
  for (const row of copied) {
    expect(row.customFields.find(field => field.name === PROJECT_CREDENTIAL_FIELD)?.value).toContain('9007199254740993');
    expect(row.keepassGroupPath).toBe('Destination');
    expect(row.keepassEntryUuid).not.toBe(f.originals.find(source => source.title === row.title)!.keepassEntryUuid);
    const entry = opened.entriesByUuid.get(row.keepassEntryUuid!)!;
    expect((entry.fields.get('UnknownFuture') as kdbxweb.ProtectedValue).getText()).toBe('  \r\n中文\t  ');
    expect(entry.customData?.get('future')?.value).toBe('native metadata'); expect(entry.qualityCheck).toBe(false);
    expect(entry.history).toHaveLength(1);
    expect(entry.history[0].customData?.get('history-future')?.value).toBe('history metadata');
    expect(entry.history[0].uuid.toString()).toBe(entry.uuid.toString());
    expect((entry.history[0].fields.get('Password') as kdbxweb.ProtectedValue).getText()).toBe('older secret');
    expect(entry.binaries.has('current.bin')).toBe(true); expect(entry.history[0].binaries.has('old.bin')).toBe(true);
  }
  expect((await f.provider.sync(f.sourceAccount, { now: '2026-10-11T00:00:02Z', localItems: [] })).items.map(row => row.keepassEntryUuid))
    .toEqual(f.originals.map(row => row.keepassEntryUuid));
  expect(JSON.stringify(await f.storage.readReceipt(f.target.id, id(90)))).not.toContain('secret');
  // Restart recovery returns the committed mapping even without either live source.
  const provider = new KeePassProvider(), next = mode === 'local-file' ? new KeePassLocalWorkingCopyService(provider, f.storage) : new KeePassRemoteSessionService(provider, f.storage);
  expect(await next.persistTransfer({ ...f.target, config: { ...f.target.config, workingSha256: stored.workingSha256 } }, f.request)).toEqual(receipt);
  expect((await f.storage.read(f.target.id))!.revision).toBe(2);
});

it.each(['before', 'after', 'race'] as const)('recovers a %s-save failure without a partial batch or duplicated native entries', async failure => {
  const f = await fixture(), save = f.storage.save.bind(f.storage);
  vi.spyOn(f.storage, 'save').mockImplementationOnce(async (input, revision, receipt) => {
    if (failure === 'before') throw new Error('Synthetic disk error');
    if (failure === 'race') await save({ ...input, workingBytes: f.targetBytes, workingSha256: f.request.expectedWorkingSha256 }, revision);
    await save(input, revision, receipt);
    if (failure === 'after') throw new Error('Synthetic lost reply');
    throw new Error('Unexpected');
  });
  await expect(f.service.persistTransfer(f.target, f.request)).rejects.toThrow();
  if (failure !== 'after') expect((await f.storage.read(f.target.id))!.workingBytes).toEqual(f.targetBytes);
  const result = await f.service.persistTransfer(f.target, f.request);
  expect(result.result.type).toBe('batch-transfer');
  const opened = await openKeePassVault((await f.storage.read(f.target.id))!.workingBytes, { password, providerId: 'target', databaseId: 2 });
  expect(opened.items).toHaveLength(3);
});

it('refuses a native metadata downgrade instead of silently dropping KDBX 4.1 content', async () => {
  const f = await fixture('local-file', 4, 0);
  await expect(f.service.persistTransfer(f.target, f.request)).rejects.toThrow(/4.1 元数据/);
  expect((await f.storage.read(f.target.id))!.workingBytes).toEqual(f.targetBytes);
});

it.each(['target', 'source'] as const)('cancels a %s lock after file preparation but before encrypted commit', async side => {
  const f = await fixture(), prepare = f.provider.prepareTransferFile.bind(f.provider);
  vi.spyOn(f.provider, 'prepareTransferFile').mockImplementationOnce(async (...args) => {
    const result = await prepare(...args); f.provider.lockAccount(side === 'target' ? f.target.id : f.sourceAccount.id); return result;
  });
  await expect(f.service.persistTransfer(f.target, f.request)).rejects.toThrow(/锁定/);
  expect((await f.storage.read(f.target.id))!.workingBytes).toEqual(f.targetBytes);
});

it('moves a native project within the same file without rewriting keys, fields, history or entry IDs', async () => {
  const f = await fixture(), storage = new MemoryKeePassWorkingCopyStorage();
  const service = new KeePassLocalWorkingCopyService(f.provider, storage);
  await service.initialize(f.sourceAccount, f.sourceBytes);
  const request = { expectedWorkingSha256: await digest(f.sourceBytes), draft: { ...f.request.draft, action: 'move' as const, targetGroupUuid: undefined } };
  await service.persistTransfer(f.sourceAccount, request);
  const opened = await openKeePassVault((await storage.read(f.sourceAccount.id))!.workingBytes, { password, providerId: 'source', databaseId: 1 });
  expect(opened.items.map(row => row.keepassEntryUuid).sort()).toEqual(f.originals.map(row => row.keepassEntryUuid).sort());
  expect(opened.items.every(row => !row.keepassGroupPath)).toBe(true);
  for (const entry of opened.entriesByUuid.values()) {
    expect(entry.history).toHaveLength(1); expect(entry.customData?.get('future')?.value).toBe('native metadata');
    expect(entry.qualityCheck).toBe(false);
    expect((entry.fields.get(PROJECT_CREDENTIAL_FIELD) as kdbxweb.ProtectedValue).getText()).toContain(id(1));
  }
});

it('preserves shared ancestors while keeping same-named folders from different sources separate', async () => {
  const f = await fixture();
  const sources = ['a', 'b', 'c'].map(title => createLoginItem({ title, password: 'synthetic', providerRefs: [{ providerId: title === 'c' ? 'other' : 'local' }] }));
  f.request.draft.rows = sources.map((source, n) => ({ source, attachments: [],
    folder: { identities: ['parent-id', n === 1 ? 'second-id' : 'first-id'], segments: ['Folder / A', n === 1 ? 'Second' : 'First'] } }));
  await f.service.persistTransfer(f.target, f.request);
  const opened = await openKeePassVault((await f.storage.read(f.target.id))!.workingBytes, { password, providerId: 'target', databaseId: 2 });
  const destination = opened.database.getDefaultGroup().groups.find(row => row.name === 'Destination')!;
  expect(destination.groups).toHaveLength(2);
  expect(destination.groups.map(group => group.groups.length).sort()).toEqual([1, 2]);
  expect(opened.items.filter(row => row.title !== 'Untouched').every(row => row.keepassGroupPath?.includes('Folder%20%2F%20A'))).toBe(true);
});

it('never recreates a later-deleted target when a committed transfer is retried', async () => {
  const f = await fixture(), receipt = await f.service.persistTransfer(f.target, f.request);
  const stored = (await f.storage.read(f.target.id))!;
  await f.provider.unlock(f.target, stored.workingBytes, { password, sourceMode: 'local-file' });
  const items = (await f.provider.sync(f.target, { now: '2026-10-11T00:00:02Z', localItems: [] })).items;
  await f.provider.remove(f.target, items.find(row => row.title === 'Source 0')!);
  await f.service.persistWorkingCopy(f.target);
  const later = (await f.storage.read(f.target.id))!;
  f.provider.lock();
  const next = new KeePassLocalWorkingCopyService(new KeePassProvider(), f.storage);
  expect(await next.persistTransfer(f.target, f.request)).toEqual(receipt);
  expect(await f.storage.read(f.target.id)).toEqual(later);
  const opened = await openKeePassVault(later.workingBytes, { password, providerId: 'target', databaseId: 2 });
  expect(opened.items.filter(row => row.title === 'Source 0')).toHaveLength(1);
  expect(opened.items.find(row => row.title === 'Source 0')!.deletedAt).toBeTruthy();
});

it('rejects unsupported portable fields and invalid filenames without silently dropping user data', async () => {
  for (const problem of ['field', 'filename']) {
    const f = await fixture(), source: LoginItem = { ...createLoginItem({ title: 'Portable', password: 'secret' }),
      ...(problem === 'field' ? { barcodeData: '{"future":9007199254740993}' } : {}) };
    f.request.draft.rows = [{ source, attachments: problem === 'filename' ? [{ itemId: source.id, attachmentId: 'file',
      fileName: 'file\u0000.bin', sizeBytes: 1, sha256: await digest(Uint8Array.of(1)), dataBase64: 'AQ==' }] : [] }];
    await expect(f.service.persistTransfer(f.target, f.request)).rejects.toThrow(problem === 'field' ? /barcodeData/ : /附件名称/);
    expect((await f.storage.read(f.target.id))!.workingBytes).toEqual(f.targetBytes);
  }
});

it('rejects a changed recovery request and a target edit after preparation', async () => {
  const f = await fixture(), prepare = f.provider.prepareTransferFile.bind(f.provider);
  vi.spyOn(f.provider, 'prepareTransferFile').mockImplementationOnce(async (...args) => {
    const result = await prepare(...args);
    f.provider.createGroup(f.target, id(77), 'Concurrent change'); return result;
  });
  await expect(f.service.persistTransfer(f.target, f.request)).rejects.toThrow(/目标 KeePass.*变化/);
  expect((await f.storage.read(f.target.id))!.workingBytes).toEqual(f.targetBytes);
  await expect(f.service.persistTransfer(f.target, f.request)).rejects.toThrow(/未持久保存/);
  const persisted = await f.service.persistWorkingCopy(f.target);
  f.request.expectedWorkingSha256 = persisted!.workingSha256;
  await f.service.persistTransfer(f.target, f.request);
  const opened = await openKeePassVault((await f.storage.read(f.target.id))!.workingBytes, { password, providerId: 'target', databaseId: 2 });
  expect(opened.database.getDefaultGroup().groups.some(group => group.name === 'Concurrent change')).toBe(true);
  const changed = structuredClone(f.request); changed.draft.rows[0].source.title = 'Changed replay';
  await expect(f.service.persistTransfer(f.target, changed)).rejects.toThrow();
});

it.each([3, 4] as const)('copies foreign rich credentials, protected attachment bytes and password history into KDBX %s', async version => {
  const f = await fixture('local-file', version), source: LoginItem = { ...createLoginItem({ title: 'Portable', username: 'user', password: 'new secret',
    uris: ['https://example.invalid/'] }), notes: '\r\nnotes\t', email: 'a@example.invalid', phone: '123', loginType: 'SSH_KEY',
    sshKeyData: JSON.stringify({ privateKeyOpenSsh: 'synthetic private key', publicKeyOpenSsh: 'synthetic public key', algorithm: 'ed25519' }),
    customFields: [{ name: 'future', value: '  protected future  ', protected: true }],
    passwordHistory: [{ password: 'old secret', lastUsedAt: '2026-10-01T00:00:00Z' }] };
  const bytes = Uint8Array.of(0, 255, 1, 2, 3);
  f.request.draft.rows = [{ source, attachments: [{ itemId: source.id, attachmentId: 'attachment', fileName: 'steam.maFile',
    sizeBytes: bytes.length, sha256: await digest(bytes), dataBase64: bytesToBase64(bytes), protected: true }] }];
  await f.service.persistTransfer(f.target, f.request);
  const opened = await openKeePassVault((await f.storage.read(f.target.id))!.workingBytes, { password, providerId: 'target', databaseId: 2 });
  const item = opened.items.find(row => row.title === 'Portable') as LoginItem;
  expect(item).toMatchObject({ password: source.password, username: source.username, notes: source.notes, email: source.email, phone: source.phone });
  expect(item.customFields).toContainEqual(source.customFields[0]);
  const entry = opened.entriesByUuid.get(item.keepassEntryUuid!)!;
  const binary = entry.binaries.get('steam.maFile')!;
  const value = kdbxweb.KdbxBinaries.isKdbxBinaryWithHash(binary) ? binary.value : binary;
  expect(value).toBeInstanceOf(kdbxweb.ProtectedValue);
  expect((value as kdbxweb.ProtectedValue).getBinary()).toEqual(bytes);
  expect((entry.history[0].fields.get('Password') as kdbxweb.ProtectedValue).getText()).toBe('old secret');
});

it.each(['missing-member', 'changed-source', 'locked-source', 'bad-file', 'bad-attachment', 'foreign-move'] as const)('rejects %s before committing any destination bytes', async failure => {
  const f = await fixture();
  if (failure === 'missing-member') f.request.draft.rows.pop();
  if (failure === 'changed-source') await f.provider.update(f.sourceAccount, { ...f.originals[0], password: 'changed' });
  if (failure === 'locked-source') f.provider.lockAccount(f.sourceAccount.id);
  if (failure === 'bad-file') f.request.expectedWorkingSha256 = 'f'.repeat(64);
  if (failure === 'foreign-move') f.request.draft.action = 'move';
  if (failure === 'bad-attachment') {
    const source = createLoginItem({ title: 'Invalid files', password: 'secret' });
    f.request.draft.rows = [{ source, attachments: [{ itemId: source.id, attachmentId: 'bad', fileName: 'bad.bin',
      sizeBytes: 1, dataBase64: 'AQ==', sha256: '0'.repeat(64) }] }];
  }
  await expect(f.service.persistTransfer(f.target, f.request)).rejects.toThrow();
  expect((await f.storage.read(f.target.id))!.workingBytes).toEqual(f.targetBytes);
  expect(await f.storage.readReceipt(f.target.id, id(90))).toBeUndefined();
  expect(f.provider.summarize(f.target.id).itemCount).toBe(1);
});

it('copies a zero-counter Passkey without changing its private key and refuses a second credential copy', async () => {
  const f = await fixture();
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const key = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)));
  const source: PasskeyItem = { id: id(60), kind: 'passkey', title: 'Passkey', favorite: false, notes: '', createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z', providerRefs: [], credentialId: 'AQIDBA', privateKeyPkcs8: key, rpId: 'example.invalid',
    rpName: 'Synthetic', publicKey: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))), discoverable: true,
    userName: 'synthetic', userDisplayName: 'Synthetic', userHandle: 'BQYH', signCount: 0, algorithm: -7, sourceMode: 'browser-local',
    backupEligible: true, backupState: true };
  f.request.draft.rows = [{ source, attachments: [] }];
  await f.service.persistTransfer(f.target, f.request);
  const stored = (await f.storage.read(f.target.id))!;
  const opened = await openKeePassVault(stored.workingBytes, { password, providerId: 'target', databaseId: 2 });
  const copied = opened.items.find(row => row.kind === 'passkey') as PasskeyItem;
  expect(copied).toMatchObject({ credentialId: source.credentialId, privateKeyPkcs8: key, signCount: 0, backupEligible: true, backupState: true });
  if (!copied.privateKeyPkcs8) throw new Error('Missing private key');
  const imported = await crypto.subtle.importKey('pkcs8', base64ToBytes(copied.privateKeyPkcs8).slice().buffer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const challenge = Uint8Array.of(9, 8, 7), signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, imported, challenge);
  expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, signature, challenge)).toBe(true);
  await f.provider.unlock(f.target, stored.workingBytes, { password, sourceMode: 'local-file' });
  await expect(f.service.persistTransfer(f.target, { expectedWorkingSha256: stored.workingSha256,
    draft: { ...f.request.draft, operationId: id(91) } })).rejects.toThrow(/相同 Passkey/);
  expect((await f.storage.read(f.target.id))!.revision).toBe(2);
});

it('resolves native base64 UUIDs and rebinds standard hex REF tokens to the copied project', async () => {
  const f = await fixture();
  const original = await openKeePassVault(f.sourceBytes, { password, providerId: 'source', databaseId: 1 });
  const [first, second] = [...original.entriesByUuid.values()];
  first.fields.set('UserName', `{REF:U@I:${normalizeUuid(second.uuid.toString()).toUpperCase()}}`);
  second.fields.set('UserName', 'Referenced user');
  const bytes = new Uint8Array(await original.database.save());
  await f.provider.unlock(f.sourceAccount, bytes, { password, sourceMode: 'local-file' });
  const items = (await f.provider.sync(f.sourceAccount, { now: '2026-10-11T00:00:00Z', localItems: [] })).items;
  expect((items.find(row => row.keepassEntryUuid === first.uuid.toString()) as LoginItem).username).toBe('Referenced user');
  f.request.draft.rows = items.map(source => ({ source }));
  await f.service.persistTransfer(f.target, f.request);
  const copied = await openKeePassVault((await f.storage.read(f.target.id))!.workingBytes, { password, providerId: 'target', databaseId: 2 });
  const newFirst = copied.items.find(row => row.title === 'Source 0') as LoginItem, newSecond = copied.items.find(row => row.title === 'Source 1')!;
  expect(newFirst.username).toBe('Referenced user');
  expect(copied.entriesByUuid.get(newFirst.keepassEntryUuid!)!.fields.get('UserName')).toBe(`{REF:U@I:${normalizeUuid(newSecond.keepassEntryUuid!).toUpperCase()}}`);
  expect(newSecond.keepassEntryUuid).not.toBe(second.uuid.toString());
});
