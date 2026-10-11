import { afterEach, expect, it, vi } from 'vitest';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';
import { createLoginItem } from '../core/model';
import { encryptVaultState, importVaultKey } from './vault-crypto';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture() {
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore();
  const vault = new SecureVaultService(storage, sessions);
  const item = createLoginItem({ title: 'Synthetic', password: 'synthetic', uris: ['https://example.com'] });
  await vault.setup('', [item]);
  return { storage, sessions, vault, item };
}

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
