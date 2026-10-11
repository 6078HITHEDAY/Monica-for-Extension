import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEmptyVaultState, createLoginItem, type LoginItem, type PasskeyItem, type ProviderAccount, type VaultItem, type VaultState } from '../core/model';
import { applyLocalTransferBatch, prepareLocalTransferBatch, readLocalTransferReceipts, type LocalItemAttachment, type LocalTransferRequest, type LocalTransferResource } from '../core/local-transfer';
import { PROJECT_CREDENTIAL_FIELD, readProjectCredential } from '../core/project-credentials';
import { resolveBoundNote } from '../core/bound-notes';
import { resolveSsoAccount } from '../core/sso-links';
import { createDeviceVaultKey, encryptVaultState, decryptVaultState, type VaultEnvelope } from './vault-crypto';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage, type VaultEnvelopeStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';
import { MemoryVaultDeviceKeyStore } from './vault-device-key';
import { bytesToBase64, base64ToBytes } from './encoding';
import { mdbx2TransferOperationScope } from '../providers/mdbx2/mdbx2-transfer-identity';

const NOW = '2026-10-11T12:00:00.000Z';
const ID = '81111111-1111-4111-8111-111111111111';
const GROUP = '82222222-2222-4222-8222-222222222222';
const REMOTE: ProviderAccount = { id: 'synthetic-bitwarden', kind: 'bitwarden', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false, config: { apiUrl: 'https://example.invalid' } };

function request(state: VaultState, itemIds = [state.items[0].id], patch: Partial<LocalTransferRequest> = {}): LocalTransferRequest {
  return { operationId: ID, createdAt: NOW, itemIds, targetProviderId: state.providers.find(p => p.kind === 'local')!.id,
    action: 'copy', preserveCategories: true, ...patch };
}

function project(): VaultItem[] {
  const one = createLoginItem({ title: 'Synthetic project', username: 'alice', password: 'first secret', uris: ['https://example.invalid'] });
  const two = createLoginItem({ title: 'Synthetic project', username: 'bob', password: 'second secret' });
  for (const [index, row] of [one, two].entries()) {
    row.passwordGroupId = GROUP; row.categoryId = 7; row.categoryName = 'Personal';
    row.customFields = [{ name: 'blank', value: '', protected: true, future: { rank: 9007199254740991 } } as never,
      { name: PROJECT_CREDENTIAL_FIELD, value: JSON.stringify({ version: 1, projectId: GROUP, groupId: GROUP,
        passwordId: index ? GROUP : ID, label: `Group ${index}`, primary: !index, groupOrder: 0, passwordOrder: index, future: 'retained' }), protected: false }];
    row.passwordHistory = [{ password: `previous ${index}`, lastUsedAt: NOW }];
    row.passkeyBindings = '{"future":9007199254740993}'; row.sshKeyData = '{"private":"opaque"}';
    row.steamRawJson = '{"SteamID":76561199999999999,"shared_secret":"opaque"}';
  }
  const note: VaultItem = { ...createLoginItem({ title: 'Linked note' }), kind: 'secure-note', content: 'Private linked content' };
  const account = createLoginItem({ title: 'SSO identity', password: 'SSO secret' });
  const otp: VaultItem = { ...createLoginItem({ title: 'OTP' }), kind: 'totp', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, boundPasswordId: 91 };
  one.boundNoteEntryId = `note:${note.id}`; one.boundNoteId = 20;
  one.ssoRefLogicalId = `password:${account.id}`; one.ssoRefEntryId = 30;
  one.boundTotpItemId = otp.id;
  return [one, two, note, account, otp];
}

async function file(itemId: string, data = 'synthetic private maFile', attachmentId = 'file-1'): Promise<LocalItemAttachment> {
  const bytes = new TextEncoder().encode(data);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return { itemId, attachmentId, fileName: 'steam.maFile', mediaType: 'application/json', sizeBytes: bytes.length,
    sha256: [...digest].map(n => n.toString(16).padStart(2, '0')).join(''), dataBase64: bytesToBase64(bytes) };
}

async function fixture(items = project()) {
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore(), keys = new MemoryVaultDeviceKeyStore();
  const service = new SecureVaultService(storage, sessions, Date.now, keys);
  await service.setup('', items);
  return { service, storage, sessions, keys };
}

