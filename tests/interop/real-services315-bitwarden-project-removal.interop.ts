import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createLoginItem, type LoginItem, type PasskeyItem, type ProviderAccount } from '../../src/core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../../src/core/project-credentials';
import { passwordProjectRemovalContent } from '../../src/core/password-project-removal-journal';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { BitwardenProvider } from '../../src/providers/bitwarden/bitwarden-provider';
import { BitwardenDurableSyncCoordinator } from '../../src/providers/bitwarden/bitwarden-durable-sync';
import { decodeBitwardenCipher, encodeBitwardenCipher, encodeBitwardenPasskeyCipher } from '../../src/providers/bitwarden/bitwarden-cipher-codec';
import { deriveBitwardenMasterKey, deriveBitwardenMasterPasswordHash, stretchBitwardenMasterKey } from '../../src/providers/bitwarden/bitwarden-crypto';
import { BitwardenAttachmentDownloadService } from '../../src/providers/bitwarden/bitwarden-attachments';
import { BitwardenAttachmentMutationService } from '../../src/providers/bitwarden/bitwarden-attachment-mutations';
import { MemoryBitwardenAttachmentMutationStore } from '../../src/providers/bitwarden/bitwarden-attachment-mutation-store';
import { BitwardenProjectRemovalTransaction,
  bitwardenProjectRemovalStore } from '../../src/providers/bitwarden/bitwarden-project-removal-transaction';
import { BitwardenProjectRemovalVerifier } from '../../src/providers/bitwarden/bitwarden-project-removal-verification';
import { BitwardenPasswordProjectRemovalCoordinator } from '../../src/providers/bitwarden/bitwarden-project-removal';
import { SecureVaultService } from '../../src/security/secure-vault-service';
import { MemoryVaultStorage } from '../../src/security/vault-storage';
import { MemoryVaultSessionStore } from '../../src/security/vault-session';

const configPath = process.env.MONICA_315_REAL_SERVICES_CONFIG;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const value = (raw: Record<string, unknown>, key: string) => raw[key] ?? raw[key[0].toUpperCase() + key.slice(1)];
const scenarios = ['complete', 'delete-loss', 'concurrent-source', 'concurrent-target', 'attachment-window', 'restore-loss', 'new-member', 'retained-credentials', 'source-passkey',
  'coordinator-complete', 'coordinator-upload-loss', 'coordinator-final-save-loss', 'coordinator-rollback',
  'coordinator-rollback-save-loss', 'coordinator-rollback-restore-loss', 'coordinator-rollback-new-member'] as const;

