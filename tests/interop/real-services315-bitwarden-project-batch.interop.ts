import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createLoginItem, type ProviderAccount } from '../../src/core/model';
import { groupedPasswords } from '../../src/core/password-groups';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { BitwardenProvider } from '../../src/providers/bitwarden/bitwarden-provider';
import { BitwardenDurableSyncCoordinator } from '../../src/providers/bitwarden/bitwarden-durable-sync';
import { deriveBitwardenMasterKey, deriveBitwardenMasterPasswordHash, stretchBitwardenMasterKey } from '../../src/providers/bitwarden/bitwarden-crypto';
import { SecureVaultService } from '../../src/security/secure-vault-service';
import { MemoryVaultStorage } from '../../src/security/vault-storage';
import { MemoryVaultSessionStore } from '../../src/security/vault-session';

const configPath = process.env.MONICA_315_REAL_SERVICES_CONFIG;
it.skipIf(!configPath)('keeps a two-password project together across the actual Vaultwarden 100-item batch boundary and restart', async () => {
  const config = JSON.parse(await readFile(resolve(configPath!), 'utf8'));
  expect(config.project).toBe('monica315-interop-20260930');
  const { baseUrl, password } = config.vaultwarden;
  expect(baseUrl).toBe('http://127.0.0.1:18316');
  await mkdir(resolve('.tmp/bw-project-batch-318'), { recursive: true });
  const output = await mkdtemp(join(resolve('.tmp/bw-project-batch-318'), 'run-'));
  const evidence: Record<string, unknown> = { status: 'failed', layer: 'Real Vaultwarden HTTP, encrypted vault restart and independent server readback', output };
  try {
    const client = new BitwardenClient(), email = `batch-${randomUUID()}@example.invalid`;
    const master = await deriveBitwardenMasterKey(password, email, { type: 0, iterations: 600000 });
    const key = { encKey: crypto.getRandomValues(new Uint8Array(32)), macKey: crypto.getRandomValues(new Uint8Array(32)) };
    try {
      const response = await fetch(`${baseUrl}/identity/accounts/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        email, name: 'Synthetic project batch acceptance', masterPasswordHash: await deriveBitwardenMasterPasswordHash(master, password),
        key: await client.protectVaultKey(key, await stretchBitwardenMasterKey(master), crypto.getRandomValues(new Uint8Array(16))), kdf: 0, kdfIterations: 600000
      }) }); expect(response.ok).toBe(true);
    } finally { master.fill(0); key.encKey.fill(0); key.macKey.fill(0); }
    const login = await client.login({ vaultUrl: baseUrl, email, masterPassword: password, deviceId: randomUUID() });
    if (login.status !== 'authenticated') throw new Error('Synthetic login failed');
    const account: ProviderAccount = { id: 'bw-project-batch', kind: 'bitwarden', name: 'Project batch acceptance', enabled: true, isDefaultSaveTarget: false, config: login.session };
    let now = Date.now();
    const storage = new MemoryVaultStorage(), vault = new SecureVaultService(storage, new MemoryVaultSessionStore(), () => now);
    const localPassword = 'Synthetic encrypted batch vault';
    await vault.setup(localPassword); await vault.upsertProvider(account);
    await vault.importItems(Array.from({ length: 99 }, (_, n) => createLoginItem({ title: 'Batch acceptance', username: `independent-${n}`,
      password: `synthetic-independent-${n}`, providerRefs: [{ providerId: account.id }] })));
    now += 1000;
    const projectId = randomUUID(), groupId = randomUUID();
    const project = [0, 1].map(n => ({ ...createLoginItem({ title: 'Batch acceptance', username: 'shared-project',
      password: `synthetic-project-${n}`, providerRefs: [{ providerId: account.id }] }), passwordGroupId: projectId,
      customFields: [{ name: 'monica.content.credential', protected: true, value: JSON.stringify({ version: 1, projectId, groupId,
        passwordId: randomUUID(), primary: true, groupOrder: 0, passwordOrder: n, label: 'Main' }).replace(/}$/, ',"future":9007199254740993}') }] }));
    await vault.savePasswordGroup(project, {});
    let creates = 0;
    const fetcher: typeof fetch = async (url, init) => {
      if (init?.method === 'POST' && String(url).endsWith('/api/ciphers')) creates++;
      return fetch(url, init);
    };
    await new BitwardenDurableSyncCoordinator(new BitwardenProvider(fetcher), vault).synchronize(account);
    expect(creates).toBe(99);
    const pending = (await vault.readState()).mutationQueue.map(row => row.itemId).sort();
    expect(pending).toEqual(project.map(row => row.id).sort());
    const firstRead = await new BitwardenProvider().sync(account, { now: new Date().toISOString(), localItems: [] });
    expect(firstRead.items).toHaveLength(99);
    expect(firstRead.items.every(row => row.kind === 'login' && !row.passwordGroupId)).toBe(true);
    await writeFile(join(output, 'pending-vault.encrypted.json'), JSON.stringify(storage.envelope));
    await vault.lock();
    const restored = new SecureVaultService(storage, new MemoryVaultSessionStore(), () => now); await restored.unlock(localPassword);
    await new BitwardenDurableSyncCoordinator(new BitwardenProvider(fetcher), restored).synchronize(account);
    expect(creates).toBe(101);
    expect((await restored.readState()).mutationQueue).toHaveLength(0);
    const independent = await client.login({ vaultUrl: baseUrl, email, masterPassword: password, deviceId: randomUUID() });
    if (independent.status !== 'authenticated') throw new Error('Independent authentication failed');
    const readback = await new BitwardenProvider().sync({ ...account, id: 'fresh-project-batch', config: independent.session }, { now: new Date().toISOString(), localItems: [] });
    const logins = readback.items.filter(row => row.kind === 'login');
    expect(logins).toHaveLength(101);
    const members = logins.filter(row => row.passwordGroupId === projectId);
    expect(members).toHaveLength(2);
    expect(groupedPasswords(logins).map(rows => rows.length).sort((a, b) => a - b)).toEqual([...Array(99).fill(1), 2]);
    for (const original of project) expect(members.find(row => row.password === original.password)?.customFields).toEqual(original.customFields);
    const ids = members.map(row => row.bitwardenCipherId); expect(new Set(ids).size).toBe(2);
    await writeFile(join(output, 'server-readback.json'), JSON.stringify(readback.items, null, 2));
    Object.assign(evidence, { status: 'passed', firstBatch: 99, deferredProjectMembers: 2, finalCreates: creates, finalRecords: 101,
      projectId, serverCipherIds: ids, preservedExactCredentialFields: true, queueEmpty: true, freshAuthentication: true });
  } catch (cause) { evidence.error = cause instanceof Error ? cause.message : String(cause); throw cause; }
  finally { await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify({ output, status: evidence.status })); }
});