describe('atomic local transfer', () => {
  it('copies all project members and rebinds note, SSO and OTP without losing rich fields or historical secrets', async () => {
    const { service } = await fixture();
    const before = await service.readState(), source = before.items[0] as LoginItem;
    const prepared = await service.prepareLocalTransfer(request(before));
    expect(prepared.batch.items).toHaveLength(5);
    await service.commitLocalTransfer(prepared);
    const after = await service.readState(), copies = prepared.batch.receipt.entries.map(entry => after.items.find(row => row.id === entry.targetItemId)!);
    const copied = copies.find(row => row.kind === 'login' && row.username === 'alice') as LoginItem;
    const sibling = copies.find(row => row.kind === 'login' && row.username === 'bob') as LoginItem;
    expect(copied.passwordGroupId).not.toBe(source.passwordGroupId);
    expect(copied.passwordGroupId).toBe(sibling.passwordGroupId);
    expect(readProjectCredential(copied.customFields)?.passwordId).toBe(ID);
    expect(readProjectCredential(copied.customFields)?.projectId).toBe(copied.passwordGroupId);
    for (const field of ['password', 'passwordHistory', 'passkeyBindings', 'sshKeyData', 'steamRawJson'] as const) expect(copied[field]).toEqual(source[field]);
    expect(copied.customFields[0]).toEqual(source.customFields[0]);
    expect(JSON.parse(copied.customFields[1].value).future).toBe('retained');
    expect(resolveBoundNote(copied, after.items)?.id).toBe(copies.find(row => row.kind === 'secure-note')!.id);
    expect(resolveSsoAccount(copied, after.items)?.id).toBe(copies.find(row => row.title === 'SSO identity')!.id);
    expect(copies.find(row => row.kind === 'totp')?.id).toBe(copied.boundTotpItemId);
    expect(copies.find(row => row.kind === 'totp')?.boundPasswordId).toBeUndefined();
    expect(copied.boundNoteId).toBeUndefined(); expect(copied.ssoRefEntryId).toBeUndefined();
    expect(after.items.filter(row => before.items.some(old => old.id === row.id))).toEqual(before.items);
    expect(after.mutationQueue).toEqual(before.mutationQueue);
  });

  it('moves the full local dependency group to an existing folder in one confirmed transaction', async () => {
    const folder = { ...createLoginItem({ title: 'Folder anchor' }), categoryId: 2, categoryName: 'Work' };
    const { service } = await fixture([...project(), folder]);
    const before = await service.readState();
    const prepared = await service.prepareLocalTransfer(request(before, undefined, { action: 'move', preserveCategories: false, targetFolder: 'id:2' }));
    await expect(service.commitLocalTransfer(prepared)).rejects.toThrow('明确确认');
    expect(await service.readState()).toEqual(before);
    await service.commitLocalTransfer(prepared, true);
    const after = await service.readState();
    expect(after.items).toHaveLength(before.items.length);
    expect(after.items.every(row => row.categoryId === 2 && row.categoryName === 'Work')).toBe(true);
    expect(new Set(after.items.map(row => row.id))).toEqual(new Set(before.items.map(row => row.id)));
  });

  it.each(['edit', 'add-member', 'delete', 'folder'] as const)('rejects a stale %s before any encrypted write', async change => {
    const { service, storage } = await fixture();
    const before = await service.readState(), prepared = await service.prepareLocalTransfer(request(before));
    if (change === 'add-member') await service.upsertItem({ ...before.items[1], id: crypto.randomUUID() });
    else await service.upsertItem({ ...before.items[0], ...(change === 'delete' ? { deletedAt: NOW } : change === 'folder' ? { categoryName: 'Renamed' } : { notes: 'later edit' }) });
    const envelope = await storage.read();
    await expect(service.commitLocalTransfer(prepared)).rejects.toThrow();
    expect(await storage.read()).toEqual(envelope);
  });

  it('replays after a lost success response and service restart without overwriting later edits or resurrecting deleted targets', async () => {
    const { service, storage, sessions, keys } = await fixture();
    const before = await service.readState(), prepared = await service.prepareLocalTransfer(request(before));
    const write = storage.write.bind(storage);
    let loseResponse = true;
    vi.spyOn(storage, 'write').mockImplementation(async value => { await write(value); if (loseResponse) { loseResponse = false; throw new Error('synthetic lost response'); } });
    await expect(service.commitLocalTransfer(prepared)).rejects.toThrow('lost response');
    const restarted = new SecureVaultService(storage, sessions, Date.now, keys);
    const targetId = prepared.batch.receipt.entries[0].targetItemId;
    await restarted.upsertItem({ ...(await restarted.getItem(targetId))!, notes: 'after commit', deletedAt: NOW });
    await restarted.upsertItem({ ...before.items[0], notes: 'later source edit' });
    const preserved = await storage.read();
    expect((await restarted.commitLocalTransfer(prepared)).replayed).toBe(true);
    expect(await storage.read()).toEqual(preserved);
    expect((await restarted.readState()).items.find(row => row.id === targetId)!.deletedAt).toBe(NOW);
  });

  it('leaves the entire vault unchanged on storage failure and retries with the same identities', async () => {
    const { service, storage } = await fixture();
    const before = await service.readState(), envelope = await storage.read();
    const prepared = await service.prepareLocalTransfer(request(before));
    const spy = vi.spyOn(storage, 'write').mockRejectedValueOnce(new Error('synthetic disk full'));
    await expect(service.commitLocalTransfer(prepared)).rejects.toThrow('disk full');
    expect(await storage.read()).toEqual(envelope);
    expect(await service.readState()).toEqual(before);
    await service.commitLocalTransfer(prepared);
    expect(spy).toHaveBeenCalledTimes(2);
    expect((await service.readState()).localTransferReceipts).toEqual([prepared.batch.receipt]);
  });

  it('does not apply a prepared transfer in a different unlock session or after expiry during encryption', async () => {
    const { service, storage, sessions } = await fixture();
    const before = await service.readState(), prepared = await service.prepareLocalTransfer(request(before));
    const envelope = await storage.read(), originalSession = (await sessions.read())!;
    await sessions.write({ ...originalSession, id: crypto.randomUUID() });
    await expect(service.commitLocalTransfer(prepared)).rejects.toThrow();
    expect(await storage.read()).toEqual(envelope);
    await sessions.write(originalSession);
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (...args) => {
      const result = await encrypt(...args); await sessions.clear(); return result;
    });
    try { await expect(service.commitLocalTransfer(prepared)).rejects.toThrow(); }
    finally { spy.mockRestore(); }
    expect(await storage.read()).toEqual(envelope);
  });

  it('serializes concurrent duplicate commits into one result', async () => {
    const { service, storage } = await fixture();
    const before = await service.readState(), prepared = await service.prepareLocalTransfer(request(before));
    const writes = vi.spyOn(storage, 'write');
    const results = await Promise.all([service.commitLocalTransfer(prepared), service.commitLocalTransfer(prepared)]);
    expect(results.map(row => row.replayed)).toEqual([false, true]);
    expect(writes).toHaveBeenCalledTimes(1);
    expect((await service.listItems()).length).toBe(before.items.length * 2);
  });

  it('allows unrelated edits without weakening the source snapshot', async () => {
    const unrelated = createLoginItem({ title: 'Unrelated' });
    const { service } = await fixture([...project(), unrelated]);
    const before = await service.readState(), prepared = await service.prepareLocalTransfer(request(before));
    const changed = await service.upsertItem({ ...unrelated, notes: 'concurrent unrelated note' });
    await service.commitLocalTransfer(prepared);
    expect(await service.getItem(unrelated.id)).toEqual(changed);
  });
});

