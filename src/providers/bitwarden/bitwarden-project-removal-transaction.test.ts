import { describe, expect, it, vi } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderAccount } from '../../core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../../core/project-credentials';
import { readPasswordProjectRemovalJournal } from '../../core/password-project-removal-journal';
import { assertPasswordProjectRemovalSyncSafe } from '../../core/password-project-removal-sync';
import { SecureVaultService } from '../../security/secure-vault-service';
import { MemoryVaultStorage } from '../../security/vault-storage';
import { MemoryVaultSessionStore } from '../../security/vault-session';
import { BitwardenProjectRemovalConflict, BitwardenProjectRemovalTransaction, bitwardenProjectRemovalStore,
  bitwardenRemovalSnapshotSha256, type BitwardenProjectRemovalRemote } from './bitwarden-project-removal-transaction';

const password = 'Synthetic project transaction master';
const revision = '2026-10-09T00:00:00.000Z';
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

async function fixture() {
  const storage = new MemoryVaultStorage();
  let vault = new SecureVaultService(storage, new MemoryVaultSessionStore());
  const account: ProviderAccount = { id: 'bitwarden', kind: 'bitwarden', name: 'Synthetic BW', enabled: true, isDefaultSaveTarget: false,
    config: { vaultUrl: 'https://test.invalid', apiUrl: 'https://test.invalid/api', identityUrl: 'https://test.invalid/identity', email: 'test@example.invalid' } };
  const rows: LoginItem[] = [0, 1, 2].map(index => ({ ...createLoginItem({ title: 'Project', password: `secret-${index}` }),
    passwordGroupId: uuid(9), createdAt: revision, updatedAt: revision,
    providerRefs: [{ providerId: account.id, remoteId: uuid(index + 10), revision }],
    customFields: [{ name: PROJECT_CREDENTIAL_FIELD, protected: true, value: JSON.stringify({ version: 1, projectId: uuid(9),
      groupId: uuid(4), passwordId: uuid(index + 50), primary: true, label: 'Primary', groupOrder: 0, passwordOrder: index }) }]
  }));
  rows[0].customFields.push({ name: 'Shared', value: 'protected original shared content', protected: true });
  await vault.setup(password, rows); await vault.upsertProvider(account);
  const original = await vault.listItems() as LoginItem[];
  const operationId = crypto.randomUUID();
  await vault.stagePasswordProjectRemoval({ operationId, items: original, expected: Object.fromEntries(original.map(row => [row.id, row.updatedAt])),
    removedItemIds: [rows[0].id, rows[1].id] });
  const state = await vault.readState();
  const synced = state.items.map(row => ({ ...row, updatedAt: revision, providerRefs: row.providerRefs.map(ref => ({ ...ref, revision })) }));
  await vault.applyProviderSync(account.id, synced, undefined, [], [], state.items);
  const observed = await vault.inspectPasswordProjectRemoval(operationId);
  const ciphers = new Map<string, Record<string, unknown>>(observed.items.map(row => {
    const cipherId = row.providerRefs[0].remoteId!;
    return [cipherId, { Id: cipherId, Type: 1, Name: 'encrypted-title', RevisionDate: revision, CreationDate: revision,
      Login: { Password: `encrypted-${row.password}`, Fido2Credentials: [] }, Fields: [{ Name: 'future', Value: 'encrypted-future' }] }];
  }));
  const members = await Promise.all(observed.record.removed.map(async row => ({ itemId: row.id, cipherId: row.providerRefs[0].remoteId!,
    snapshotSha256: await bitwardenRemovalSnapshotSha256(ciphers.get(row.providerRefs[0].remoteId!)!), stage: 'ready' as const })));
  const record = await vault.finalizePasswordProjectRemoval(operationId, observed.items,
    [{ providerId: account.id, ...observed.record.ownerTransfer!, attachments: [] }], undefined,
    { version: 1, revision: 1, phase: 'deleting', members, retainedSnapshots: await Promise.all(observed.record.retained.map(async row => ({
      itemId: row.id, cipherId: row.providerRefs[0].remoteId!, snapshotSha256: await bitwardenRemovalSnapshotSha256(ciphers.get(row.providerRefs[0].remoteId!)!) }))) });
  const deletes: string[] = [], restores: string[] = [];
  const targetId = observed.record.retained[0].providerRefs[0].remoteId!;
  const targetHash = await bitwardenRemovalSnapshotSha256(ciphers.get(targetId)!);
  const remote: BitwardenProjectRemovalRemote = {
    readCipher: async id => structuredClone(ciphers.get(id) || null),
    deleteCipher: async id => { deletes.push(id); ciphers.get(id)!.DeletedDate = revision; ciphers.get(id)!.RevisionDate = '2026-10-09T00:01:00.000Z'; },
    restoreCipher: async id => { restores.push(id); ciphers.get(id)!.DeletedDate = null; ciphers.get(id)!.RevisionDate = '2026-10-09T00:02:00.000Z'; },
    verifyRetained: async () => { if (await bitwardenRemovalSnapshotSha256(ciphers.get(targetId)!) !== targetHash) throw new BitwardenProjectRemovalConflict('retained-changed'); }
  };
  return { storage, account, rows, operationId, record, ciphers, remote, deletes, restores, targetId,
    get vault() { return vault; }, get store() { return bitwardenProjectRemovalStore(vault); },
    restart: async () => { await vault.lock(); vault = new SecureVaultService(storage, new MemoryVaultSessionStore()); await vault.unlock(password); },
    run: () => new BitwardenProjectRemovalTransaction(bitwardenProjectRemovalStore(vault), remote).resume(operationId)
  };
}

