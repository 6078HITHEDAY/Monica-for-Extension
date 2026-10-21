import { describe, expect, it, vi } from 'vitest';
import { createLoginItem, type LoginItem, type VaultItem } from '../core/model';
import { validateVaultBatch, vaultSelectionMembers, type VaultBatchRequest } from '../core/vault-batch';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultSessionStore } from './vault-session';
import { MemoryVaultStorage } from './vault-storage';

function login(input: Partial<LoginItem> & { title: string }): LoginItem {
  return { ...createLoginItem(input), ...input };
}

async function fixture() {
  const storage = new MemoryVaultStorage();
  const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
  const items = [
    login({ id: 'first', title: 'Project', passwordGroupId: 'group', password: 'unchanged-secret', customFields: [{ name: 'future', value: 'raw-field', protected: true }], providerRefs: [{ providerId: 'bw', remoteId: 'remote-project' }] }),
    login({ id: 'second', title: 'Project', passwordGroupId: 'group', password: 'other-secret', providerRefs: [{ providerId: 'bw', remoteId: 'remote-project' }] }),
    { ...login({ id: 'note', title: 'Note' }), kind: 'secure-note', content: 'unchanged body' } as VaultItem,
    login({ id: 'unselected', title: 'Unselected' })
  ];
  await service.setup('synthetic batch password', items);
  await service.upsertProvider({ id: 'bw', kind: 'bitwarden', name: 'Synthetic remote', enabled: true, isDefaultSaveTarget: false, config: { apiUrl: 'https://example.test/api' } });
  return { service, storage };
}
async function requestFor(service: SecureVaultService, action: VaultBatchRequest['action'], anchorIds = ['first', 'note']): Promise<VaultBatchRequest> {
  const items = (await service.readState(false)).items;
  return { action, anchorIds, expected: Object.fromEntries(vaultSelectionMembers(anchorIds, items).map(item => [item.id, item.updatedAt])), ...(action === 'trash' ? { confirmed: true } : {}) };
}