describe('local transfer resources and identities', () => {
  it('copies authenticated parent-Cipher source envelopes and files into independent encrypted local storage', async () => {
    const state = createEmptyVaultState(); state.providers.push(REMOTE);
    const source = { ...createLoginItem({ title: 'Steam', providerRefs: [{ providerId: REMOTE.id, remoteId: 'cipher#totp' }] }), categoryName: 'Games' };
    state.items = [source];
    state.sourceRecords = [{ providerId: REMOTE.id, remoteId: 'cipher', format: 'bitwarden.cipher', encoding: 'json', payload: '{"unknown":9007199254740993}', contentHash: 'synthetic' }];
    const attachment = await file(source.id), readback: LocalTransferResource = { expected: source, account: REMOTE,
      folder: { identity: 'remote:games', label: 'Games' }, attachments: [attachment, { ...await file(source.id, '', 'empty'), fileName: 'empty.txt' }] };
    const batch = await prepareLocalTransferBatch(state, request(state), [readback]);
    await applyLocalTransferBatch(state, batch);
    const copied = state.items.find(row => row.id !== source.id)!;
    expect(copied.providerRefs).toEqual([]);
    expect(state.localItemOrigins).toEqual([{ itemId: copied.id, records: state.sourceRecords }]);
    expect(state.localItemAttachments).toHaveLength(2);
    expect(state.localItemAttachments![0]).toMatchObject({ itemId: copied.id, dataBase64: attachment.dataBase64, sha256: attachment.sha256 });
    expect(state.localItemAttachments![0].attachmentId).not.toBe(attachment.attachmentId);
    const { key, kdf } = await createDeviceVaultKey();
    const envelope = await encryptVaultState(state, key, kdf), restored = await decryptVaultState(envelope, key);
    expect(JSON.stringify(envelope)).not.toContain(attachment.dataBase64);
    expect(JSON.stringify(envelope)).not.toContain('9007199254740993');
    expect(restored.localItemAttachments).toEqual(state.localItemAttachments);
    expect(restored.localItemOrigins).toEqual(state.localItemOrigins);
    const second = await prepareLocalTransferBatch(restored, request(restored, [copied.id], { operationId: crypto.randomUUID() }));
    expect(second.origins[0].records).toEqual(state.sourceRecords);
    expect(second.attachments[0].sha256).toBe(attachment.sha256);
  });

  it.each(['body', 'length', 'owner', 'duplicate'] as const)('rejects %s attachment corruption without mutation', async corrupt => {
    const state = createEmptyVaultState(); state.items = [createLoginItem({ title: 'Files' })];
    const attachment = await file(state.items[0].id);
    state.localItemAttachments = [{ ...attachment, ...(corrupt === 'body' ? { dataBase64: bytesToBase64(new Uint8Array(attachment.sizeBytes)) }
      : corrupt === 'length' ? { sizeBytes: 0 } : {}) }];
    if (corrupt === 'duplicate') state.localItemAttachments.push(attachment);
    const resources: LocalTransferResource[] = [];
    if (corrupt === 'owner') {
      state.providers.push(REMOTE); state.items[0].providerRefs = [{ providerId: REMOTE.id, remoteId: 'cipher' }];
      resources.push({ expected: state.items[0], account: REMOTE, attachments: [{ ...attachment, itemId: 'another-item' }] });
      state.localItemAttachments = [];
    }
    const before = structuredClone(state);
    await expect(prepareLocalTransferBatch(state, request(state), resources)).rejects.toThrow();
    expect(state).toEqual(before);
  });

  it('keeps identically named folders from different source vaults separate and reuses only their own origin', async () => {
    const state = createEmptyVaultState(), secondProvider = { ...REMOTE, id: 'second' }; state.providers.push(REMOTE, secondProvider);
    const sources = [REMOTE, secondProvider].map(p => ({ ...createLoginItem({ title: p.id, providerRefs: [{ providerId: p.id, remoteId: 'cipher' }] }), categoryName: 'Same name' }));
    state.items = sources;
    const resources = sources.map((expected, i) => ({ expected, account: [REMOTE, secondProvider][i], attachments: [], folder: { identity: 'folder-1', label: 'Same name' } }));
    const batch = await prepareLocalTransferBatch(state, request(state, sources.map(row => row.id)), resources);
    expect(new Set(batch.items.map(row => row.categoryId)).size).toBe(2);
    await applyLocalTransferBatch(state, batch);
    const another = await prepareLocalTransferBatch(state, request(state, [sources[0].id], { operationId: crypto.randomUUID() }), [resources[0]]);
    expect(another.items[0].categoryId).toBe(batch.items.find(row => row.title === sources[0].title)!.categoryId);
    expect(another.folders).toEqual([]);
  });

  it('does not treat foreign-source removal as a local transaction', async () => {
    const state = createEmptyVaultState(); state.providers.push(REMOTE);
    state.items = [createLoginItem({ title: 'Remote', providerRefs: [{ providerId: REMOTE.id, remoteId: 'cipher' }] })];
    await expect(prepareLocalTransferBatch(state, request(state, undefined, { action: 'move' }), [{ expected: state.items[0], account: REMOTE, attachments: [] }])).rejects.toThrow('持久来源删除');
  });

  it.each(['missing-note', 'sso-cycle', 'ambiguous-otp', 'numeric-passkey', 'missing-image'] as const)('preserves the source on unresolved %s', async invalid => {
    const state = createEmptyVaultState(); state.items = project(); const first = state.items[0] as LoginItem;
    if (invalid === 'missing-note') first.boundNoteEntryId = 'note:missing';
    if (invalid === 'sso-cycle') { const account = state.items[3] as LoginItem; account.ssoRefLogicalId = `password:${first.id}`; }
    if (invalid === 'ambiguous-otp') (state.items[1] as LoginItem).boundTotpItemId = first.boundTotpItemId;
    if (invalid === 'numeric-passkey') { state.items = [{ ...state.items[0], kind: 'passkey', boundPasswordId: 91 } as unknown as PasskeyItem]; }
    if (invalid === 'missing-image') first.imagePaths = ['missing.png'];
    const before = structuredClone(state);
    await expect(prepareLocalTransferBatch(state, request(state, undefined, { action: 'move' }))).rejects.toThrow();
    expect(state).toEqual(before);
  });

  it('rejects altered prepared targets and corrupt replay receipts', async () => {
    const state = createEmptyVaultState(); state.items = [createLoginItem({ title: 'Untampered' })];
    const batch = await prepareLocalTransferBatch(state, request(state));
    const tampered = structuredClone(batch); tampered.items[0].notes = 'tampered';
    await expect(applyLocalTransferBatch(state, tampered)).rejects.toThrow('预览已变化');
    const { receipt: _receipt, ...intent } = tampered; tampered.receipt.intentHash = await mdbx2TransferOperationScope(intent);
    await expect(applyLocalTransferBatch(state, tampered)).rejects.toThrow('不符合预览');
    expect(() => readLocalTransferReceipts([{ ...batch.receipt, intentHash: 'corrupt' }])).toThrow('回执无效');
    expect(() => readLocalTransferReceipts([batch.receipt, batch.receipt])).toThrow('回执无效');
    const forgedReceipt = structuredClone(batch); forgedReceipt.receipt.entries[0].targetItemId = state.items[0].id;
    await expect(applyLocalTransferBatch(state, forgedReceipt)).rejects.toThrow('不符合预览');
  });

  it.each(['attachment', 'origin'] as const)('rejects changed local %s contents even when the item timestamp is unchanged', async changed => {
    const state = createEmptyVaultState(); state.items = [createLoginItem({ title: 'Source' })];
    state.localItemAttachments = [await file(state.items[0].id)];
    state.localItemOrigins = [{ itemId: state.items[0].id, records: [{ providerId: 'old-source', remoteId: 'old-record', encoding: 'json', format: 'future', payload: '{"unknown":1}', contentHash: 'one' }] }];
    const batch = await prepareLocalTransferBatch(state, request(state));
    if (changed === 'attachment') state.localItemAttachments = [await file(state.items[0].id, 'new content')];
    else state.localItemOrigins[0].records[0].payload = '{"unknown":2}';
    const before = structuredClone(state);
    await expect(applyLocalTransferBatch(state, batch)).rejects.toThrow('发生变化');
    expect(state).toEqual(before);
  });

  it('preserves future fields and opaque payloads in local copies', async () => {
    const state = createEmptyVaultState();
    state.items = [{ ...createLoginItem({ title: 'Future native item' }), kind: 'opaque', nativeType: 'future-object', payloadSchemaVersion: 4,
      originalPayload: '{"private":9007199254740993}', readOnlyReason: 'Future schema', futureLocalField: ['private', 123] } as VaultItem];
    const batch = await prepareLocalTransferBatch(state, request(state));
    await applyLocalTransferBatch(state, batch);
    expect(batch.items[0]).toMatchObject({ originalPayload: '{"private":9007199254740993}', futureLocalField: ['private', 123], readOnlyReason: 'Future schema' });
  });

  it('refuses a missing or corrupt private key instead of silently producing a supposedly usable copy', async () => {
    const state = createEmptyVaultState(); state.providers.push(REMOTE);
    const source = { ...createLoginItem({ title: 'Broken key' }), kind: 'passkey', rpId: 'example.invalid', credentialId: ID,
      rpName: 'Synthetic', userHandle: 'dXNlcg', userName: 'synthetic', userDisplayName: 'Synthetic', publicKey: '', discoverable: true,
      sourceMode: 'bitwarden', algorithm: -7, signCount: 0, privateKeyPkcs8: 'corrupt', providerRefs: [{ providerId: REMOTE.id, remoteId: 'cipher#fido2:key' }] } as PasskeyItem;
    state.items = [source];
    await expect(prepareLocalTransferBatch(state, request(state), [{ expected: source, account: REMOTE, attachments: [] }])).rejects.toThrow('私钥或属性不可用');
    expect(state.items).toEqual([source]);
  });
});

