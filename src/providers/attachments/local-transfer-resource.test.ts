import { describe, expect, it, vi } from 'vitest';
import { createEmptyVaultState, createLoginItem, type ProviderAccount } from '../../core/model';
import { readLocalTransferResource } from './local-transfer-resource';
import { Mdbx2TransferAttachmentService } from '../mdbx2/mdbx2-transfer-attachments';
import { KeePassProvider } from '../keepass/keepass-provider';
import { buildKeePassFixture } from '../keepass/keepass-fixture';
import { base64ToBytes } from '../../security/encoding';

describe('authenticated local transfer resources', () => {
  it('reads an actual encrypted KDBX with exact filenames, binary content and folder identity', async () => {
    const provider = new KeePassProvider();
    const account: ProviderAccount = { id: 'kp', name: 'Synthetic', kind: 'keepass', enabled: true, isDefaultSaveTarget: false, config: { databaseId: 7 } };
    const body = new Uint8Array([0, 255, 12, 1]), bytes = await buildKeePassFixture({ password: 'synthetic', entries: [{
      title: 'Source', group: 'Games', protectedFields: { Password: 'synthetic-secret' }, binaries: { 'Steam 原文件.maFile': body }
    }] });
    try {
      await provider.unlock(account, bytes, { password: 'synthetic' });
      const synced = await provider.sync(account, { now: '2026-10-11T00:00:00Z', localItems: [] });
      const item = synced.items[0], before = structuredClone(item), state = createEmptyVaultState();
      state.providers.push(account); state.items = synced.items;
      const files = new Mdbx2TransferAttachmentService({} as never, provider);
      const resource = await readLocalTransferResource(state, item, { files, prepare: async () => undefined });
      expect(resource.folder?.label).toContain('Games'); expect(resource.folder?.identity).toBe(item.keepassGroupUuid);
      expect(resource.attachments).toHaveLength(1);
      expect(resource.attachments[0].fileName).toBe('Steam 原文件.maFile');
      expect(base64ToBytes(resource.attachments[0].dataBase64)).toEqual(body);
      expect(resource.attachments[0].sizeBytes).toBe(body.length); expect(item).toEqual(before);
      expect(await files.readSourceAttachment(account, item, resource.attachments[0])).toEqual(body);
    } finally { provider.lock(); }
  });

  function fixture() {
    const state = createEmptyVaultState(), account: ProviderAccount = { id: 'bw', kind: 'bitwarden', enabled: true, name: 'Synthetic', config: {}, isDefaultSaveTarget: false };
    const item = { ...createLoginItem({ title: 'Source' }), providerRefs: [{ providerId: account.id, remoteId: 'cipher' }] };
    state.providers.push(account); state.items.push(item);
    const catalog = [{ attachmentId: 'remote-file', fileName: 'original.bin', sizeBytes: 0 }], body = new Uint8Array([0, 1, 255]);
    const files = { listSourceAttachments: vi.fn().mockResolvedValue(catalog), readSourceAttachment: vi.fn().mockResolvedValue(body) };
    return { state, item, account, catalog, body, dependencies: { files, prepare: vi.fn().mockResolvedValue(undefined) } };
  }
  it('uses authenticated plaintext size and clears the returned buffer after capture', async () => {
    const { state, item, body, dependencies } = fixture();
    const resource = await readLocalTransferResource(state, item, dependencies);
    expect(resource.attachments[0].sizeBytes).toBe(3); expect(base64ToBytes(resource.attachments[0].dataBase64)).toEqual(new Uint8Array([0, 1, 255]));
    expect(body).toEqual(new Uint8Array(3)); expect(resource.folder).toEqual({ identity: '', label: '' });
  });
  it('does not accept a changed or duplicate attachment catalog', async () => {
    const { state, item, catalog, dependencies } = fixture();
    dependencies.files.listSourceAttachments.mockResolvedValueOnce(catalog).mockResolvedValueOnce([]);
    await expect(readLocalTransferResource(state, item, dependencies)).rejects.toThrow('已变化');
    dependencies.files.listSourceAttachments.mockResolvedValue([...catalog, ...catalog]);
    await expect(readLocalTransferResource(state, item, dependencies)).rejects.toThrow('重复');
  });
  it('distinguishes unresolved folder from root and rejects disabled/multiple owners', async () => {
    const { state, item, account, dependencies } = fixture();
    expect((await readLocalTransferResource(state, { ...item, categoryId: 12 }, dependencies)).folder).toBeUndefined();
    account.enabled = false;
    await expect(readLocalTransferResource(state, item, dependencies)).rejects.toThrow('不可用');
    account.enabled = true;
    await expect(readLocalTransferResource(state, { ...item, providerRefs: [...item.providerRefs, ...item.providerRefs] }, dependencies)).rejects.toThrow('绑定不唯一');
  });
  it('clears oversized plaintext and propagates authentication failure without output', async () => {
    const { state, item, dependencies } = fixture(), oversized = new Uint8Array(16 * 1024 * 1024 + 1).fill(7);
    dependencies.files.readSourceAttachment.mockResolvedValue(oversized);
    await expect(readLocalTransferResource(state, item, dependencies)).rejects.toThrow('16 MiB'); expect(oversized.every(byte => byte === 0)).toBe(true);
    dependencies.files.readSourceAttachment.mockRejectedValue(new Error('authentication failed'));
    await expect(readLocalTransferResource(state, item, dependencies)).rejects.toThrow('authentication failed');
  });
});