it.skipIf(!configPath).each(scenarios)('runs actual journaled project removal and attachment recovery: %s', async scenario => {
  const config = JSON.parse(await readFile(resolve(configPath!), 'utf8'));
  expect(config.project).toBe('monica315-interop-20260930');
  const { baseUrl, password } = config.vaultwarden;
  expect(baseUrl).toBe('http://127.0.0.1:18316');
  const rollback = scenario.includes('rollback');
  const root = rollback ? '.tmp/bw-project-restoration-318' : scenario.startsWith('coordinator-') ? '.tmp/bw-project-adoption-318' : '.tmp/bw-project-verification-318';
  await mkdir(resolve(root), { recursive: true });
  const output = await mkdtemp(join(resolve(root), `${scenario}-`));
  const evidence: Record<string, unknown> = { status: 'failed', scenario, output, layer: 'Real Vaultwarden HTTP plus encrypted transaction journal; runtime/UI integration pending' };
  try {
    const client = new BitwardenClient(), email = `project-removal-${randomUUID()}@example.invalid`;
    const master = await deriveBitwardenMasterKey(password, email, { type: 0, iterations: 600000 });
    const key = { encKey: crypto.getRandomValues(new Uint8Array(32)), macKey: crypto.getRandomValues(new Uint8Array(32)) };
    try {
      const registration = await fetch(`${baseUrl}/identity/accounts/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        email, name: 'Synthetic project removal transaction', masterPasswordHash: await deriveBitwardenMasterPasswordHash(master, password),
        key: await client.protectVaultKey(key, await stretchBitwardenMasterKey(master), crypto.getRandomValues(new Uint8Array(16))), kdf: 0, kdfIterations: 600000
      }) }); expect(registration.ok).toBe(true);
    } finally { master.fill(0); key.encKey.fill(0); key.macKey.fill(0); }
    const login = await client.login({ vaultUrl: baseUrl, email, masterPassword: password, deviceId: randomUUID() });
    if (login.status !== 'authenticated') throw new Error('Synthetic login failed');
    const session = login.session;
    const account: ProviderAccount = { id: 'bw-project-removal', kind: 'bitwarden', name: 'Project removal transaction', enabled: true, isDefaultSaveTarget: false, config: session };
    const storage = new MemoryVaultStorage(); let vault = new SecureVaultService(storage, new MemoryVaultSessionStore());
    const localPassword = 'Synthetic project removal encrypted vault';
    await vault.setup(localPassword); await vault.upsertProvider(account);
    const groupId = randomUUID(), retainedGroupId = randomUUID(), projectId = randomUUID();
    const rows: LoginItem[] = [0, 1, 2].map(index => ({ ...createLoginItem({ title: 'Shared project', username: 'synthetic', password: `source-password-${index}`, providerRefs: [{ providerId: account.id }] }),
      passwordGroupId: projectId, customFields: [{ name: PROJECT_CREDENTIAL_FIELD, protected: true, value: JSON.stringify({ version: 1, projectId, groupId: index === 2 ? retainedGroupId : groupId,
        passwordId: randomUUID(), primary: index !== 2, label: index === 2 ? 'Retained' : 'Shared', groupOrder: index === 2 ? 1 : 0, passwordOrder: index === 2 ? 0 : index }).replace(/}$/, ',"future":9007199254740993}') }] }));
    rows[0].customFields.push({ name: 'Shared secret', value: '  exact shared secret\r\n中文  ', protected: true });
    rows[0].totpSecret = 'otpauth://hotp/Source?secret=JBSWY3DPEHPK3PXP&counter=23&algorithm=SHA256&digits=8';
    rows[1].totpSecret = rows[0].totpSecret;
    rows[2].totpSecret = 'otpauth://totp/Retained?secret=JBSWY3DPEHPK3PAA&period=60&algorithm=SHA512&digits=8';
    await vault.savePasswordGroup(rows, {});
    await new BitwardenDurableSyncCoordinator(new BitwardenProvider(), vault).synchronize(account);
    const before = (await vault.readState()).items.filter((row): row is LoginItem => row.kind === 'login');
    const source = before.find(row => row.id === rows[0].id)!, second = before.find(row => row.id === rows[1].id)!, target = before.find(row => row.id === rows[2].id)!;
    const cipherId = (row: LoginItem) => row.providerRefs.find(ref => ref.providerId === account.id)!.remoteId!;
    const read = async (id: string) => { const result = await client.getCipherDetails(session, id); if (!result.payload) throw new Error('Missing synthetic Cipher'); return result.payload; };
    let originalPasskey: PasskeyItem | undefined, publicKey: CryptoKey | undefined;
    if (['retained-credentials', 'source-passkey'].includes(scenario) || scenario.startsWith('coordinator-')) {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']); publicKey = pair.publicKey;
      const parent = scenario === 'source-passkey' ? source : target;
      originalPasskey = { id: randomUUID(), kind: 'passkey', title: 'Synthetic signing proof', rpId: 'example.invalid', rpName: 'Synthetic signing proof',
        credentialId: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'), userHandle: Buffer.from('synthetic-user').toString('base64url'),
        userName: 'synthetic', userDisplayName: 'Synthetic user', algorithm: -7, publicKey: '',
        privateKeyPkcs8: Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64'),
        signCount: 0, discoverable: true, sourceMode: 'bitwarden', notes: '', favorite: false, providerRefs: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      const raw = await read(cipherId(parent));
      const payload = await encodeBitwardenPasskeyCipher(originalPasskey, client.vaultKey(session), raw);
      payload.lastKnownRevisionDate = value(raw, 'revisionDate');
      await client.updateCipher(session, cipherId(parent), payload);
    }
    const attachments = new BitwardenAttachmentMutationService({ store: new MemoryBitwardenAttachmentMutationStore() });
    const sharedBytes = new TextEncoder().encode('Shared project attachment 中文\u0000same bytes');
    const upload = async (row: LoginItem, fileName: string, bytes: Uint8Array) => attachments.upload({ providerId: account.id, itemId: row.id,
      session, rawCipher: await read(cipherId(row)), operationId: randomUUID(), fileName, bytes: bytes.slice(), sha256: sha(bytes) });
    await upload(source, 'shared.txt', sharedBytes);
    await new BitwardenDurableSyncCoordinator(new BitwardenProvider(), vault).synchronize(account);
    const original = (await vault.readState()).items.filter((row): row is LoginItem => row.kind === 'login');
    const operationId = randomUUID();
    await vault.stagePasswordProjectRemoval({ operationId, items: original, expected: Object.fromEntries(original.map(row => [row.id, row.updatedAt])), removedItemIds: [source.id, second.id] });
    if (scenario.startsWith('coordinator-')) {
      const initialIds = (await vault.readState()).items.map(row => row.id).sort();
      const actualDelete = client.softDeleteCipher.bind(client), actualRestore = client.restoreCipherOnce.bind(client);
      const deletionSpy = vi.spyOn(client, 'softDeleteCipher');
      const restorationSpy = vi.spyOn(client, 'restoreCipherOnce');
      const realUpload = attachments.upload.bind(attachments), uploads: string[] = [];
      let injected = false;
      if (rollback) {
        deletionSpy.mockImplementation(async (currentSession, id, signal) => {
          for (const [changedId, patch] of [[id, { password: 'Latest rollback source password' }], [cipherId(target), { notes: 'Latest rollback target note' }]] as const) {
            const raw = await read(changedId), cipherKey = client.vaultKey(currentSession);
            try {
              const item = (await decodeBitwardenCipher(raw, account.id, cipherKey)).items.find((row): row is LoginItem => row.kind === 'login')!;
              const payload = await encodeBitwardenCipher({ ...item, ...patch }, cipherKey, raw);
              payload.lastKnownRevisionDate = value(raw, 'revisionDate'); await client.updateCipher(currentSession, changedId, payload);
            } finally { cipherKey.encKey.fill(0); cipherKey.macKey.fill(0); }
          }
          const deleted = await actualDelete(currentSession, id, signal);
          if (scenario === 'coordinator-rollback-new-member') {
            const cipherKey = client.vaultKey(deleted);
            try {
              const item = (await decodeBitwardenCipher(await read(cipherId(target)), account.id, cipherKey)).items.find((row): row is LoginItem => row.kind === 'login')!;
              const fields = item.customFields.map(field => field.name === PROJECT_CREDENTIAL_FIELD
                ? { ...field, value: field.value.replace(/"passwordId":"[^"]+"/, `"passwordId":"${randomUUID()}"`) } : field);
              await client.createCipher(deleted, await encodeBitwardenCipher({ ...item, password: 'New rollback project member', customFields: fields }, cipherKey));
            } finally { cipherKey.encKey.fill(0); cipherKey.macKey.fill(0); }
          }
          return deleted;
        });
        restorationSpy.mockImplementation(async (...args) => {
          const result = await actualRestore(...args);
          if (scenario === 'coordinator-rollback-restore-loss' && !injected) { injected = true; throw new Error('Synthetic coordinator restore response lost'); }
          return result;
        });
      }
      vi.spyOn(attachments, 'upload').mockImplementation(async input => {
        const result = await realUpload(input); uploads.push(input.operationId);
        if (scenario === 'coordinator-upload-loss' && !injected) { injected = true; throw new Error('Synthetic coordinator upload response lost'); }
        return result;
      });
      if (scenario === 'coordinator-final-save-loss') {
        const complete = vault.completePasswordProjectBitwardenDeletion.bind(vault);
        vi.spyOn(vault, 'completePasswordProjectBitwardenDeletion').mockImplementation(async result => {
          if (!injected) { injected = true; vi.spyOn(storage, 'write').mockRejectedValueOnce(new Error('Synthetic coordinator final save failed')); }
          return complete(result);
        });
      }
      if (scenario === 'coordinator-rollback-save-loss') {
        const complete = vault.completePasswordProjectBitwardenRestoration.bind(vault);
        vi.spyOn(vault, 'completePasswordProjectBitwardenRestoration').mockImplementation(async result => {
          if (!injected) { injected = true; vi.spyOn(storage, 'write').mockRejectedValueOnce(new Error('Synthetic coordinator rollback save failed')); }
          return complete(result);
        });
      }
      const make = () => new BitwardenPasswordProjectRemovalCoordinator(vault, client, new BitwardenProvider(), new BitwardenAttachmentDownloadService(), attachments);
      let completed;
      try { completed = await make().resume(operationId); }
      catch (cause) {
        if (scenario === 'coordinator-complete' || !(cause instanceof Error) || !cause.message.startsWith('Synthetic coordinator')) throw cause;
        const pending = (await vault.readPasswordProjectRemovals()).find(row => row.id === operationId)!;
        expect(pending.status).toBe(scenario === 'coordinator-upload-loss' ? 'preparing' : 'deleting');
        await writeFile(join(output, 'interrupted-vault.encrypted.json'), JSON.stringify(storage.envelope));
        await vault.lock(); vault = new SecureVaultService(storage, new MemoryVaultSessionStore()); await vault.unlock(localPassword);
        completed = await make().resume(operationId);
      }
      expect(completed.status).toBe(rollback ? 'cancelled' : 'completed'); expect(deletionSpy).toHaveBeenCalledTimes(rollback ? 1 : 2); expect(uploads).toHaveLength(1);
      expect(restorationSpy).toHaveBeenCalledTimes(rollback ? 1 : 0);
      const local = await vault.readState();
      if (scenario === 'coordinator-rollback-new-member') {
        expect(initialIds.every(id => local.items.some(row => row.id === id))).toBe(true);
        expect(local.items.some(row => row.kind === 'login' && row.password === 'New rollback project member')).toBe(true);
      } else expect(local.items.map(row => row.id).sort()).toEqual(initialIds);
      expect(local.mutationQueue).toHaveLength(0); expect(local.providerConflicts).toHaveLength(0);
      expect(local.providerMutationReceipts).toHaveLength(0);
      expect(local.sourceRecords.filter(row => row.providerId === account.id)).toHaveLength(scenario === 'coordinator-rollback-new-member' ? 4 : 3);
      for (const parent of [source, second]) {
        const id = cipherId(parent), remote = await read(id); expect(Boolean(value(remote, 'deletedDate'))).toBe(!rollback);
        expect(local.items.filter(row => row.providerRefs.some(ref => ref.providerId === account.id && ref.remoteId?.split('#')[0] === id)).every(row => Boolean(row.deletedAt) === !rollback)).toBe(true);
      }
      if (rollback) {
        expect(local.items.find(row => row.id === source.id)).toMatchObject({ password: 'Latest rollback source password' });
        expect(local.items.find(row => row.id === target.id)).toMatchObject({ notes: 'Latest rollback target note' });
        await new BitwardenDurableSyncCoordinator(new BitwardenProvider(), vault).synchronize(await vault.getProvider(account.id) as ProviderAccount);
        expect(deletionSpy).toHaveBeenCalledTimes(1);
      }
      const fresh = await new BitwardenProvider().sync(account, { now: new Date().toISOString(), localItems: [], readOnly: true });
      const actual = fresh.items.find((row): row is PasskeyItem => row.kind === 'passkey' && row.credentialId === originalPasskey!.credentialId)!;
      expect(actual.privateKeyPkcs8).toBe(originalPasskey!.privateKeyPkcs8); expect(actual.signCount).toBe(0); expect(actual.deletedAt).toBeUndefined();
      const key = await crypto.subtle.importKey('pkcs8', Buffer.from(actual.privateKeyPkcs8!, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      const challenge = crypto.getRandomValues(new Uint8Array(32)), signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, challenge);
      expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey!, signature, challenge)).toBe(true);
      const reader = new BitwardenAttachmentDownloadService();
      for (const parent of [source, target]) {
        const rawCipher = await read(cipherId(parent));
        const context = { providerId: account.id, itemId: parent.id, session, rawCipher };
        const files = await reader.listAttachments(context); expect(files.items).toHaveLength(1);
        const opened = await reader.beginDownload({ ...context, attachmentId: files.items[0].attachmentId });
        try { expect(sha(reader.readChunk(account.id, opened.readHandle, 0, 65536).bytes)).toBe(sha(sharedBytes)); }
        finally { reader.release(account.id, opened.readHandle); }
      }
      const beforeRestart = await vault.readState();
      await vault.lock(); vault = new SecureVaultService(storage, new MemoryVaultSessionStore()); await vault.unlock(localPassword);
      expect((await vault.readState()).items).toEqual(beforeRestart.items);
      expect((await make().resume(operationId)).status).toBe(rollback ? 'cancelled' : 'completed');
      expect(deletionSpy).toHaveBeenCalledTimes(rollback ? 1 : 2); expect(restorationSpy).toHaveBeenCalledTimes(rollback ? 1 : 0);
      await writeFile(join(output, 'final-vault.encrypted.json'), JSON.stringify(storage.envelope));
      await writeFile(join(output, 'server-readback.synthetic.json'), JSON.stringify(fresh.items, null, 2));
      Object.assign(evidence, { status: 'passed', layer: 'Production preparation, transaction, final atomic local adoption and encrypted restart; runtime/UI still pending',
        phase: completed.status, uploads: uploads.length, deletes: deletionSpy.mock.calls.length, restores: restorationSpy.mock.calls.length,
        localIdsPreserved: true, emptyQueue: true, childTrashApplied: !rollback, rollbackLatestContentPreserved: rollback,
        retainedPasskeySignature: true, retainedPasskeyIdKeyZeroCounter: true, sharedAttachmentSha256: sha(sharedBytes) });
      return;
    }
    await new BitwardenDurableSyncCoordinator(new BitwardenProvider(), vault).synchronize(account);
    // Production attachment service encrypts, uploads, downloads and hashes the copy.
    // This harness exercises transaction semantics; runtime transfer wiring is separate.
    await upload(target, 'shared.txt', sharedBytes);
    await new BitwardenDurableSyncCoordinator(new BitwardenProvider(), vault).synchronize(account);
    const preflightState = await vault.readState();
    const savedRecord = (await vault.readPasswordProjectRemovals()).find(row => row.id === operationId)!;
    const differences = [...savedRecord.retained, ...savedRecord.removed].flatMap(expected => {
      const current = preflightState.items.find(row => row.id === expected.id) as LoginItem;
      if (!current) return [{ id: expected.id, keys: ['missing'] }];
      const a = JSON.parse(passwordProjectRemovalContent(expected)), b = JSON.parse(passwordProjectRemovalContent(current));
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
      return keys.length ? [{ id: expected.id, keys, expected: a, current: b }] : [];
    });
    if (differences.length) { evidence.preflightDifferences = differences.map(row => ({ id: row.id, keys: row.keys })); await writeFile(join(output, 'preflight.synthetic.json'), JSON.stringify(differences, null, 2)); }
    const observed = await vault.inspectPasswordProjectRemoval(operationId);
    const download = new BitwardenAttachmentDownloadService();
    const list = async (row: LoginItem) => download.listAttachments({ providerId: account.id, itemId: row.id, session, rawCipher: await read(cipherId(row)) });
    const firstFile = (await list(source)).items[0], targetFile = (await list(target)).items[0];
    const proof = { providerId: account.id, sourceItemId: source.id, targetItemId: target.id, attachments: [{
      sourceAttachmentId: firstFile.attachmentId, targetAttachmentId: targetFile.attachmentId, fileName: firstFile.fileName,
      mediaType: firstFile.mediaType, sizeBytes: sharedBytes.length, sha256: sha(sharedBytes) }] };
    const verifier = new BitwardenProjectRemovalVerifier(client, account, download);
    const acknowledged = { ...observed.record, retained: observed.record.retained.map(row => observed.items.find(item => item.id === row.id)!),
      removed: observed.record.removed.map(row => observed.items.find(item => item.id === row.id)!), proofs: [proof] };
    if (scenario === 'source-passkey') {
      await expect(verifier.prepare(acknowledged)).rejects.toThrow('包含 Passkey');
      for (const row of [source, second, target]) expect(value(await read(cipherId(row)), 'deletedDate')).toBeFalsy();
      const preserved = (await decodeBitwardenCipher(await read(cipherId(source)), account.id, client.vaultKey(session))).items.find((row): row is PasskeyItem => row.kind === 'passkey')!;
      expect(preserved.credentialId).toBe(originalPasskey!.credentialId); expect(preserved.privateKeyPkcs8).toBe(originalPasskey!.privateKeyPkcs8); expect(preserved.signCount).toBe(0);
      Object.assign(evidence, { status: 'passed', blockedBeforeDeletion: true, originalPasskeyPreserved: true });
      return;
    }
    const intent = await verifier.prepare(acknowledged);
    const initial = await vault.finalizePasswordProjectRemoval(operationId, observed.items, [proof], undefined, intent);
    const verifyBytes = async (row: LoginItem, attachmentId: string) => {
      const result = await download.beginDownload({ providerId: account.id, itemId: row.id, session, rawCipher: await read(cipherId(row)), attachmentId });
      try { expect(sha(download.readChunk(account.id, result.readHandle, 0, 65536).bytes)).toBe(sha(sharedBytes)); }
      finally { download.release(account.id, result.readHandle); }
    };
    const change = async (id: string, mutation: Partial<LoginItem>) => {
      const raw = await read(id);
      const item = (await decodeBitwardenCipher(raw, account.id, client.vaultKey(session))).items.find((row): row is LoginItem => row.kind === 'login')!;
      const payload = await encodeBitwardenCipher({ ...item, ...mutation }, client.vaultKey(session), raw);
      payload.lastKnownRevisionDate = value(raw, 'revisionDate');
      await client.updateCipher(session, id, payload);
    };
    const remote = verifier.remote();
    const remove = remote.deleteCipher, restore = remote.restoreCipher;
    const deletions: string[] = [], restorations: string[] = [];
    let lostDelete = false, lostRestore = false;
    remote.deleteCipher = async id => {
      if (id === cipherId(source) && scenario === 'concurrent-source') await change(id, { password: 'latest-concurrent-source-password' });
      if (id === cipherId(source) && scenario === 'attachment-window') await upload(source, 'concurrent.txt', new TextEncoder().encode('New concurrent attachment'));
      await remove(id); deletions.push(id);
      if (scenario === 'delete-loss' && !lostDelete) { lostDelete = true; throw new Error('Synthetic lost delete response after actual commit'); }
      if (deletions.length === 2 && ['concurrent-target', 'restore-loss'].includes(scenario)) await change(cipherId(target), { notes: 'Latest concurrent target notes' });
      if (deletions.length === 2 && scenario === 'new-member') {
        const remoteTarget = (await decodeBitwardenCipher(await read(cipherId(target)), account.id, client.vaultKey(session))).items.find((row): row is LoginItem => row.kind === 'login')!;
        const fields = remoteTarget.customFields.map(field => field.name === PROJECT_CREDENTIAL_FIELD
          ? { ...field, value: field.value.replace(/"passwordId":"[^"]+"/, `"passwordId":"${randomUUID()}"`) } : field);
        await client.createCipher(session, await encodeBitwardenCipher({ ...remoteTarget, customFields: fields, password: 'independent new member password', providerRefs: [] }, client.vaultKey(session)));
      }
    };
    remote.restoreCipher = async id => {
      await restore(id); restorations.push(id);
      if (scenario === 'restore-loss' && !lostRestore) { lostRestore = true; throw new Error('Synthetic lost restore response after actual commit'); }
    };
    let outcome;
    try { outcome = await new BitwardenProjectRemovalTransaction(bitwardenProjectRemovalStore(vault), remote).resume(operationId); }
    catch (cause) {
      if (!['delete-loss', 'restore-loss'].includes(scenario) || !(cause instanceof Error) || !cause.message.startsWith('Synthetic lost')) throw cause;
      await writeFile(join(output, 'interrupted-vault.encrypted.json'), JSON.stringify(storage.envelope));
      await vault.lock(); vault = new SecureVaultService(storage, new MemoryVaultSessionStore()); await vault.unlock(localPassword);
      outcome = await new BitwardenProjectRemovalTransaction(bitwardenProjectRemovalStore(vault), remote).resume(operationId);
    }
    const committed = ['complete', 'delete-loss', 'retained-credentials'].includes(scenario);
    expect(outcome.bitwardenDeletion!.phase).toBe(committed ? 'committed' : 'restored');
    expect(new Set(deletions).size).toBe(deletions.length); expect(new Set(restorations).size).toBe(restorations.length);
    for (const row of [source, second]) expect(Boolean(value(await read(cipherId(row)), 'deletedDate'))).toBe(committed);
    expect(Boolean(value(await read(cipherId(target)), 'deletedDate'))).toBe(false);
    await verifyBytes(source, firstFile.attachmentId); await verifyBytes(target, targetFile.attachmentId);
    const fresh = await new BitwardenProvider().sync(account, { now: new Date().toISOString(), localItems: [], readOnly: true });
    const readback = fresh.items.filter((row): row is LoginItem => row.kind === 'login');
    expect(readback).toHaveLength(scenario === 'new-member' ? 4 : 3);
    const targetItem = readback.find(row => cipherId(row) === cipherId(target))!;
    expect(targetItem.customFields).toContainEqual(rows[0].customFields[1]);
    expect(targetItem.totpSecret).toBe(rows[2].totpSecret);
    expect(readback.find(row => cipherId(row) === cipherId(source))!.totpSecret).toBe(rows[0].totpSecret);
    if (originalPasskey) {
      const preserved = fresh.items.find((row): row is PasskeyItem => row.kind === 'passkey' && row.credentialId === originalPasskey!.credentialId)!;
      expect(preserved.privateKeyPkcs8).toBe(originalPasskey.privateKeyPkcs8); expect(preserved.signCount).toBe(0);
      const key = await crypto.subtle.importKey('pkcs8', Buffer.from(preserved.privateKeyPkcs8!, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      const challenge = crypto.getRandomValues(new Uint8Array(32)), signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, challenge);
      expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey!, signature, challenge)).toBe(true);
      evidence.retainedPasskeySigning = 'fresh remote PKCS8 import/sign/verify passed; ID/key/zero counter unchanged';
    }
    if (scenario === 'concurrent-source') expect(readback.find(row => cipherId(row) === cipherId(source))?.password).toBe('latest-concurrent-source-password');
    if (['concurrent-target', 'restore-loss'].includes(scenario)) expect(targetItem.notes).toBe('Latest concurrent target notes');
    if (scenario === 'attachment-window') expect((await list(source)).items.map(row => row.fileName).sort()).toEqual(['concurrent.txt', 'shared.txt']);
    await writeFile(join(output, 'journal-vault.encrypted.json'), JSON.stringify(storage.envelope));
    await writeFile(join(output, 'server-readback.synthetic.json'), JSON.stringify(readback, null, 2));
    Object.assign(evidence, { status: 'passed', phase: outcome.bitwardenDeletion!.phase, journalRevision: outcome.bitwardenDeletion!.revision,
      removed: initial.removed.map(row => cipherId(row)), deletions, restorations, sharedAttachmentSha256: sha(sharedBytes), sharedContentPreserved: true,
      projectId, localAdoptionAndRuntimeGate: 'pending; transaction remains in encrypted journal' });
  } catch (cause) { evidence.error = cause instanceof Error ? cause.message : String(cause); throw cause; }
  finally { await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify({ output, status: evidence.status })); }
});
