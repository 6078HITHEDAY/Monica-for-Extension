import { describe, expect, it, vi } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderAccount, type VaultItem } from '../core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../core/project-credentials';
import { bytesToBase64 } from './encoding';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultSessionStore } from './vault-session';
import { MemoryVaultStorage } from './vault-storage';
import { BitwardenClient, type BitwardenSessionConfig } from '../providers/bitwarden/bitwarden-client';
import { decodeBitwardenCipher, encodeBitwardenCipher } from '../providers/bitwarden/bitwarden-cipher-codec';
import { encryptBitwardenString } from '../providers/bitwarden/bitwarden-crypto';
import { BitwardenProjectRemovalVerifier } from '../providers/bitwarden/bitwarden-project-removal-verification';
import { BitwardenProjectRemovalTransaction, bitwardenProjectRemovalStore } from '../providers/bitwarden/bitwarden-project-removal-transaction';
import { assertPasswordProjectRemovalSyncSafe } from '../core/password-project-removal-sync';

const password = 'Synthetic atomic removal vault password';
const date = '2026-10-09T10:00:00.000Z';
const deletion = '2026-10-09T10:05:00.123Z';

async function preparedFixture(passkeyCounter = 0) {
  const key = { encKey: crypto.getRandomValues(new Uint8Array(32)), macKey: crypto.getRandomValues(new Uint8Array(32)) };
  const session: BitwardenSessionConfig = { vaultUrl: 'https://synthetic.invalid', apiUrl: 'https://synthetic.invalid/api', identityUrl: 'https://synthetic.invalid/identity',
    email: 'synthetic@example.invalid', accessToken: 'synthetic-token', deviceId: crypto.randomUUID(), expiresAt: Date.now() + 3600000,
    kdf: { type: 0, iterations: 1 }, vaultKeyEnc: bytesToBase64(key.encKey), vaultKeyMac: bytesToBase64(key.macKey) };
  const account: ProviderAccount = { id: 'bw-adoption', kind: 'bitwarden', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false, config: session };
  const raw = new Map<string, Record<string, unknown>>(), localIds = new Map<string, string>(), projectId = crypto.randomUUID();
  const initial: VaultItem[] = [];
  for (let index = 0; index < 2; index++) {
    const cipherId = crypto.randomUUID();
    const item: LoginItem = { ...createLoginItem({ title: 'Project', password: `original-${index}`, providerRefs: [{ providerId: account.id, remoteId: cipherId }] }),
      passwordGroupId: projectId, totpSecret: `otpauth://hotp/Group${index}?secret=JBSWY3DPEHPK3PXP&counter=${index + 20}`,
      customFields: [{ name: PROJECT_CREDENTIAL_FIELD, protected: true, value: JSON.stringify({ version: 1, projectId, groupId: crypto.randomUUID(), passwordId: crypto.randomUUID(),
        primary: index === 0, label: `Group ${index}`, groupOrder: index, passwordOrder: 0 }) }] };
    const cipher: Record<string, unknown> = { ...await encodeBitwardenCipher(item, key), id: cipherId, creationDate: date, revisionDate: date };
    const passkeyPair = index === 1 ? await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) : undefined;
    if (passkeyPair) (cipher.login as Record<string, unknown>).fido2Credentials = [Object.fromEntries(await Promise.all(Object.entries({
      credentialId: crypto.randomUUID(), keyAlgorithm: 'ECDSA', keyCurve: 'P-256', keyType: 'public-key', rpId: 'example.invalid',
      userHandle: 'c3ludGhldGlj', counter: String(passkeyCounter), discoverable: 'true', keyValue: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', passkeyPair.privateKey)))
    }).map(async ([name, value]) => [name, await encryptBitwardenString(value, key)])))];
    raw.set(cipherId, cipher);
    for (const decoded of (await decodeBitwardenCipher(cipher, account.id, key)).items) {
      const id = crypto.randomUUID(); localIds.set(decoded.providerRefs[0].remoteId!, id);
      initial.push({ ...decoded, id } as VaultItem);
    }
  }
  const unrelated = createLoginItem({ title: 'Unrelated local record', password: 'Keep unrelated' }); initial.push(unrelated);
  const storage = new MemoryVaultStorage(); let vault = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await vault.setup(password, initial); await vault.upsertProvider(account);
  const original = (await vault.readState()).items.filter((row): row is LoginItem => row.kind === 'login' && row.passwordGroupId === projectId);
  const operationId = crypto.randomUUID();
  await vault.stagePasswordProjectRemoval({ operationId, items: original, expected: Object.fromEntries(original.map(row => [row.id, row.updatedAt])), removedItemIds: [original[0].id] });
  const staged = await vault.readState();
  for (const row of staged.items.filter((row): row is LoginItem => row.kind === 'login' && row.passwordGroupId === projectId)) {
    const id = row.providerRefs.find(ref => ref.providerId === account.id)!.remoteId!;
    raw.set(id, { ...raw.get(id), ...await encodeBitwardenCipher(row, key, raw.get(id)), id, creationDate: date, revisionDate: date });
  }
  const acknowledged: VaultItem[] = [unrelated];
  for (const cipher of raw.values()) for (const item of (await decodeBitwardenCipher(cipher, account.id, key)).items)
    acknowledged.push({ ...item, id: localIds.get(item.providerRefs[0].remoteId!)! } as VaultItem);
  await vault.applyProviderSync(account.id, acknowledged, undefined, [], [], staged.items);
  const client = new BitwardenClient();
  vi.spyOn(client, 'sync').mockImplementation(async session => ({ session, payload: { ciphers: structuredClone([...raw.values()]) } }));
  vi.spyOn(client, 'getCipherDetails').mockImplementation(async (session, id) => ({ session, payload: structuredClone(raw.get(id) || null) }));
  const deletes = vi.spyOn(client, 'softDeleteCipher').mockImplementation(async (session, id) => { Object.assign(raw.get(id)!, { deletedDate: deletion, revisionDate: deletion }); return session; });
  const verifier = new BitwardenProjectRemovalVerifier(client, account);
  const observed = await vault.inspectPasswordProjectRemoval(operationId);
  const proofs = [{ providerId: account.id, ...observed.record.ownerTransfer!, attachments: [] }];
  const acknowledgedRecord = { ...observed.record, retained: observed.record.retained.map(row => observed.items.find(item => item.id === row.id)!),
    removed: observed.record.removed.map(row => observed.items.find(item => item.id === row.id)!), proofs };
  const intent = await verifier.prepare(acknowledgedRecord);
  const prepared = await vault.finalizePasswordProjectRemoval(operationId, observed.items, proofs, undefined, intent);
  const transaction = new BitwardenProjectRemovalTransaction(bitwardenProjectRemovalStore(vault), verifier.remote());
  return { account, storage, raw, original, prepared, transaction, verifier, client, key, operationId, deletes, unrelated, localIds,
    get vault() { return vault; },
    restart: async () => { await vault.lock(); vault = new SecureVaultService(storage, new MemoryVaultSessionStore()); await vault.unlock(password); } };
}