describe('Bitwarden dedicated project-removal transaction', () => {
  it('commits two deletes with encrypted restart receipts while ordinary sync and generic completion remain gated', async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result.bitwardenDeletion).toMatchObject({ phase: 'committed', members: [{ stage: 'deleted' }, { stage: 'deleted' }] });
    expect(f.deletes).toHaveLength(2); expect(f.restores).toHaveLength(0);
    expect(JSON.stringify(f.storage.envelope)).not.toContain('protected original shared content');
    await f.restart();
    expect((await f.run()).bitwardenDeletion).toEqual(result.bitwardenDeletion);
    expect(f.deletes).toHaveLength(2);
    const state = await f.vault.readState();
    expect(() => assertPasswordProjectRemovalSyncSafe(f.account, { now: revision, localItems: state.items,
      pendingMutations: state.mutationQueue, passwordProjectRemovals: state.passwordProjectRemovals })).toThrow('普通同步不能执行');
    await expect(f.vault.completePasswordProjectRemoval(f.operationId)).rejects.toThrow('对应协调器');
  });

  it.each(['intent-save', 'delete-response', 'receipt-save'])('resumes %s failure without duplicating committed deletes', async failure => {
    const f = await fixture();
    const store = f.store;
    let inject = true;
    if (failure === 'intent-save') vi.spyOn(f.storage, 'write').mockRejectedValueOnce(new Error('Synthetic intent failure'));
    if (failure === 'delete-response') {
      const remove = f.remote.deleteCipher;
      f.remote.deleteCipher = async id => { await remove(id); if (inject) { inject = false; throw new Error('Synthetic lost deletion response'); } };
    }
    if (failure === 'receipt-save') {
      const update = store.update;
      store.update = async (id, revision, next) => {
        if (inject && next.members.some(row => row.stage === 'deleted')) { inject = false; throw new Error('Synthetic receipt save failure'); }
        return update(id, revision, next);
      };
    }
    await expect(new BitwardenProjectRemovalTransaction(store, f.remote).resume(f.operationId)).rejects.toThrow('Synthetic');
    expect(f.deletes).toHaveLength(failure === 'intent-save' ? 0 : 1);
    await f.restart();
    expect((await f.run()).bitwardenDeletion!.phase).toBe('committed');
    expect(f.deletes).toHaveLength(2); expect(new Set(f.deletes).size).toBe(2);
  });

  it.each(['source', 'target', 'future-type'])('restores every touched source on %s changes without replacing its latest bytes', async change => {
    const f = await fixture(), remove = f.remote.deleteCipher;
    const secondId = f.record.bitwardenDeletion!.members[1].cipherId;
    f.remote.deleteCipher = async id => {
      await remove(id);
      if (id === secondId) {
        if (change === 'target') f.ciphers.get(f.targetId)!.Fields = [];
        else if (change === 'future-type') f.ciphers.get(id)!.Type = 999;
        else f.ciphers.get(id)!.Login = { Password: 'latest-concurrent-encrypted-password', Fido2Credentials: [] };
      }
    };
    const result = await f.run();
    expect(result.bitwardenDeletion!.phase).toBe('restored');
    expect(f.deletes).toHaveLength(2); expect(f.restores).toHaveLength(2);
    for (const id of f.deletes) expect(f.ciphers.get(id)!.DeletedDate).toBeNull();
    if (change === 'source') expect(f.ciphers.get(secondId)!.Login).toMatchObject({ Password: 'latest-concurrent-encrypted-password' });
    if (change === 'future-type') expect(f.ciphers.get(secondId)!.Type).toBe(999);
    await f.restart(); await f.run(); expect(f.restores).toHaveLength(2);
  });

  it('recovers a lost compensation response after restart, without replaying restoration', async () => {
    const f = await fixture(), remove = f.remote.deleteCipher, restore = f.remote.restoreCipher;
    f.remote.deleteCipher = async id => { await remove(id); f.ciphers.get(f.targetId)!.Fields = []; };
    let lost = true;
    f.remote.restoreCipher = async id => { await restore(id); if (lost) { lost = false; throw new Error('Synthetic lost restore response'); } };
    await expect(f.run()).rejects.toThrow('lost restore response');
    expect((await f.store.read(f.operationId)).bitwardenDeletion).toMatchObject({ phase: 'restoring' });
    await f.restart();
    expect((await f.run()).bitwardenDeletion!.phase).toBe('restored');
    expect(new Set(f.restores).size).toBe(f.restores.length);
  });

  it('does not re-delete an externally restored source after losing the delete response', async () => {
    const f = await fixture(), remove = f.remote.deleteCipher;
    f.remote.deleteCipher = async id => { await remove(id); f.ciphers.get(id)!.DeletedDate = null; throw new Error('Synthetic response lost'); };
    await expect(f.run()).rejects.toThrow('Synthetic'); await f.restart();
    const result = await f.run();
    expect(result.bitwardenDeletion).toMatchObject({ phase: 'restored', reason: 'source-live' });
    expect(f.deletes).toHaveLength(1); expect(f.restores).toHaveLength(0);
  });

  it('does not resurrect again when the result of restoration remains unknown and the source is trashed', async () => {
    const f = await fixture(), remove = f.remote.deleteCipher;
    f.remote.deleteCipher = async id => { await remove(id); f.ciphers.get(f.targetId)!.Fields = []; };
    f.remote.restoreCipher = async () => { throw new Error('Synthetic restore transport failure'); };
    await expect(f.run()).rejects.toThrow('Synthetic restore'); await f.restart();
    await expect(f.run()).rejects.toThrow('停止重复恢复');
    expect((await f.store.read(f.operationId)).bitwardenDeletion!.phase).toBe('restoring');
  });

  it('stops on missing source and retains the exact pending receipt', async () => {
    const f = await fixture(), remove = f.remote.deleteCipher;
    f.remote.deleteCipher = async id => { await remove(id); f.ciphers.delete(id); };
    await expect(f.run()).rejects.toThrow('不存在或不可访问');
    expect((await f.store.read(f.operationId)).bitwardenDeletion!.members[0].stage).toBe('delete-attempted');
    expect(f.restores).toHaveLength(0);
  });

  it('rejects source rebinding before the first remote delete', async () => {
    const f = await fixture();
    f.remote.verifyRetained = async () => { await f.vault.upsertProvider({ ...f.account, config: { ...f.account.config, vaultUrl: 'https://other.invalid', apiUrl: 'https://other.invalid/api' } }); };
    await expect(f.run()).rejects.toThrow(); expect(f.deletes).toHaveLength(0);
  });

  it('rejects stale progress, changed source baselines and damaged/future journals without writes', async () => {
    const f = await fixture(), initial = f.record.bitwardenDeletion!;
    const attempted = { ...initial, revision: 2, members: initial.members.map((row, index) => index ? row : { ...row, stage: 'delete-attempted' as const }) };
    await f.store.update(f.operationId, 1, attempted);
    const encrypted = JSON.stringify(f.storage.envelope);
    await expect(f.store.update(f.operationId, 1, attempted)).rejects.toThrow('进度已变化');
    await expect(f.store.update(f.operationId, 2, { ...attempted, revision: 3, members: attempted.members.map(row => ({ ...row, snapshotSha256: 'b'.repeat(64) })) })).rejects.toThrow();
    await expect(f.store.update(f.operationId, 2, { ...attempted, revision: 3, members: attempted.members.map((row, index) => index ? row : { ...row, stage: 'deleted' }),
      retainedSnapshots: attempted.retainedSnapshots!.map(row => ({ ...row, snapshotSha256: 'b'.repeat(64) })) })).rejects.toThrow();
    expect(JSON.stringify(f.storage.envelope)).toBe(encrypted);
    for (const patch of [{ version: 2 }, { phase: 'committed' }, { revision: 0 }, { members: [] },
      { members: [initial.members[0], initial.members[0]] }]) {
      expect(() => readPasswordProjectRemovalJournal([{ ...f.record, bitwardenDeletion: { ...initial, ...patch } }])).toThrow();
    }
  });

  it('ignores only native trash timestamps and signed attachment URLs when hashing', async () => {
    const raw = { Id: uuid(10), Type: 1, Name: 'secret', RevisionDate: revision, DeletedDate: null,
      Attachments: [{ Id: 'attachment', Url: 'https://download.invalid/old', Key: 'wrapped', FileName: 'encrypted-name', Size: '100' }], Future: { exact: '9007199254740993' } };
    const changed = { ...raw, RevisionDate: '2026-10-09T00:02:00Z', DeletedDate: revision,
      Attachments: [{ ...raw.Attachments[0], Url: 'https://download.invalid/new' }] };
    expect(await bitwardenRemovalSnapshotSha256(changed)).toBe(await bitwardenRemovalSnapshotSha256(raw));
    expect(await bitwardenRemovalSnapshotSha256({ ...changed, Future: {} })).not.toBe(await bitwardenRemovalSnapshotSha256(raw));
    expect(await bitwardenRemovalSnapshotSha256({ ...changed, Attachments: [] })).not.toBe(await bitwardenRemovalSnapshotSha256(raw));
  });

  it('distinguishes a lossless future integer from an ordinary object using the rawJSON key', async () => {
    const { parseLosslessJson } = await import('../../core/lossless-json');
    const raw = parseLosslessJson(`{"id":"${uuid(10)}","type":1,"revisionDate":"${revision}","future":9007199254740993}`) as Record<string, unknown>;
    expect(await bitwardenRemovalSnapshotSha256(raw)).not.toBe(await bitwardenRemovalSnapshotSha256({ ...raw, future: { rawJSON: '9007199254740993' } }));
  });
});
