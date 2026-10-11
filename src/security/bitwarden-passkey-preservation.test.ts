import { describe, expect, it, vi } from 'vitest';
import { createLoginItem, type LoginItem, type PasskeyItem, type ProviderAccount, type VaultItem } from '../core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../core/project-credentials';
import { createSourceRecord } from '../core/source-records';
import { cloneLosslessJson } from '../core/lossless-json';
import { bytesToBase64 } from './encoding';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';
import { BitwardenClient, type BitwardenSessionConfig } from '../providers/bitwarden/bitwarden-client';
import { decodeBitwardenCipher, encodeBitwardenCipher, encodeBitwardenPasskeyCipher } from '../providers/bitwarden/bitwarden-cipher-codec';
import { encryptBitwardenString } from '../providers/bitwarden/bitwarden-crypto';
import { planBitwardenPasskeyPreservation, verifyBitwardenPasskeyPreservationCopy } from '../providers/bitwarden/bitwarden-passkey-preservation';
import { BitwardenPasskeyPreservationPreparation } from '../providers/bitwarden/bitwarden-passkey-preservation-preparation';
import { BitwardenPasswordProjectRemovalCoordinator } from '../providers/bitwarden/bitwarden-project-removal';
import { BitwardenProvider } from '../providers/bitwarden/bitwarden-provider';
import { BitwardenDurableSyncCoordinator } from '../providers/bitwarden/bitwarden-durable-sync';
import { BitwardenProjectRemovalVerifier } from '../providers/bitwarden/bitwarden-project-removal-verification';

const date = '2026-10-09T12:00:00.000Z', password = 'Synthetic preservation vault password';

async function fixture(memberCount = 2, removePrimary = false, withFolder = false) {
  const key = { encKey: crypto.getRandomValues(new Uint8Array(32)), macKey: crypto.getRandomValues(new Uint8Array(32)) };
  const folderId = 'synthetic-passkey-folder', folderName = '跨端 / Passkeys';
  const folders = withFolder ? [{ id: folderId, name: await encryptBitwardenString(folderName, key) }] : [];
  const session: BitwardenSessionConfig = { vaultUrl: 'https://synthetic.invalid', apiUrl: 'https://synthetic.invalid/api', identityUrl: 'https://synthetic.invalid/identity',
    email: 'synthetic@example.invalid', deviceId: crypto.randomUUID(), accessToken: 'synthetic', expiresAt: Date.now() + 3600000,
    kdf: { type: 0, iterations: 1 }, vaultKeyEnc: bytesToBase64(key.encKey), vaultKeyMac: bytesToBase64(key.macKey) };
  const account: ProviderAccount = { id: 'bw-preservation', kind: 'bitwarden', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false, config: session };
  const raw = new Map<string, Record<string, unknown>>(), projectId = crypto.randomUUID(), initial: VaultItem[] = [], ids = new Map<string, string>();
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pkcs8 = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)));
  for (let index = 0; index < memberCount; index++) {
    const cipherId = crypto.randomUUID();
    const item: LoginItem = { ...createLoginItem({ title: 'Project', password: `original-${index}`, notes: 'Source notes' }), passwordGroupId: projectId,
      customFields: [{ name: PROJECT_CREDENTIAL_FIELD, protected: true, value: JSON.stringify({ version: 1, projectId, groupId: crypto.randomUUID(), passwordId: crypto.randomUUID(),
        label: `Group ${index}`, primary: index === 0, groupOrder: index, passwordOrder: 0 }) }] };
    const cipher: Record<string, unknown> = { ...await encodeBitwardenCipher(item, key), id: cipherId, creationDate: date, revisionDate: date,
      ...(withFolder ? { folderId } : {}) };
    if (removePrimary ? index === 0 : index > 0) {
      const credentials = [];
      for (const count of [0, 23]) {
        const passkey: PasskeyItem = { id: crypto.randomUUID(), kind: 'passkey', title: 'Synthetic RP', notes: '', favorite: false, createdAt: date, updatedAt: date, providerRefs: [],
          credentialId: crypto.randomUUID(), rpId: 'example.invalid', rpName: 'Synthetic RP', userHandle: 'c3ludGhldGlj', userName: 'Synthetic', userDisplayName: 'Synthetic', sourceMode: 'bitwarden', algorithm: -7, publicKey: '',
          privateKeyPkcs8: pkcs8, signCount: count, discoverable: true };
        const encoded = await encodeBitwardenPasskeyCipher(passkey, key);
        credentials.push(...(encoded.login as Record<string, unknown>).fido2Credentials as Record<string, unknown>[]);
      }
      (cipher.login as Record<string, unknown>).fido2Credentials = credentials;
    }
    raw.set(cipherId, cipher);
    for (const decoded of (await decodeBitwardenCipher(cipher, account.id, key, withFolder ? folderName : undefined)).items) {
      const id = crypto.randomUUID(); ids.set(decoded.providerRefs[0].remoteId!, id); initial.push({ ...decoded, id } as VaultItem);
    }
  }
  const storage = new MemoryVaultStorage(); let vault = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await vault.setup(password, initial); await vault.upsertProvider(account);
  const original = (await vault.readState()).items.filter((row): row is LoginItem => row.kind === 'login');
  const operationId = crypto.randomUUID();
  await vault.stagePasswordProjectRemoval({ operationId, items: original, expected: Object.fromEntries(original.map(row => [row.id, row.updatedAt])),
    removedItemIds: (removePrimary ? [original[0]] : original.slice(1)).map(row => row.id) });
  const staged = await vault.readState();
  for (const row of staged.items.filter((row): row is LoginItem => row.kind === 'login')) {
    const id = row.providerRefs[0].remoteId!;
    raw.set(id, { ...raw.get(id), ...await encodeBitwardenCipher(row, key, raw.get(id)), id, creationDate: date, revisionDate: date });
  }
  const acknowledged: VaultItem[] = [], envelopes = [];
  for (const cipher of raw.values()) {
    for (const decoded of (await decodeBitwardenCipher(cipher, account.id, key, withFolder ? folderName : undefined)).items)
      acknowledged.push({ ...decoded, id: ids.get(decoded.providerRefs[0].remoteId!)! } as VaultItem);
    envelopes.push(await createSourceRecord({ providerId: account.id, remoteId: cipher.id as string, format: 'bitwarden-cipher', encoding: 'json', revision: date, payload: JSON.stringify(cipher) }));
  }
  await vault.applyProviderSync(account.id, acknowledged, undefined, [], envelopes, staged.items);
  const client = new BitwardenClient();
  const sync = vi.spyOn(client, 'sync').mockImplementation(async session => ({ session, payload: { ciphers: cloneLosslessJson([...raw.values()]), folders: cloneLosslessJson(folders) } }));
  const details = vi.spyOn(client, 'getCipherDetails').mockImplementation(async (session, id) => ({ session, payload: cloneLosslessJson(raw.get(id) || null) }));
  const creates = vi.spyOn(client, 'createCipherOnce').mockImplementation(async (session, payload) => {
    const copy = { ...cloneLosslessJson(payload), id: crypto.randomUUID(), creationDate: date, revisionDate: date }; raw.set(copy.id, copy); return { session, payload: cloneLosslessJson(copy) };
  });
  const deletes = vi.spyOn(client, 'softDeleteCipher').mockRejectedValue(new Error('Deletion must remain disabled'));
  const sourceId = original[removePrimary ? 0 : 1].providerRefs[0].remoteId!, source = raw.get(sourceId)!, originalJson = JSON.stringify(source);
  return { account, key, raw, sourceId, source, originalJson, storage, client, sync, details, creates, deletes, operationId, pkcs8, folders, folderId, folderName,
    get vault() { return vault; },
    prepare: () => new BitwardenPasskeyPreservationPreparation(client, account, vault, operationId).prepare(),
    initialize: async () => vault.initializePasswordProjectBitwardenPasskeyPreservation(operationId, [await planBitwardenPasskeyPreservation(operationId, source, key)]),
    restart: async () => { await vault.lock(); vault = new SecureVaultService(storage, new MemoryVaultSessionStore()); await vault.unlock(password); } };
}

