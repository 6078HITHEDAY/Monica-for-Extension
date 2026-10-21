import { afterEach, expect, it, vi } from 'vitest';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';
import { createLoginItem, type TotpItem } from '../core/model';
import { encryptVaultState, importVaultKey } from './vault-crypto';
import { resolveLoginOtp } from '../core/login-otp';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture() {
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore();
  const vault = new SecureVaultService(storage, sessions);
  const item = createLoginItem({ title: 'Synthetic', password: 'synthetic', uris: ['https://example.com'] });
  await vault.setup('', [item]);
  return { storage, sessions, vault, item };
}

function createTotpItem(): TotpItem {
  const now = new Date().toISOString();
  return { id: 'bound-otp', kind: 'totp', title: 'Bound OTP', secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA1', digits: 6, period: 30, favorite: false, notes: '', providerRefs: [], createdAt: now, updatedAt: now };
}

it('prepares only the chosen login and its bound OTP without copying unrelated vault records', async () => {
  const { vault, item } = await fixture();
  const otp = createTotpItem();
  const selected = { ...item, boundTotpItemId: otp.id };
  const unrelated = createLoginItem({ title: 'Unrelated', password: 'unrelated-secret' });
  await vault.importItems([selected, otp, unrelated]);
  const context = await vault.readAutofillContext(item.id);
  expect(context.items.map(row => row.id)).toEqual([item.id, otp.id]);
  expect(context.credentialIdentities).toEqual({});
  const login = context.items[0] as typeof item;
  expect(await resolveLoginOtp(login, context.items, 0)).toEqual(await resolveLoginOtp(selected, [otp], 0));
  login.password = 'caller edit';
  expect(await vault.getItem(item.id)).toMatchObject({ password: 'synthetic' });
  expect((await vault.readAutofillContext('missing')).items).toEqual([]);
  expect((await vault.readAutofillContext()).items).toHaveLength(3);
  await vault.lock();
});

it('keeps legacy Android OTP binding and excludes archived or deleted sources in a selected fill', async () => {
  const { vault, item } = await fixture();
  const providerId = (await vault.listProviders()).find(provider => provider.kind === 'local')!.id;
  const selected = { ...item, providerRefs: [{ providerId, remoteId: '/password_42_0.json' }] };
  const otp = { ...createTotpItem(), boundPasswordId: 42, providerRefs: [{ providerId }] };
  await vault.importItems([selected, otp]);
  expect((await vault.readAutofillContext(item.id)).items.map(row => row.id)).toEqual([item.id, otp.id]);
  await vault.upsertItem({ ...otp, archivedAt: new Date().toISOString() });
  expect((await vault.readAutofillContext(item.id)).items.map(row => row.id)).toEqual([item.id]);
  await vault.deleteItem(item.id);
  expect((await vault.readAutofillContext(item.id)).items).toEqual([]);
  await vault.lock();
});

it('rejects a selected fill if encrypted bytes change with an unchanged timestamp', async () => {
  const { vault, storage, item } = await fixture();
  const context = await vault.readAutofillContext(item.id);
  // Mutate the storage object itself, as another writer/test storage may do.
  storage.envelope!.ciphertext = 'AAAA';
  const send = vi.fn(async () => true);
  await expect(vault.dispatchAutofill(context, send)).rejects.toThrow('填写权限');
  expect(send).not.toHaveBeenCalled();
  await vault.lock();
});

it.each(['iv', 'cipher', 'version', 'updatedAt', 'kdf'] as const)('rejects a selected fill after its encrypted envelope %s changes', async field => {
  const { vault, storage, item } = await fixture();
  const context = await vault.readAutofillContext(item.id);
  const changed = storage.envelope! as unknown as Record<string, unknown>;
  if (field === 'kdf') storage.envelope!.kdf = { ...storage.envelope!.kdf, name: 'DEVICE-KEY', keyId: 'replaced' };
  else changed[field] = 'changed';
  const send = vi.fn(async () => true);
  await expect(vault.dispatchAutofill(context, send)).rejects.toThrow('填写权限');
  expect(send).not.toHaveBeenCalled();
  await vault.lock();
});

it('decodes once across the read chain used by matching and Passkey prompts', async () => {
  const { vault } = await fixture();
  const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
  await vault.readState(); await vault.listItems(); await vault.getAutofillSitePolicy(); await vault.readAutofillContext();
  await vault.getProvider('local'); await vault.readPasswordProjectRemovals(); await vault.readMdbx2Restores(); await vault.readMdbx2RestoreBatches();
  expect(decrypt).toHaveBeenCalledTimes(1);
  await vault.lock();
});

it('isolates callers and failed edits from the retained snapshot', async () => {
  const { vault, storage, item } = await fixture();
  const state = await vault.readState();
  (state.items[0] as typeof item).password = 'tampered';
  (state.items[0] as typeof item).customFields!.push({ name: 'tampered', value: 'x', type: 'text', protected: false });
  expect(await vault.getItem(item.id)).toMatchObject({ password: 'synthetic', customFields: [] });
  vi.spyOn(storage, 'write').mockRejectedValueOnce(new Error('disk full'));
  await expect(vault.upsertItem({ ...item, password: 'uncommitted' })).rejects.toThrow('disk full');
  expect(await vault.getItem(item.id)).toMatchObject({ password: 'synthetic' });
  await vault.upsertItem({ ...item, password: 'committed' });
  expect(await vault.getItem(item.id)).toMatchObject({ password: 'committed' });
  await vault.lock();
});

it('does not reuse a snapshot across altered ciphertext or a changed session key', async () => {
  const { vault, storage, sessions } = await fixture();
  await vault.readState();
  const original = structuredClone(storage.envelope!);
  storage.envelope!.ciphertext = 'AAAA';
  await expect(vault.readState()).rejects.toThrow();
  storage.envelope = original;
  await vault.readState();
  sessions.session!.rawKey = Buffer.alloc(32, 17).toString('base64');
  await expect(vault.readState()).rejects.toThrow();
  await vault.lock();
});

it('drops retained plaintext at expiry and never uses it after lock', async () => {
  const { vault, sessions } = await fixture();
  vi.useFakeTimers();
  sessions.session!.expiresAt = Date.now() + 100;
  await vault.readState();
  expect((vault as unknown as { decodedSnapshot?: unknown }).decodedSnapshot).toBeDefined();
  await vi.advanceTimersByTimeAsync(101);
  expect((vault as unknown as { decodedSnapshot?: unknown }).decodedSnapshot).toBeUndefined();
  await expect(vault.readState()).rejects.toThrow('locked');
  await vault.lock();
});

it('refreshes an externally replaced envelope even when its timestamp is unchanged', async () => {
  const { vault, storage, sessions, item } = await fixture();
  const replacement = await vault.readState();
  (replacement.items[0] as typeof item).password = 'remote edit';
  const key = await importVaultKey(sessions.session!.rawKey);
  await storage.write(await encryptVaultState(replacement, key, storage.envelope!.kdf));
  expect(await vault.getItem(item.id)).toMatchObject({ password: 'remote edit' });
  await vault.lock();
});

it('never carries plaintext into a different unlock session with the same key', async () => {
  const { vault, sessions } = await fixture();
  await vault.readState();
  const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
  sessions.session!.id = crypto.randomUUID();
  await vault.listItems();
  expect(decrypt).toHaveBeenCalledTimes(1);
  await vault.lock();
  expect((vault as unknown as { decodedSnapshot?: unknown }).decodedSnapshot).toBeUndefined();
});

it('does not repopulate a cache invalidated during decryption', async () => {
  const { vault } = await fixture();
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(crypto.subtle, 'decrypt').mockImplementationOnce(async (...args) => {
    started(); await gate; return decrypt(...args);
  });
  const reading = vault.listItems();
  await entered;
  vault.clearDecryptedState();
  const rejected = expect(reading).rejects.toThrow('locked');
  release(); await rejected;
  expect((vault as unknown as { decodedSnapshot?: unknown }).decodedSnapshot).toBeUndefined();
  await vault.lock();
});