describe('local Passkey storage', () => {
  it.each([0, 9])('preserves the original key, credential bytes, flags and %s counter through actual encrypted disk restart and signing', async counter => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const source: PasskeyItem = { id: 'synthetic-key', kind: 'passkey', title: 'Synthetic GitHub shape', favorite: false, notes: '', createdAt: NOW, updatedAt: NOW,
      credentialId: '00112233-4455-6677-8899-aabbccddeeff', rpId: 'example.invalid', rpName: 'Synthetic', userHandle: 'dXNlcg', userName: 'synthetic', userDisplayName: 'Synthetic',
      publicKey: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))),
      privateKeyPkcs8: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))), algorithm: -7, discoverable: true,
      signCount: counter, signCountHighWaterMark: counter, backupEligible: true, backupState: false, sourceMode: 'bitwarden', providerRefs: [{ providerId: REMOTE.id, remoteId: 'cipher#fido2:credential' }] };
    const directory = await mkdtemp(join(tmpdir(), 'monica-local-transfer-')), path = join(directory, 'synthetic-vault.json');
    class DiskStorage implements VaultEnvelopeStorage {
      async read() { try { return JSON.parse(await readFile(path, 'utf8')) as VaultEnvelope; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } }
      async write(envelope: VaultEnvelope) { await writeFile(path, JSON.stringify(envelope)); }
      async clear() { throw new Error('No deletion needed by this synthetic test'); }
    }
    const sessions = new MemoryVaultSessionStore(), keys = new MemoryVaultDeviceKeyStore(), storage = new DiskStorage();
    const service = new SecureVaultService(storage, sessions, Date.now, keys); await service.setup('', [source]); await service.upsertProvider(REMOTE);
    const state = await service.readState(), prepared = await service.prepareLocalTransfer(request(state), [{ expected: source, account: REMOTE, attachments: [] }]);
    await service.commitLocalTransfer(prepared);
    const restarted = new SecureVaultService(new DiskStorage(), sessions, Date.now, keys);
    const copy = (await restarted.getItem(prepared.batch.receipt.entries[0].targetItemId)) as PasskeyItem;
    for (const field of ['credentialId', 'privateKeyPkcs8', 'publicKey', 'signCount', 'signCountHighWaterMark', 'backupEligible', 'backupState'] as const) expect(copy[field]).toEqual(source[field]);
    expect(copy.sourceMode).toBe('browser-local'); expect(copy.providerRefs).toEqual([]);
    const key = await crypto.subtle.importKey('pkcs8', base64ToBytes(copy.privateKeyPkcs8!) as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const message = new TextEncoder().encode('synthetic independent verifier');
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, message);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, signature, message)).toBe(true);
    expect((await restarted.commitLocalTransfer(prepared)).replayed).toBe(true);
    await expect(restarted.prepareLocalTransfer(request(await restarted.readState(), [source.id], { operationId: crypto.randomUUID() }), [{ expected: source, account: REMOTE, attachments: [] }])).rejects.toThrow('已存在同一 Passkey');
  });
});