describe('application vault and actual client Passkey preparation', () => {
  it('persists native copies and progress in the application encrypted vault across restart, leaving original IDs live', async () => {
    const f = await fixture(), before = await f.vault.readState(); await f.prepare();
    const record = (await f.vault.readPasswordProjectRemovals())[0], saved = record.bitwardenPasskeyPreservation!.sources[0];
    expect(record.status).toBe('preparing'); expect(saved.copies.map(row => row.stage)).toEqual(['verified', 'verified']);
    for (let index = 0; index < saved.copies.length; index++) {
      const item = await verifyBitwardenPasskeyPreservationCopy(saved.plan, saved.plan.copies[index], f.raw.get(saved.copies[index].remoteId!)!, f.key);
      expect(item.privateKeyPkcs8).toBe(f.pkcs8); expect(item.signCount).toBe(index ? 23 : 0);
    }
    expect(JSON.stringify(f.storage.envelope)).not.toContain(saved.plan.copies[0].copyId);
    expect(JSON.stringify(f.storage.envelope)).not.toContain(f.pkcs8);
    await f.restart(); await f.prepare();
    expect((await f.vault.readState()).items).toEqual(before.items);
    expect(JSON.stringify(f.source)).toBe(f.originalJson); expect(f.creates).toHaveBeenCalledTimes(2); expect(f.deletes).not.toHaveBeenCalled();
  });

  it.each(['response', 'receipt'] as const)('recovers a lost %s without creating a duplicate after vault restart', async mode => {
    const f = await fixture();
    if (mode === 'response') {
      const create = f.creates.getMockImplementation()!;
      f.creates.mockImplementationOnce(async (...args) => { await create(...args); throw new Error('Synthetic response loss'); });
    } else {
      const update = f.vault.updatePasswordProjectBitwardenPasskeyPreservation.bind(f.vault);
      vi.spyOn(f.vault, 'updatePasswordProjectBitwardenPasskeyPreservation').mockImplementation(async (...args) => {
        if (args[3].copies.some(row => row.stage === 'verified')) vi.spyOn(f.storage, 'write').mockRejectedValueOnce(new Error('Synthetic receipt loss'));
        await update(...args);
      });
    }
    await expect(f.prepare()).rejects.toThrow('Synthetic');
    expect((await f.vault.readPasswordProjectRemovals())[0].bitwardenPasskeyPreservation!.sources[0].copies[0].stage).toBe('attempted');
    await f.restart(); await f.prepare(); expect(f.creates).toHaveBeenCalledTimes(2); expect(f.raw.size).toBe(4);
  });

  it('sends no request when the encrypted intent save fails', async () => {
    const f = await fixture(); await f.initialize(); const before = JSON.stringify(f.storage.envelope);
    vi.spyOn(f.storage, 'write').mockRejectedValueOnce(new Error('Synthetic intent save failure'));
    await expect(f.prepare()).rejects.toThrow('intent save failure'); expect(f.creates).not.toHaveBeenCalled();
    expect(JSON.stringify(f.storage.envelope)).toBe(before);
  });

  it.each(['unknown', 'partial', 'paginated', 'conflicting-ciphers', 'unreadable', 'changed-readback', 'duplicate', 'trashed'] as const)('stops safely for %s discovery', async mode => {
    const f = await fixture(); await f.initialize();
    if (mode === 'unknown') f.creates.mockRejectedValueOnce(new Error('Unknown result'));
    if (mode === 'partial') f.sync.mockResolvedValueOnce({ session: f.account.config as BitwardenSessionConfig, payload: {} });
    if (mode === 'paginated') f.sync.mockResolvedValueOnce({ session: f.account.config as BitwardenSessionConfig, payload: { ciphers: [], continuationToken: 'next' } });
    if (mode === 'conflicting-ciphers') f.sync.mockResolvedValueOnce({ session: f.account.config as BitwardenSessionConfig, payload: { ciphers: [], Ciphers: [...f.raw.values()] } });
    if (mode === 'unreadable') f.raw.set('unreadable', { id: 'unreadable', type: 1, fields: [{ name: 'invalid-cipher', value: 'invalid' }] });
    if (mode === 'changed-readback') {
      const create = f.creates.getMockImplementation()!;
      f.creates.mockImplementationOnce(async (...args) => {
        const result = await create(...args); f.raw.get(result.payload.id as string)!.notes = await encryptBitwardenString('Changed', f.key); return result;
      });
    }
    if (mode === 'duplicate' || mode === 'trashed') {
      await f.prepare();
      const id = (await f.vault.readPasswordProjectRemovals())[0].bitwardenPasskeyPreservation!.sources[0].copies[0].remoteId!;
      if (mode === 'duplicate') f.raw.set('duplicate', { ...cloneLosslessJson(f.raw.get(id)!), id: 'duplicate' });
      else f.raw.get(id)!.deletedDate = date;
    }
    await expect(f.prepare()).rejects.toThrow();
    if (mode === 'unknown') { await f.restart(); await expect(f.prepare()).rejects.toThrow('停止重复创建'); expect(f.creates).toHaveBeenCalledTimes(1); }
    expect(JSON.stringify(f.source)).toBe(f.originalJson); expect(f.deletes).not.toHaveBeenCalled();
  });

  it.each(['binding', 'local-edit', 'remote-change', 'wrong-plan', 'cas'] as const)('rejects %s without losing recovery state', async mode => {
    const f = await fixture(); const record = await f.initialize();
    if (mode === 'binding') await f.vault.upsertProvider({ ...f.account, config: { ...f.account.config, email: 'other@example.invalid' } });
    if (mode === 'local-edit') {
      const child = (await f.vault.readState()).items.find(row => row.kind === 'passkey')!;
      await f.vault.upsertItem({...child, notes: 'A real credential edit before copying'});
    }
    if (mode === 'remote-change') f.source.notes = await encryptBitwardenString('New original note', f.key);
    if (mode === 'wrong-plan' || mode === 'cas') {
      const saved = record.bitwardenPasskeyPreservation!.sources[0], next = structuredClone(saved); next.revision++;
      next.copies[0].stage = 'attempted'; if (mode === 'wrong-plan') next.plan.copies[0].payloadJson = '{}';
      await expect(f.vault.updatePasswordProjectBitwardenPasskeyPreservation(f.operationId, f.sourceId, mode === 'cas' ? 999 : 1, next)).rejects.toThrow();
    } else await expect(f.prepare()).rejects.toThrow();
    expect(f.creates).not.toHaveBeenCalled(); expect((await f.vault.readPasswordProjectRemovals())[0].status).toBe('preparing');
  });

  it('resumes with the latest encrypted session and persists refresh before the next request', async () => {
    const f = await fixture(); await f.initialize();
    const current = { ...f.account, config: { ...f.account.config, accessToken: 'refreshed' } };
    await f.vault.upsertProvider(current);
    const sync = f.sync.getMockImplementation()!;
    f.sync.mockImplementationOnce(async session => {
      expect(session.accessToken).toBe('refreshed');
      const result = await sync(session); return { ...result, session: { ...session, accessToken: 'refreshed-again' } };
    });
    await f.prepare();
    expect((await f.vault.getProvider(f.account.id))!.config.accessToken).toBe('refreshed-again');
    expect(f.creates.mock.calls.every(([session]) => session.accessToken === 'refreshed-again')).toBe(true);
  });
});