describe('atomic multi-item actions', () => {
  it('updates complete projects in one write, preserving secrets and remote mutations', async () => {
    const { service, storage } = await fixture();
    const before = await service.readState(false);
    const write = vi.spyOn(storage, 'write');
    expect(await service.batchMutateItems(await requestFor(service, 'favorite'))).toEqual({ affected: 3 });
    expect(write).toHaveBeenCalledTimes(1);
    const after = await service.readState(false);
    for (const item of after.items) {
      const original = before.items.find(row => row.id === item.id)!;
      expect(item).toEqual(item.id === 'unselected' ? original : { ...original, favorite: true, updatedAt: item.updatedAt });
    }
    expect(after.mutationQueue.map(row => ({ itemId: row.itemId, operation: row.operation })).sort((a, b) => a.itemId.localeCompare(b.itemId)))
      .toEqual([{ itemId: 'first', operation: 'update' }, { itemId: 'second', operation: 'update' }]);
    expect(await service.batchMutateItems(await requestFor(service, 'unfavorite'))).toEqual({ affected: 3 });
  });

  it('moves only selected complete projects to trash and queues deletion for their source', async () => {
    const { service } = await fixture();
    const before = await service.readState(false);
    await service.batchMutateItems(await requestFor(service, 'trash'));
    const after = await service.readState(false);
    expect(after.items.filter(item => item.deletedAt).map(item => item.id).sort()).toEqual(['first', 'note', 'second']);
    expect(after.items.find(item => item.id === 'unselected')).toEqual(before.items.find(item => item.id === 'unselected'));
    expect(after.mutationQueue.filter(row => row.operation === 'delete').map(row => row.itemId).sort()).toEqual(['first', 'second']);
  });

  it('rejects stale member revisions before changing any selected item or queue', async () => {
    const { service, storage } = await fixture();
    const request = await requestFor(service, 'trash');
    const member = (await service.listItems()).find(item => item.id === 'second')!;
    await service.upsertItem({ ...member, notes: 'Newer note' });
    const before = await service.readState(false), encrypted = await storage.read();
    await expect(service.batchMutateItems(request)).rejects.toThrow('所选项目已变化');
    expect(await storage.read()).toEqual(encrypted);
    expect(await service.readState(false)).toEqual(before);
  });

  it('rejects a new hidden group member and an extra expected id', async () => {
    const { service } = await fixture();
    const stale = await requestFor(service, 'favorite');
    await service.upsertItem(login({ id: 'third', title: 'Project', passwordGroupId: 'group', providerRefs: [{ providerId: 'bw', remoteId: 'remote-project' }] }));
    await expect(service.batchMutateItems(stale)).rejects.toThrow('所选项目已变化');
    const extra = await requestFor(service, 'favorite'); extra.expected.unselected = 'unused';
    await expect(service.batchMutateItems(extra)).rejects.toThrow('所选项目已变化');
  });

  it('requires explicit trash confirmation, bounded ids, active anchors and supported actions', async () => {
    const { service } = await fixture();
    const request = await requestFor(service, 'trash');
    await expect(service.batchMutateItems({ ...request, confirmed: undefined })).rejects.toThrow('请先确认');
    for (const invalid of [{ anchorIds: [] }, { anchorIds: ['first', 'first'] }, { anchorIds: Array.from({ length: 201 }, (_, n) => `id${n}`) }, { action: 'purge' }]) {
      await expect(service.batchMutateItems({ ...request, ...invalid } as VaultBatchRequest)).rejects.toThrow('批量操作参数无效');
    }
    const items = (await service.readState(false)).items;
    const opaque = { ...items[0], kind: 'opaque' } as VaultItem;
    expect(() => validateVaultBatch({ ...request, anchorIds: [opaque.id] }, [opaque])).toThrow('所选项目已变化');
    await service.deleteItem('first');
    await expect(service.batchMutateItems(request)).rejects.toThrow('所选项目已变化');
  });

  it('keeps all items unchanged after encrypted storage failure and works after retry', async () => {
    const { service, storage } = await fixture();
    const request = await requestFor(service, 'trash');
    const before = await service.readState(false), encrypted = await storage.read();
    vi.spyOn(storage, 'write').mockRejectedValueOnce(new Error('Synthetic storage failure'));
    await expect(service.batchMutateItems(request)).rejects.toThrow('Synthetic storage failure');
    expect(await storage.read()).toEqual(encrypted);
    expect(await service.readState(false)).toEqual(before);
    expect(await service.batchMutateItems(request)).toEqual({ affected: 3 });
  });

  it('does not write no-op favorites or accept requests after locking', async () => {
    const { service, storage } = await fixture();
    const write = vi.spyOn(storage, 'write');
    expect(await service.batchMutateItems(await requestFor(service, 'unfavorite'))).toEqual({ affected: 0 });
    expect(write).not.toHaveBeenCalled();
    const request = await requestFor(service, 'favorite');
    await service.lock();
    await expect(service.batchMutateItems(request)).rejects.toThrow();
  });

  it('includes archived members but never crosses a provider or database scope', () => {
    const first = login({ id: 'first', title: 'Project', passwordGroupId: 'same', mdbxDatabaseId: 1, providerRefs: [{ providerId: 'p1' }] });
    const archived = { ...first, id: 'archived', archivedAt: first.updatedAt };
    const otherDb = { ...first, id: 'other-db', mdbxDatabaseId: 2 };
    const otherSource = { ...first, id: 'other-source', providerRefs: [{ providerId: 'p2' }] };
    const deleted = { ...first, id: 'deleted', deletedAt: first.updatedAt };
    const items = [first, archived, otherDb, otherSource, deleted];
    expect(vaultSelectionMembers(['first'], items).map(item => item.id).sort()).toEqual(['archived', 'first']);
    expect(() => vaultSelectionMembers(['archived'], items)).toThrow('所选项目已变化');
    expect(() => validateVaultBatch({ action: 'favorite', anchorIds: ['first'], expected: { first: first.updatedAt } }, items)).toThrow('所选项目已变化');
  });
});