async function fixture() {
  const f = await preparedFixture(), committed = await f.transaction.resume(f.operationId);
  return Object.assign(f, { committed, result: await f.verifier.committedReadback(committed) });
}

async function restorationFixture(mode: 'changed-content' | 'new-member' | 'removed-child' | 'moved-source' | 'changed-key' | 'counter-regression' = 'changed-content') {
  const f = await preparedFixture(mode === 'counter-regression' ? 8 : 0);
  const actualDelete = f.deletes.getMockImplementation()!;
  f.deletes.mockImplementation(async (session, id) => {
    const result = await actualDelete(session, id);
    (f.raw.get(id)!.login as Record<string, unknown>).password = await encryptBitwardenString('Latest remote password', f.key);
    const target = f.raw.get(f.prepared.retained[0].providerRefs[0].remoteId!)!;
    target.notes = await encryptBitwardenString('Latest remote note', f.key);
    if (mode === 'removed-child') (target.login as Record<string, unknown>).fido2Credentials = [];
    if (mode === 'changed-key' || mode === 'counter-regression') {
      const native = ((target.login as Record<string, unknown>).fido2Credentials as Record<string, unknown>[])[0];
      if (mode === 'counter-regression') native.counter = await encryptBitwardenString('0', f.key);
      else {
        const replacement = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        native.keyValue = await encryptBitwardenString(bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', replacement.privateKey))), f.key);
      }
    }
    if (mode === 'moved-source') f.raw.get(id)!.fields = [];
    if (mode === 'new-member') {
      const newId = crypto.randomUUID(), original = f.prepared.retained[0];
      const draft = { ...original, id: newId, password: 'New remote member', customFields: original.customFields.map(field => field.name === PROJECT_CREDENTIAL_FIELD
        ? { ...field, value: JSON.stringify({ ...JSON.parse(field.value), passwordId: crypto.randomUUID(), passwordOrder: 1 }) } : field) };
      f.raw.set(newId, { ...await encodeBitwardenCipher(draft, f.key), id: newId, creationDate: date, revisionDate: date });
    }
    return result;
  });
  const restores = vi.spyOn(f.client, 'restoreCipherOnce').mockImplementation(async (session, id) => {
    Object.assign(f.raw.get(id)!, { deletedDate: null, revisionDate: deletion });
    return { session, payload: structuredClone(f.raw.get(id)!) };
  });
  const restored = await f.transaction.resume(f.operationId);
  expect(restored.bitwardenDeletion?.phase).toBe('restored');
  return Object.assign(f, { restored, restores, readback: await f.verifier.restoredReadback(restored) });
}

describe('atomic local Bitwarden project-removal adoption', () => {
  it('adopts parent and OTP tombstones, retained keys, exact local IDs and source records in one encrypted write', async () => {
    const f = await fixture(), before = await f.vault.readState();
    const write = vi.spyOn(f.storage, 'write');
    expect(f.prepared.bitwardenDeletion!.localChildren).toHaveLength(3);
    const completed = await f.vault.completePasswordProjectBitwardenDeletion(f.result);
    expect(completed.status).toBe('completed'); expect(write).toHaveBeenCalledTimes(1);
    const after = await f.vault.readState();
    expect(after.items.map(row => row.id).sort()).toEqual(before.items.map(row => row.id).sort());
    const sourceId = f.prepared.removed[0].providerRefs[0].remoteId!;
    expect(after.items.filter(row => row.providerRefs.some(ref => ref.remoteId?.startsWith(sourceId))).every(row => row.deletedAt === deletion)).toBe(true);
    expect(after.items.find(row => row.kind === 'passkey')?.deletedAt).toBeUndefined();
    expect(after.items.find(row => row.id === f.unrelated.id)).toEqual(before.items.find(row => row.id === f.unrelated.id));
    expect(after.mutationQueue).toHaveLength(0); expect(after.sourceRecords).toHaveLength(2);
    expect(() => assertPasswordProjectRemovalSyncSafe(f.account, { now: date, localItems: after.items, passwordProjectRemovals: after.passwordProjectRemovals })).not.toThrow();
    expect(JSON.stringify(f.storage.envelope)).not.toContain('original-0');
    await f.restart();
    expect((await f.vault.readState()).items).toEqual(after.items);
    await f.vault.completePasswordProjectBitwardenDeletion(f.result);
    expect(f.deletes).toHaveBeenCalledTimes(1);
  });

  it('keeps the journal, live children and deletion queue together when the final encrypted save fails', async () => {
    const f = await fixture(), encrypted = JSON.stringify(f.storage.envelope);
    vi.spyOn(f.storage, 'write').mockRejectedValueOnce(new Error('Synthetic final save failure'));
    await expect(f.vault.completePasswordProjectBitwardenDeletion(f.result)).rejects.toThrow('final save failure');
    expect(JSON.stringify(f.storage.envelope)).toBe(encrypted);
    await f.restart();
    expect((await f.vault.readPasswordProjectRemovals())[0].status).toBe('deleting');
    expect((await f.vault.readState()).mutationQueue).toHaveLength(1);
    await f.vault.completePasswordProjectBitwardenDeletion(f.result);
    expect((await f.vault.readPasswordProjectRemovals())[0].status).toBe('completed');
    expect(f.deletes).toHaveBeenCalledTimes(1);
  });

  it.each(['missing-child', 'duplicate-child', 'extra-child', 'wrong-source', 'wrong-revision', 'changed-raw', 'changed-login-projection', 'changed-child-projection',
    'changed-project-id', 'changed-folder-reference', 'changed-source-revision', 'changed-item-revision'])('rejects %s readback without clearing recovery state', async scenario => {
    const f = await fixture(), encrypted = JSON.stringify(f.storage.envelope), result = structuredClone(f.result);
    if (scenario === 'missing-child') result.items = result.items.filter(row => row.kind !== 'totp');
    if (scenario === 'duplicate-child') result.items.push({ ...result.items.find(row => row.kind === 'totp')!, id: crypto.randomUUID() });
    if (scenario === 'extra-child') {
      const child = structuredClone(result.items.find(row => row.kind === 'passkey')!);
      child.id = crypto.randomUUID(); child.providerRefs[0].remoteId += '-unexpected'; result.items.push(child);
    }
    if (scenario === 'wrong-source') result.account.config.email = 'different@example.invalid';
    if (scenario === 'wrong-revision') result.journalRevision++;
    if (scenario === 'changed-raw') result.sourceRecords[0].payload = result.sourceRecords[0].payload.replace('"type":1', '"type":2');
    if (scenario === 'changed-login-projection') (result.items.find(row => row.kind === 'login') as LoginItem).password = 'Incorrect decoded password';
    if (scenario === 'changed-child-projection') result.items.find(row => row.kind === 'totp')!.notes = 'Incorrect decoded note';
    if (scenario === 'changed-project-id') (result.items.find(row => row.kind === 'login') as LoginItem).passwordGroupId = crypto.randomUUID();
    if (scenario === 'changed-folder-reference') result.items[0].providerRefs[0].remoteFolderId = crypto.randomUUID();
    if (scenario === 'changed-source-revision') result.sourceRecords[0].revision = '2026-10-10T00:00:00.000Z';
    if (scenario === 'changed-item-revision') result.items[0].providerRefs[0].revision = '2026-10-10T00:00:00.000Z';
    await expect(f.vault.completePasswordProjectBitwardenDeletion(result)).rejects.toThrow();
    expect(JSON.stringify(f.storage.envelope)).toBe(encrypted);
  });

  it.each(['passkey', 'totp'] as const)('preserves a locally changed %s rather than adopting an older readback', async kind => {
    const f = await fixture(), row = (await f.vault.readState()).items.find(row => row.kind === kind)!;
    await f.vault.upsertItem({ ...row, notes: 'New local credential note' });
    const encrypted = JSON.stringify(f.storage.envelope);
    await expect(f.vault.completePasswordProjectBitwardenDeletion(f.result)).rejects.toThrow('关联凭据已变化');
    expect(JSON.stringify(f.storage.envelope)).toBe(encrypted);
    expect((await f.vault.getItem(row.id))!.notes).toBe('New local credential note');
  });
});

describe('atomic local Bitwarden project compensation', () => {
  for (const kind of ['login', 'passkey', 'totp'] as const) {
    it.each(['before-delete', 'after-delete', 'after-commit'] as const)(`keeps both ${kind} versions and releases recovery after a local edit %s`, async moment => {
      const f = await preparedFixture();
      const target = (await f.vault.readState()).items.find(row => kind === 'login' ? row.id === f.prepared.retained[0].id : row.kind === kind)!;
      const edit = () => f.vault.upsertItem({...target, notes: 'Latest local edit during removal'});
      const restores = vi.spyOn(f.client, 'restoreCipherOnce').mockImplementation(async (session, id) => {
        Object.assign(f.raw.get(id)!, {deletedDate: null, revisionDate: deletion});
        return {session, payload: structuredClone(f.raw.get(id)!)};
      });
      if (moment === 'before-delete') await edit();
      if (moment === 'after-delete') {
        const original = f.deletes.getMockImplementation()!;
        f.deletes.mockImplementation(async (...args) => {const result = await original(...args); await edit(); return result;});
      }
      if (moment === 'after-commit') {await f.transaction.resume(f.operationId); await edit(); await f.restart();}
      const {BitwardenPasswordProjectRemovalCoordinator} = await import('../providers/bitwarden/bitwarden-project-removal');
      const resumed = await new BitwardenPasswordProjectRemovalCoordinator(f.vault, f.client).resume(f.operationId);
      expect(resumed).toMatchObject({status: 'cancelled', bitwardenDeletion: {phase: 'restored', reason: 'local-changed'}});
      expect(f.deletes).toHaveBeenCalledTimes(moment === 'before-delete' ? 0 : 1);
      expect(restores).toHaveBeenCalledTimes(moment === 'before-delete' ? 0 : 1);
      const state = await f.vault.readState();
      expect(state.items.find(row => row.id === target.id)?.notes).toBe('Latest local edit during removal');
      expect(state.items.find(row => row.id === f.prepared.removed[0].id)?.deletedAt).toBeUndefined();
      expect(state.providerConflicts).toHaveLength(1);
      expect(state.providerConflicts[0]).toMatchObject({itemId: target.id, local: {notes: 'Latest local edit during removal'}, requiresExplicitResolution: true});
      expect(state.providerConflicts[0].remote?.notes).not.toBe('Latest local edit during removal');
      expect(state.mutationQueue).toHaveLength(0);
      expect(() => assertPasswordProjectRemovalSyncSafe(f.account, {now: date, localItems: state.items, passwordProjectRemovals: state.passwordProjectRemovals})).not.toThrow();
      await f.restart();
      expect((await f.vault.readState()).providerConflicts).toEqual(state.providerConflicts);
      await f.vault.resolveProviderConflict(state.providerConflicts[0].id, 'keep-local');
      const resolved = await f.vault.readState();
      expect(resolved.providerConflicts).toHaveLength(0);
      expect(resolved.items.find(row => row.id === target.id)?.notes).toBe('Latest local edit during removal');
      expect(resolved.mutationQueue).toEqual([expect.objectContaining({itemId: target.id, operation: 'update'})]);
    });
  }

  it('retains both edits and the journal if conflict adoption cannot be encrypted, then resumes after restart', async () => {
    const f = await restorationFixture();
    const target = (await f.vault.readState()).items.find(row => row.kind === 'passkey')!;
    await f.vault.upsertItem({...target, notes: 'Local edit before failed final write'});
    const before = JSON.stringify(f.storage.envelope);
    vi.spyOn(f.storage, 'write').mockRejectedValueOnce(new Error('Synthetic conflict adoption save failure'));
    await expect(f.vault.completePasswordProjectBitwardenRestoration(f.readback)).rejects.toThrow('conflict adoption save failure');
    expect(JSON.stringify(f.storage.envelope)).toBe(before);
    await f.restart();
    await f.vault.completePasswordProjectBitwardenRestoration(f.readback);
    expect((await f.vault.readState()).providerConflicts).toHaveLength(1);
    expect((await f.vault.getItem(target.id))?.notes).toBe('Local edit before failed final write');
  });

  it.each([false, true])('the composed coordinator completes confirmed rollback with final-save failure=%s', async failSave => {
    const f = await restorationFixture();
    const { BitwardenPasswordProjectRemovalCoordinator } = await import('../providers/bitwarden/bitwarden-project-removal');
    const make = () => new BitwardenPasswordProjectRemovalCoordinator(f.vault, f.client);
    if (failSave) {
      const encrypted = JSON.stringify(f.storage.envelope);
      vi.spyOn(f.storage, 'write').mockRejectedValueOnce(new Error('Synthetic composed rollback save failure'));
      await expect(make().resume(f.operationId)).rejects.toThrow('composed rollback save failure');
      expect(JSON.stringify(f.storage.envelope)).toBe(encrypted);
      await f.restart();
    }
    expect((await make().resume(f.operationId)).status).toBe('cancelled');
    const sync = vi.spyOn(f.client, 'sync'); sync.mockClear();
    expect((await make().resume(f.operationId)).status).toBe('cancelled');
    expect(sync).not.toHaveBeenCalled();
    expect(f.restores).toHaveBeenCalledTimes(1); expect(f.deletes).toHaveBeenCalledTimes(1);
    expect((await f.vault.readState()).mutationQueue).toHaveLength(0);
  });

  it.each(['changed-content', 'new-member', 'moved-source'] as const)('adopts %s without restoring stale draft bytes or replaying deletion', async mode => {
    const f = await restorationFixture(mode), before = await f.vault.readState(), write = vi.spyOn(f.storage, 'write');
    const cancelled = await f.vault.completePasswordProjectBitwardenRestoration(f.readback);
    expect(cancelled.status).toBe('cancelled'); expect(write).toHaveBeenCalledTimes(1);
    const after = await f.vault.readState();
    expect(after.items.find(row => row.id === f.prepared.removed[0].id)).toMatchObject({ password: 'Latest remote password' });
    expect(after.items.find(row => row.id === f.prepared.removed[0].id)?.deletedAt).toBeUndefined();
    expect(after.items.find(row => row.id === f.prepared.retained[0].id)).toMatchObject({ notes: 'Latest remote note' });
    expect(after.items.find(row => row.id === f.unrelated.id)).toEqual(before.items.find(row => row.id === f.unrelated.id));
    expect(after.mutationQueue).toHaveLength(0); expect(after.providerConflicts).toHaveLength(0);
    expect(after.sourceRecords).toHaveLength(mode === 'new-member' ? 3 : 2);
    for (const item of before.items) expect(after.items.some(row => row.id === item.id)).toBe(true);
    if (mode === 'new-member') expect(after.items.some(row => row.kind === 'login' && row.password === 'New remote member')).toBe(true);
    if (mode === 'moved-source') expect((after.items.find(row => row.id === f.prepared.removed[0].id) as LoginItem).passwordGroupId).toBeUndefined();
    expect(cancelled.cancellationItems).toEqual(f.prepared.cancellationItems);
    expect(() => assertPasswordProjectRemovalSyncSafe(f.account, { now: date, localItems: after.items, passwordProjectRemovals: after.passwordProjectRemovals })).not.toThrow();
    await f.restart();
    expect((await f.vault.readState()).items).toEqual(after.items);
    await f.vault.completePasswordProjectBitwardenRestoration(f.readback);
    expect(f.deletes).toHaveBeenCalledTimes(1); expect(f.restores).toHaveBeenCalledTimes(1);
  });

  it.each(['use-remote', 'keep-local'] as const)('keeps a remotely removed Passkey through restart and sync until the explicit %s decision', async decision => {
    const f = await restorationFixture('removed-child'), before = (await f.vault.readState()).items.find(row => row.kind === 'passkey')!;
    await f.vault.completePasswordProjectBitwardenRestoration(f.readback);
    const state = await f.vault.readState();
    expect(state.items.find(row => row.id === before.id)).toEqual(before);
    expect(state.providerConflicts).toHaveLength(1); expect(state.providerConflicts[0]).toMatchObject({ itemId: before.id, local: before });
    expect(state.providerConflicts[0].remote).toBeUndefined(); expect(state.mutationQueue).toHaveLength(0);
    await f.restart();
    const { BitwardenDurableSyncCoordinator } = await import('../providers/bitwarden/bitwarden-durable-sync');
    const { BitwardenProvider } = await import('../providers/bitwarden/bitwarden-provider');
    const provider = new BitwardenProvider(), sync = vi.spyOn(provider, 'sync');
    await expect(new BitwardenDurableSyncCoordinator(provider, f.vault).synchronize(f.account)).rejects.toThrow('明确选择');
    expect(sync).not.toHaveBeenCalled();
    await expect(f.vault.applyProviderSync(f.account.id, state.items.filter(row => row.id !== before.id))).rejects.toThrow('明确解决冲突');
    expect((await f.vault.getItem(before.id))).toEqual(before);
    await f.vault.resolveProviderConflict(state.providerConflicts[0].id, decision);
    expect((await f.vault.readState()).providerConflicts).toHaveLength(0);
    if (decision === 'use-remote') expect(await f.vault.getItem(before.id)).toBeUndefined();
    else {
      const retained = await f.vault.getItem(before.id);
      expect(retained).toMatchObject({ credentialId: Reflect.get(before, 'credentialId'), privateKeyPkcs8: Reflect.get(before, 'privateKeyPkcs8'), signCount: 0 });
      expect(retained?.providerRefs.find(ref => ref.providerId === f.account.id)?.remoteId).toBeUndefined();
      expect((await f.vault.readState()).mutationQueue).toContainEqual(expect.objectContaining({ itemId: before.id, operation: 'create' }));
    }
  });

  it('recovers an interrupted final cancellation write from the unchanged encrypted journal', async () => {
    const f = await restorationFixture(), encrypted = JSON.stringify(f.storage.envelope);
    vi.spyOn(f.storage, 'write').mockRejectedValueOnce(new Error('Synthetic rollback save failed'));
    await expect(f.vault.completePasswordProjectBitwardenRestoration(f.readback)).rejects.toThrow('rollback save failed');
    expect(JSON.stringify(f.storage.envelope)).toBe(encrypted);
    await f.restart();
    expect((await f.vault.readPasswordProjectRemovals())[0].status).toBe('deleting');
    await f.vault.completePasswordProjectBitwardenRestoration(f.readback);
    expect((await f.vault.readPasswordProjectRemovals())[0].status).toBe('cancelled');
    expect(f.restores).toHaveBeenCalledTimes(1);
  });

  it.each(['changed-key', 'counter-regression'] as const)('preserves the existing Passkey and both versions for %s', async mode => {
    const f = await restorationFixture(mode), before = (await f.vault.readState()).items.find(row => row.kind === 'passkey')!;
    await f.vault.completePasswordProjectBitwardenRestoration(f.readback);
    const state = await f.vault.readState();
    expect(state.items.find(row => row.id === before.id)).toEqual(before);
    expect(state.providerConflicts).toHaveLength(1);
    expect(state.providerConflicts[0]).toMatchObject({ itemId: before.id, local: before, requiresExplicitResolution: true });
    expect(state.providerConflicts[0].remote).toBeDefined();
    expect(state.providerConflicts[0].remote).not.toEqual(before);
  });

  it.each(['missing-source', 'changed-payload', 'wrong-account', 'stale-journal', 'retrashed-source', 'unrelated-cipher'] as const)('rejects %s and retains the recovery journal', async mode => {
    const f = await restorationFixture(), result = structuredClone(f.readback), encrypted = JSON.stringify(f.storage.envelope);
    if (mode === 'missing-source') result.sourceRecords.pop();
    if (mode === 'changed-payload') result.sourceRecords[0].payload += ' ';
    if (mode === 'wrong-account') result.account.config.email = 'wrong@example.invalid';
    if (mode === 'stale-journal') result.journalRevision--;
    if (mode === 'retrashed-source' || mode === 'unrelated-cipher') {
      const { createSourceRecord } = await import('../core/source-records');
      const source = result.sourceRecords.find(row => row.remoteId === f.prepared.removed[0].providerRefs[0].remoteId)!;
      const raw = JSON.parse(source.payload);
      if (mode === 'retrashed-source') raw.deletedDate = deletion;
      else { raw.id = crypto.randomUUID(); raw.fields = []; }
      const changed = await createSourceRecord({ ...source, remoteId: raw.id, payload: JSON.stringify(raw) });
      if (mode === 'retrashed-source') result.sourceRecords = result.sourceRecords.map(row => row === source ? changed : row);
      else result.sourceRecords.push(changed);
    }
    await expect(f.vault.completePasswordProjectBitwardenRestoration(result)).rejects.toThrow();
    expect(JSON.stringify(f.storage.envelope)).toBe(encrypted);
  });

  it('refuses a source that changes again between the two fresh recovery reads', async () => {
    const f = await restorationFixture(), sync = vi.spyOn(f.client, 'sync'), initial = sync.getMockImplementation()!;
    let count = 0;
    sync.mockImplementation(async (...args) => {
      if (++count === 2) f.raw.get(f.prepared.retained[0].providerRefs[0].remoteId!)!.notes = await encryptBitwardenString('Changed again', f.key);
      return initial(...args);
    });
    await expect(f.verifier.restoredReadback(f.restored)).rejects.toThrow();
    expect((await f.vault.readPasswordProjectRemovals())[0].status).toBe('deleting');
  });
});