async function removalFixture(memberCount = 2, removePrimary = false, withFolder = false) {
  const f = await fixture(memberCount, removePrimary, withFolder), deletedAt = '2026-10-09T12:10:00.000Z';
  const provider = new BitwardenProvider(async (input, init) => {
    if (String(input).includes('/sync') && (!init?.method || init.method === 'GET'))
      return new Response(JSON.stringify({ ciphers: [...f.raw.values()], folders: f.folders }), { status: 200 });
    throw new Error('Unexpected synthetic provider request');
  });
  f.deletes.mockImplementation(async (session, id) => {
    Object.assign(f.raw.get(id)!, { deletedDate: deletedAt, revisionDate: deletedAt }); return session;
  });
  const restores = vi.spyOn(f.client, 'restoreCipherOnce').mockImplementation(async (session, id) => {
    Object.assign(f.raw.get(id)!, { deletedDate: null, revisionDate: deletedAt }); return { session, payload: cloneLosslessJson(f.raw.get(id)!) };
  });
  return Object.assign(f, { provider, restores,
    resume: () => new BitwardenPasswordProjectRemovalCoordinator(f.vault, f.client, provider).resume(f.operationId),
    syncOrdinary: async () => new BitwardenDurableSyncCoordinator(provider, f.vault).synchronize((await f.vault.getProvider(f.account.id))!) });
}

