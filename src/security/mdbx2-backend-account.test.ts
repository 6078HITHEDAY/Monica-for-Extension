import { expect, it, vi } from 'vitest';
import type { ProviderAccount } from '../core/model';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';

it('persists browser ownership encrypted, projects no credentials and keeps cached routing free of I/O', async () => {
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore();
  const service = new SecureVaultService(storage, sessions);
  await service.setup('synthetic-account-password', []);
  const account: ProviderAccount = { id: 'synthetic-mdbx', kind: 'mdbx2', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false,
    config: { runtimeBackend: 'browser', vaultHandle: 'synthetic-vault', syncStateHandle: 'synthetic-state', webDavPassword: 'synthetic-cloud-secret' } };
  const saved = await service.upsertProvider(account);
  expect(saved.config.runtimeBackend).toBe('browser'); expect(saved.config.webDavPassword).toBeUndefined();
  await service.getProvider(account.id);
  const read = vi.spyOn(storage, 'read'); read.mockRejectedValue(Error('must not read during routing'));
  expect(service.cachedMdbx2HandleBackend('synthetic-vault', 'vault')).toBe('browser');
  expect(service.cachedMdbx2HandleBackend('synthetic-state', 'state')).toBe('browser'); expect(read).not.toHaveBeenCalled(); read.mockRestore();
  await expect(service.upsertProvider({ ...account, config: { ...account.config, runtimeBackend: 'native' } })).rejects.toThrow('不能切换');
  expect((await service.getProvider(account.id))?.config.runtimeBackend).toBe('browser');
  await service.lock(); expect(service.cachedMdbx2HandleBackend('synthetic-vault', 'vault')).toBeUndefined();
  const fresh = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await fresh.unlock('synthetic-account-password'); await fresh.getProvider(account.id);
  expect(fresh.cachedMdbx2HandleBackend('synthetic-vault', 'vault')).toBe('browser'); await fresh.lock();
});
