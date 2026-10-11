import { expect, it } from 'vitest';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';
import type { CardItem, IdentityItem, ProviderKind } from '../core/model';

it.each([
  ['bitwarden', 'card', false], ['bitwarden', 'identity', false], ['keepass', 'card', false],
  ['keepass', 'identity', true], ['mdbx2', 'card', true], ['monica-webdav', 'identity', true]
] as const)('%s/%s only queues portable layout, preserving content writes', async (providerKind, kind, portable) => {
  const vault = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
  const base = { id: 'wallet', title: 'Synthetic', notes: '', favorite: false, createdAt: '2026-10-01', updatedAt: '2026-10-01',
    providerRefs: [{ providerId: 'remote', remoteId: 'remote-item', etag: 'etag' }] };
  const item: CardItem | IdentityItem = kind === 'card' ? { ...base, kind, cardholderName: 'Holder', number: '4111111111111111', expiryMonth: '12', expiryYear: '2030', securityCode: '123' }
    : { ...base, kind, documentType: 'PASSPORT', documentNumber: 'Synthetic', firstName: 'A', middleName: '', lastName: 'B', fullName: 'A B' };
  await vault.setup('', [item]);
  await vault.upsertProvider({ id: 'remote', kind: providerKind as ProviderKind, name: 'Synthetic', enabled: true, isDefaultSaveTarget: false, config: {} });
  const saved = await vault.upsertItem({ ...item, editorSectionOrder: ['notes', 'custom'] });
  expect((await vault.readState()).mutationQueue).toHaveLength(portable ? 1 : 0);
  expect(saved).toMatchObject({ editorSectionOrder: ['notes', 'custom'] });
  const changed = await vault.upsertItem({ ...saved, notes: 'Changed content' });
  if (changed.kind !== 'card' && changed.kind !== 'identity') throw new Error('Expected wallet');
  const queue = (await vault.readState()).mutationQueue;
  expect(queue).toHaveLength(1);
  await vault.upsertItem({ ...changed, editorSectionOrder: ['custom', 'notes'] });
  expect((await vault.readState()).mutationQueue[0].id).toBe(queue[0].id);
  await vault.lock();
});