describe('source Passkey preservation in full project removal', () => {
  it('retains native folder names on recovered copies before ordinary sync and after restart', async () => {
    const f = await removalFixture(2, false, true), before = await f.vault.readState();
    await f.prepare();
    const target = before.items.find((row): row is PasskeyItem => row.kind === 'passkey')!;
    await f.vault.upsertItem({ ...target, notes: 'Edited while copies were prepared' });
    expect((await f.resume()).status).toBe('cancelled');
    const copies = (await f.vault.readState()).items.filter(row => !before.items.some(original => original.id === row.id));
    expect(copies).toHaveLength(4);
    for (const copy of copies) {
      expect(copy).toMatchObject({ categoryName: f.folderName });
      expect(copy.providerRefs).toContainEqual(expect.objectContaining({ providerId: f.account.id, remoteFolderId: f.folderId }));
    }
    await f.restart();
    for (const copy of copies) expect(await f.vault.getItem(copy.id)).toEqual(copy);
    expect(f.creates).toHaveBeenCalledTimes(2); expect(f.deletes).not.toHaveBeenCalled();
  });

  it.each(['before-plan', 'ready', 'during-copy', 'verified'] as const)('cancels preparation after a local password edit at %s without deleting any source', async moment => {
    const f = await removalFixture();
    const before = await f.vault.readState(), target = before.items.find((row): row is LoginItem => row.kind === 'login')!;
    const edit = async () => { await f.vault.upsertItem({ ...target, password: 'Newer preparation password' }); };
    if (moment === 'ready') await f.initialize();
    if (moment === 'verified') await f.prepare();
    if (moment === 'during-copy') {
      const create = f.creates.getMockImplementation()!;
      f.creates.mockImplementationOnce(async (...args) => { const response = await create(...args); await edit(); return response; });
    } else await edit();
    expect((await f.resume()).status).toBe('cancelled');
    const state = await f.vault.readState();
    expect(state.passwordProjectRemovals?.[0]?.bitwardenPreparationRecovery).toEqual({ version: 1, reason: 'local-changed' });
    expect(state.items.find(row => row.id === target.id)).toMatchObject({ password: 'Newer preparation password' });
    expect(state.providerConflicts).toEqual([expect.objectContaining({ itemId: target.id, requiresExplicitResolution: true,
      local: expect.objectContaining({ password: 'Newer preparation password' }), remote: expect.objectContaining({ password: target.password }) })]);
    expect(state.mutationQueue).toHaveLength(0);
    const copies = moment === 'verified' ? 2 : moment === 'during-copy' ? 1 : 0;
    expect(f.creates).toHaveBeenCalledTimes(copies); expect(f.raw.size).toBe(2 + copies);
    expect(state.items.filter(row => row.kind === 'passkey')).toHaveLength(2 + copies);
    for (const original of before.items.filter(row => row.kind === 'passkey')) expect(state.items.find(row => row.id === original.id)).toEqual(original);
    expect(f.deletes).not.toHaveBeenCalled(); expect(f.restores).not.toHaveBeenCalled();
    await f.restart(); expect((await f.resume()).status).toBe('cancelled');
    expect(f.creates).toHaveBeenCalledTimes(copies);
    expect(JSON.stringify(f.storage.envelope)).not.toContain(f.pkcs8);
    await expect(f.syncOrdinary()).rejects.toThrow('冲突');
  });

  it.each([false, true])('keeps a locally edited source Passkey after preparation (source is primary: %s)', async primary => {
    const f = await removalFixture(2, primary); await f.prepare();
    const target = (await f.vault.readState()).items.find((row): row is PasskeyItem => row.kind === 'passkey')!;
    await f.vault.upsertItem({ ...target, notes: 'Edited during copy preparation' });
    expect((await f.resume()).status).toBe('cancelled');
    const state = await f.vault.readState();
    expect(state.items.find(row => row.id === target.id)).toMatchObject({ notes: 'Edited during copy preparation',
      credentialId: target.credentialId, privateKeyPkcs8: target.privateKeyPkcs8, signCount: target.signCount });
    expect(state.providerConflicts).toEqual([expect.objectContaining({ itemId: target.id, requiresExplicitResolution: true })]);
    expect(state.items.filter(row => row.kind === 'passkey')).toHaveLength(4);
    expect(f.deletes).not.toHaveBeenCalled(); expect(f.restores).not.toHaveBeenCalled(); expect(f.creates).toHaveBeenCalledTimes(2);
  });

  it('keeps unknown copy results pending across restart and recovers by discovery without another create', async () => {
    const f = await removalFixture();
    const target = (await f.vault.readState()).items.find((row): row is PasskeyItem => row.kind === 'passkey')!;
    let hidden: Record<string, unknown> | undefined;
    const create = f.creates.getMockImplementation()!;
    f.creates.mockImplementationOnce(async (...args) => {
      const result = await create(...args); hidden = result.payload; f.raw.delete(String(hidden.id));
      await f.vault.upsertItem({ ...target, notes: 'A later local edit' });
      throw new Error('Synthetic response loss');
    });
    await expect(f.resume()).rejects.toThrow();
    await f.restart(); await expect(f.resume()).rejects.toThrow();
    const record = (await f.vault.readPasswordProjectRemovals())[0];
    expect(record.status).toBe('preparing'); expect(record.bitwardenPreparationRecovery).toBeDefined();
    expect(record.bitwardenPasskeyPreservation!.sources[0].copies[0].stage).toBe('attempted');
    await expect(f.vault.cancelPasswordProjectRemovalPreparation(f.operationId)).rejects.toThrow('恢复');
    await expect(f.syncOrdinary()).rejects.toThrow('恢复');
    expect(f.creates).toHaveBeenCalledTimes(1); expect(f.deletes).not.toHaveBeenCalled();
    f.raw.set(String(hidden!.id), hidden!);
    expect((await f.resume()).status).toBe('cancelled');
    expect(f.creates).toHaveBeenCalledTimes(1); expect(f.deletes).not.toHaveBeenCalled();
    expect((await f.vault.getItem(target.id))?.notes).toBe('A later local edit');
  });

  it('restarts after the final preparation recovery save fails without recreating copies or losing edits', async () => {
    const f = await removalFixture(); await f.prepare();
    const target = (await f.vault.readState()).items.find((row): row is LoginItem => row.kind === 'login')!;
    await f.vault.upsertItem({ ...target, password: 'Keep me across failed save' });
    await f.vault.beginBitwardenPreparationRecoveryIfChanged(f.operationId);
    vi.spyOn(f.storage, 'write').mockRejectedValueOnce(new Error('Synthetic final save failure'));
    await expect(f.resume()).rejects.toThrow('Synthetic final save failure');
    await f.restart(); expect((await f.resume()).status).toBe('cancelled');
    expect((await f.vault.getItem(target.id))).toMatchObject({ password: 'Keep me across failed save' });
    expect(f.creates).toHaveBeenCalledTimes(2); expect(f.deletes).not.toHaveBeenCalled(); expect(f.restores).not.toHaveBeenCalled();
    expect((await f.vault.readState()).items.filter(row => row.kind === 'passkey')).toHaveLength(4);
  });

  it.each(['duplicate', 'trashed', 'changed'] as const)('retains preparation recovery when an observed copy is %s', async mode => {
    const f = await removalFixture(); await f.prepare();
    const target = (await f.vault.readState()).items.find((row): row is LoginItem => row.kind === 'login')!;
    await f.vault.upsertItem({ ...target, notes: 'Local note must survive' });
    const record = (await f.vault.readPasswordProjectRemovals())[0];
    const copy = f.raw.get(record.bitwardenPasskeyPreservation!.sources[0].copies[0].remoteId!)!;
    if (mode === 'duplicate') f.raw.set('duplicate-copy', { ...cloneLosslessJson(copy), id: 'duplicate-copy' });
    if (mode === 'trashed') copy.deletedDate = date;
    if (mode === 'changed') copy.name = await encryptBitwardenString('Changed copy title', f.key);
    await expect(f.resume()).rejects.toThrow();
    expect((await f.vault.readPasswordProjectRemovals())[0].status).toBe('preparing');
    expect((await f.vault.getItem(target.id))?.notes).toBe('Local note must survive');
    expect(f.creates).toHaveBeenCalledTimes(2); expect(f.deletes).not.toHaveBeenCalled();
  });

  it('recovers several removed Ciphers and preserves a later edit made during readback', async () => {
    const f = await removalFixture(3); await f.prepare();
    const targets = (await f.vault.readState()).items.filter((row): row is PasskeyItem => row.kind === 'passkey');
    await f.vault.upsertItem({ ...targets[0], notes: 'First edit' });
    const sync = f.sync.getMockImplementation()!;
    f.sync.mockImplementationOnce(async (...args) => {
      await f.vault.upsertItem({ ...targets[1], notes: 'Second edit during readback' });
      return sync(...args);
    });
    expect((await f.resume()).status).toBe('cancelled');
    const state = await f.vault.readState();
    expect(state.items.find(row => row.id === targets[0].id)?.notes).toBe('First edit');
    expect(state.items.find(row => row.id === targets[1].id)?.notes).toBe('Second edit during readback');
    expect(state.providerConflicts).toHaveLength(2);
    expect(state.items.filter(row => row.kind === 'passkey')).toHaveLength(8);
    expect(f.creates).toHaveBeenCalledTimes(4); expect(f.deletes).not.toHaveBeenCalled(); expect(f.restores).not.toHaveBeenCalled();
  });

  it('retains the initial unuploaded removal draft when a later child edit cancels preparation', async () => {
    const f = await removalFixture();
    await f.vault.cancelPasswordProjectRemovalPreparation(f.operationId);
    const before = await f.vault.readState();
    const passwords = before.items.filter((row): row is LoginItem => row.kind === 'login');
    const retained = passwords.find(row => row.providerRefs[0].remoteId !== f.sourceId)!;
    const operationId = crypto.randomUUID();
    await f.vault.stagePasswordProjectRemoval({ operationId,
      items: passwords.map(row => row.id === retained.id ? { ...row, password: 'Initial unsynced draft password' } : row),
      expected: Object.fromEntries(passwords.map(row => [row.id, row.updatedAt])), removedItemIds: passwords.filter(row => row.id !== retained.id).map(row => row.id) });
    const child = before.items.find((row): row is PasskeyItem => row.kind === 'passkey')!;
    await f.vault.upsertItem({ ...child, notes: 'Later child edit' });
    expect((await new BitwardenPasswordProjectRemovalCoordinator(f.vault, f.client, f.provider).resume(operationId)).status).toBe('cancelled');
    const state = await f.vault.readState();
    expect(state.items.find(row => row.id === retained.id)).toMatchObject({ password: 'Initial unsynced draft password' });
    expect(state.providerConflicts).toContainEqual(expect.objectContaining({ itemId: retained.id,
      local: expect.objectContaining({ password: 'Initial unsynced draft password' }), remote: expect.objectContaining({ password: retained.password }) }));
    expect(state.items.find(row => row.id === child.id)?.notes).toBe('Later child edit');
    expect(f.creates).not.toHaveBeenCalled(); expect(f.deletes).not.toHaveBeenCalled();
  });

  it.each(['omit-copies', 'duplicate-copy', 'source-hash', 'record-hash'] as const)('rejects incomplete or tampered preparation adoption: %s', async mode => {
    const f = await removalFixture(); await f.prepare();
    const target = (await f.vault.readState()).items.find((row): row is LoginItem => row.kind === 'login')!;
    await f.vault.upsertItem({ ...target, password: 'Retain this newer password' });
    const record = await f.vault.beginBitwardenPreparationRecoveryIfChanged(f.operationId);
    const result = await new BitwardenProjectRemovalVerifier(f.client, f.account).preparationReadback(record!);
    if (mode === 'omit-copies') result.passkeyCopies = [];
    if (mode === 'duplicate-copy') result.passkeyCopies.push(structuredClone(result.passkeyCopies[0]));
    if (mode === 'source-hash') result.sourceRecords[0].contentHash = 'wrong';
    if (mode === 'record-hash') result.preparationSnapshotSha256 = '0'.repeat(64);
    await expect(f.vault.completeBitwardenPreparationRecovery(result)).rejects.toThrow();
    expect((await f.vault.readPasswordProjectRemovals())[0].status).toBe('preparing');
    expect((await f.vault.getItem(target.id))).toMatchObject({ password: 'Retain this newer password' });
    expect((await f.vault.readState()).items.filter(row => row.kind === 'passkey')).toHaveLength(2);
    expect(f.deletes).not.toHaveBeenCalled();
  });

  it.each(['preparation', 'delete', 'commit'] as const)('keeps local Passkey usage during %s without changing credentials or repeating writes', async moment => {
    const f = await removalFixture();
    const originals = (await f.vault.readState()).items.filter((row): row is PasskeyItem => row.kind === 'passkey');
    const usedAt = '2026-10-09T22:00:00.000Z';
    const use = async () => {for (const row of originals) await f.vault.recordPasskeyUse(row.id, usedAt);};
    if (moment === 'preparation') {await f.initialize(); await use();}
    if (moment === 'delete') {
      const original = f.deletes.getMockImplementation()!;
      f.deletes.mockImplementation(async (...args) => {const session = await original(...args); await use(); return session;});
    }
    if (moment === 'commit') {
      vi.spyOn(f.vault, 'completePasswordProjectBitwardenDeletion').mockRejectedValueOnce(new Error('Synthetic stop before local adoption'));
      await expect(f.resume()).rejects.toThrow('Synthetic stop'); await use(); await f.restart();
    }
    expect((await f.resume()).status).toBe('completed');
    const state = await f.vault.readState();
    for (const original of originals) expect(state.items.find(row => row.id === original.id)).toMatchObject({
      credentialId: original.credentialId, privateKeyPkcs8: original.privateKeyPkcs8, signCount: original.signCount, useCount: (original.useCount || 0) + 1, lastUsedAt: usedAt
    });
    expect(state.providerConflicts).toHaveLength(0); expect(state.mutationQueue).toHaveLength(0);
    expect(f.creates).toHaveBeenCalledTimes(2); expect(f.deletes).toHaveBeenCalledTimes(1); expect(f.restores).not.toHaveBeenCalled();
    await f.syncOrdinary();
    for (const original of originals) expect(await f.vault.getItem(original.id)).toMatchObject({credentialId: original.credentialId, useCount: (original.useCount || 0) + 1, lastUsedAt: usedAt});
  });

  it('restores and keeps both versions when a source Passkey is edited after its independent copy is verified', async () => {
    const f = await removalFixture(), originalDelete = f.deletes.getMockImplementation()!;
    const target = (await f.vault.readState()).items.find((row): row is PasskeyItem => row.kind === 'passkey')!;
    f.deletes.mockImplementation(async (...args) => {
      const session = await originalDelete(...args);
      await f.vault.upsertItem({...target, notes: 'Keep the newer source key note'});
      return session;
    });
    expect((await f.resume()).status).toBe('cancelled');
    const state = await f.vault.readState();
    expect(state.items.find(row => row.id === target.id)).toMatchObject({notes: 'Keep the newer source key note', credentialId: target.credentialId, privateKeyPkcs8: target.privateKeyPkcs8});
    expect(state.providerConflicts).toEqual([expect.objectContaining({itemId: target.id, requiresExplicitResolution: true})]);
    expect(f.creates).toHaveBeenCalledTimes(2); expect(f.deletes).toHaveBeenCalledTimes(1); expect(f.restores).toHaveBeenCalledTimes(1);
  });

  it('preserves credentials from several removed Ciphers without overlapping their destinations', async () => {
    const f = await removalFixture(3), before = (await f.vault.readState()).items.filter(row => row.kind === 'passkey');
    const result = await f.resume(); expect(result.status).toBe('completed');
    expect(result.bitwardenPasskeyPreservation!.sources).toHaveLength(2);
    const after = await f.vault.readState();
    expect(after.items.filter(row => row.kind === 'passkey' && !row.deletedAt).map(row => row.id).sort()).toEqual(before.map(row => row.id).sort());
    expect(after.sourceRecords).toHaveLength(7); expect(f.creates).toHaveBeenCalledTimes(4); expect(f.deletes).toHaveBeenCalledTimes(2);
  });

  it('retains empty attachment proof when the primary carrier copy response is lost', async () => {
    const f = await removalFixture(2, true), create = f.creates.getMockImplementation()!;
    f.creates.mockImplementationOnce(async (...args) => { await create(...args); throw new Error('Synthetic primary copy loss'); });
    await expect(f.resume()).rejects.toThrow('Synthetic');
    const pending = (await f.vault.readPasswordProjectRemovals())[0];
    expect(pending.ownerTransfer).toBeTruthy(); expect(pending.proofs).toHaveLength(1); expect(pending.proofs![0].attachments).toEqual([]);
    await f.restart(); expect((await f.resume()).status).toBe('completed');
    expect(f.creates).toHaveBeenCalledTimes(2); expect(f.deletes).toHaveBeenCalledTimes(1);
  });

  it('keeps local use statistics and other-provider references on the surviving original ID only', async () => {
    const f = await removalFixture(), state = await f.vault.readState();
    const localId = state.providers.find(row => row.kind === 'local')!.id;
    const passkey = state.items.find(row => row.kind === 'passkey') as PasskeyItem;
    const updated = { ...passkey, useCount: 7, lastUsedAt: date, providerRefs: [...passkey.providerRefs, { providerId: localId }] };
    await f.vault.applyProviderSync(f.account.id, state.items.map(row => row.id === passkey.id ? updated : row), undefined, [], state.sourceRecords);
    await f.prepare(); await f.resume();
    const after = await f.vault.readState(), moved = after.items.find(row => row.id === passkey.id) as PasskeyItem;
    expect(moved.useCount).toBe(7); expect(moved.lastUsedAt).toBe(date); expect(moved.providerRefs.some(row => row.providerId === localId)).toBe(true);
    const trash = after.items.find(row => row.providerRefs.some(ref => ref.remoteId === passkey.providerRefs[0].remoteId))!;
    expect(trash.deletedAt).toBeTruthy(); expect(trash.providerRefs).toHaveLength(1); expect(trash.providerRefs[0].providerId).toBe(f.account.id);
  });

  it('moves existing local IDs and keeps signing after source tombstones, restart and ordinary sync', async () => {
    const f = await removalFixture(), original = (await f.vault.readState()).items.filter((row): row is PasskeyItem => row.kind === 'passkey');
    const completed = await f.resume(); expect(completed.status).toBe('completed');
    const after = await f.vault.readState();
    expect(after.mutationQueue).toHaveLength(0); expect(after.sourceRecords).toHaveLength(4);
    for (const before of original) {
      const moved = after.items.find(row => row.id === before.id) as PasskeyItem;
      expect(moved.deletedAt).toBeUndefined(); expect(moved.privateKeyPkcs8).toBe(before.privateKeyPkcs8); expect(moved.signCount).toBe(before.signCount);
      expect(moved.credentialId).toBe(before.credentialId); expect(moved.providerRefs[0].remoteId).not.toBe(before.providerRefs[0].remoteId);
      const trash = after.items.filter(row => row.providerRefs.some(ref => ref.remoteId === before.providerRefs[0].remoteId));
      expect(trash).toHaveLength(1); expect(trash[0].deletedAt).toBeTruthy(); expect(trash[0].id).not.toBe(before.id);
      const signingKey = await crypto.subtle.importKey('pkcs8', Buffer.from(moved.privateKeyPkcs8!, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
      const jwk = await crypto.subtle.exportKey('jwk', signingKey); delete jwk.d; jwk.key_ops = ['verify'];
      const publicKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const challenge = crypto.getRandomValues(new Uint8Array(32)), signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, challenge);
      expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, challenge)).toBe(true);
    }
    await f.restart(); await f.syncOrdinary(); await f.syncOrdinary();
    const final = await f.vault.readState(); expect(final.providerConflicts).toHaveLength(0);
    expect(final.items.filter(row => row.kind === 'passkey' && !row.deletedAt).map(row => row.id).sort()).toEqual(original.map(row => row.id).sort());
    expect(f.creates).toHaveBeenCalledTimes(2); expect(f.deletes).toHaveBeenCalledTimes(1);
  });

  it.each(['copy-response', 'final-save'] as const)('recovers %s loss through the complete coordinator without replaying writes', async mode => {
    const f = await removalFixture();
    if (mode === 'copy-response') {
      const create = f.creates.getMockImplementation()!;
      f.creates.mockImplementationOnce(async (...args) => { await create(...args); throw new Error('Synthetic copy response loss'); });
    } else {
      const complete = f.vault.completePasswordProjectBitwardenDeletion.bind(f.vault);
      vi.spyOn(f.vault, 'completePasswordProjectBitwardenDeletion').mockImplementation(async input => {
        vi.spyOn(f.storage, 'write').mockRejectedValueOnce(new Error('Synthetic final save loss')); return complete(input);
      });
    }
    await expect(f.resume()).rejects.toThrow('Synthetic'); await f.restart();
    expect((await f.resume()).status).toBe('completed');
    expect(f.creates).toHaveBeenCalledTimes(2); expect(f.deletes).toHaveBeenCalledTimes(1);
  });

  it('restores the original when a verified copy changes during deletion', async () => {
    const f = await removalFixture(), actualDelete = f.deletes.getMockImplementation()!;
    f.deletes.mockImplementation(async (...args) => {
      const session = await actualDelete(...args);
      const record = (await f.vault.readPasswordProjectRemovals())[0];
      const copyId = record.bitwardenPasskeyPreservation!.sources[0].copies[0].remoteId!;
      f.raw.get(copyId)!.notes = await encryptBitwardenString('Concurrent copy note', f.key);
      return session;
    });
    expect((await f.resume()).status).toBe('cancelled'); expect(f.restores).toHaveBeenCalledTimes(1);
    const state = await f.vault.readState(); expect(state.mutationQueue).toHaveLength(0);
    expect(state.items.filter(row => row.kind === 'passkey' && !row.deletedAt)).toHaveLength(2);
    expect(f.raw.get(f.sourceId)!.deletedDate).toBeNull();
  });

  it.each(['source-restored', 'copy-changed'] as const)('recovers %s after remote commit and before local adoption', async mode => {
    const f = await removalFixture();
    vi.spyOn(f.vault, 'completePasswordProjectBitwardenDeletion').mockRejectedValueOnce(new Error('Pause at committed'));
    await expect(f.resume()).rejects.toThrow('Pause');
    const record = (await f.vault.readPasswordProjectRemovals())[0]; expect(record.bitwardenDeletion!.phase).toBe('committed');
    if (mode === 'source-restored') f.raw.get(f.sourceId)!.deletedDate = null;
    else {
      const id = record.bitwardenPasskeyPreservation!.sources[0].copies[0].remoteId!;
      f.raw.get(id)!.notes = await encryptBitwardenString('Changed after commit', f.key);
    }
    await f.restart(); expect((await f.resume()).status).toBe('cancelled');
    expect(f.deletes).toHaveBeenCalledTimes(1); expect(f.restores).toHaveBeenCalledTimes(mode === 'source-restored' ? 0 : 1);
    expect((await f.vault.readState()).items.filter(row => row.kind === 'passkey' && !row.deletedAt)).toHaveLength(2);
  });

  it('blocks ordinary sync before requests and direct projection replacement while copies are pending', async () => {
    const f = await removalFixture(); await f.initialize(); const snapshot = await f.vault.readState();
    const sync = vi.spyOn(f.provider, 'sync');
    await expect(f.syncOrdinary()).rejects.toThrow('Passkey'); expect(sync).not.toHaveBeenCalled();
    await expect(f.vault.applyProviderSync(f.account.id, snapshot.items, undefined, [], snapshot.sourceRecords, snapshot.items)).rejects.toThrow('Passkey');
    expect((await f.vault.readState()).items).toEqual(snapshot.items);
  });

  it.each(['missing', 'changed-key', 'extra', 'wrong-envelope'] as const)('refuses %s copy adoption without clearing the journal', async mode => {
    const f = await removalFixture();
    vi.spyOn(f.vault, 'completePasswordProjectBitwardenDeletion').mockRejectedValueOnce(new Error('Pause before final save'));
    await expect(f.resume()).rejects.toThrow('Pause');
    const record = (await f.vault.readPasswordProjectRemovals())[0];
    const verifier = new BitwardenProjectRemovalVerifier(f.client, f.account), result = await verifier.committedReadback(record);
    if (mode === 'missing') delete result.passkeyCopies;
    if (mode === 'extra') result.passkeyCopies!.sourceRecords.push(structuredClone(result.passkeyCopies!.sourceRecords[0]));
    if (mode === 'wrong-envelope') result.passkeyCopies!.sourceRecords[0].contentHash = 'wrong';
    if (mode === 'changed-key') {
      const source = result.passkeyCopies!.sourceRecords[0], raw = JSON.parse(source.payload);
      raw.login.fido2Credentials[0].keyValue = await encryptBitwardenString('wrong', f.key);
      result.passkeyCopies!.sourceRecords[0] = await createSourceRecord({ ...source, payload: JSON.stringify(raw) });
    }
    const before = JSON.stringify(f.storage.envelope);
    await expect(f.vault.completePasswordProjectBitwardenDeletion(result)).rejects.toThrow();
    expect(JSON.stringify(f.storage.envelope)).toBe(before); expect((await f.vault.readPasswordProjectRemovals())[0].status).toBe('deleting');
  });
});
