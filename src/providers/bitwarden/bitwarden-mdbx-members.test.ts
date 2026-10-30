import { expect, it, vi } from 'vitest';
import { createEmptyVaultState, createLoginItem, type ProviderAccount, type PasskeyItem } from '../../core/model';
import { MdbxBitwardenMembers } from './bitwarden-mdbx-members';
import type { Mdbx2CollectionSummary, Mdbx2ObjectRecord, Mdbx2ObjectSummary, Mdbx2ObjectSummaryPage } from '../mdbx2/native-contract';
import { encodeMdbx2Object } from '../mdbx2/mdbx2-item-codec';
import { ssoLogicalId } from '../../core/sso-links';

function moveFixture() {
  const f = fixture();
  for (const [index, item] of f.items.entries()) {
    item.password = 'Synthetic password sentinel';
    item.replicaGroupId = `password:synthetic-${index}`;
    const encoded = encodeMdbx2Object(item)!;
    f.records[index].payloadJson = encoded.payloadJson;
  }
  return { ...f, move: () => f.members.verifyMove(f.state, f.account, f.items, f.client, f.collections, f.revision) };
}

it('loads move links lazily, then reuses only sanitized routing metadata', async () => {
  const f = moveFixture(); await f.verify(); await f.move(); await f.move();
  expect(f.client.revealObject).toHaveBeenCalledTimes(4);
  // A vault-sized decrypted password cache would make unrelated secrets linger.
  const cache = (f.members as unknown as { snapshots: WeakMap<object, Map<string, unknown>> }).snapshots.get(f.state);
  expect(JSON.stringify([...cache!.values()])).not.toContain('Synthetic password sentinel');
});

it.each(['member','incoming-sso','unknown','legacy'] as const)('blocks an unindexed native %s before moving', async mode => {
  const f = moveFixture();
  const payload = mode === 'unknown' ? { monica_password_encoding: 'future' }
    : mode === 'legacy' ? { sso_ref_entry_id: 123 }
      : mode === 'incoming-sso' ? { sso_ref_logical_id: ssoLogicalId(f.items[0]) }
        : { password_group_id: f.items[0].passwordGroupId };
  f.records.push({ ...f.records[0], objectId: 'unindexed', payloadJson: JSON.stringify({ monica_entry_id: 'password:unindexed', ...payload }) });
  await expect(f.move()).rejects.toThrow();
});

it('invalidates move catalogs on revision changes and refuses changes during scanning', async () => {
  const f = moveFixture(); await f.move(); f.revision.revisionSha256 = 'updated';
  f.client.readWriteRevision.mockResolvedValueOnce({ ...f.revision, revisionSha256: 'racing' });
  await expect(f.move()).rejects.toThrow('成员或版本');
  await f.move(); expect(f.client.revealObject).toHaveBeenCalledTimes(6);
});

it.each(['[{"credentialId":"dXNlcg"}]','[{}]','{broken'])('preserves a Passkey with an unindexed matching or ambiguous binding: %s', async bindings => {
  const f = moveFixture();
  f.records.push({ ...f.records[0], objectId: 'unindexed-owner', payloadJson: JSON.stringify({ monica_entry_id: 'password:owner', passkey_bindings: bindings }) });
  const passkey = { id: 'key', kind: 'passkey', credentialId: 'dXNlcg', providerRefs: [{ providerId: f.account.id, remoteId: 'key-native' }] } as PasskeyItem;
  await expect(f.members.verifyMove(f.state, f.account, [...f.items,passkey], f.client, f.collections, f.revision)).rejects.toThrow('关联');
});

function fixture() {
  const account: ProviderAccount = { id: 'source', kind: 'mdbx2', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false,
    config: { vaultHandle: 'handle' } };
  const state = createEmptyVaultState(), revision = { vaultId: 'vault', revisionSha256: 'revision' };
  const items = [0, 1].map(i => ({ ...createLoginItem({ title: 'Synthetic' }), id: `item-${i}`, passwordGroupId: 'group',
    providerRefs: [{ providerId: account.id, remoteId: `remote-${i}`, remoteFolderId: `folder-${i}`, revision: `head-${i}` }] }));
  state.items = items; state.providers = [account];
  const collections: Mdbx2CollectionSummary[] = [0, 1].map(i => ({ collectionId: `folder-${i}`, title: 'Synthetic', favorite: false,
    archived: false, deleted: false, attachmentCount: 0, headCommitId: 'folder-head', updatedAt: state.updatedAt }));
  const records: Mdbx2ObjectRecord[] = items.map((row, i) => ({ objectId: row.providerRefs[0].remoteId, collectionId: `folder-${i}`,
    objectTypeId: 'login', title: row.title, payloadSchemaVersion: 1, headCommitId: `head-${i}`, deleted: false, payloadJson: '{"password_group_id":"group"}' }));
  const summaries = () => records.map(({ payloadJson: _payload, ...row }): Mdbx2ObjectSummary => ({ ...row, headCommitId: row.headCommitId!, updatedAt: state.updatedAt }));
  const client = { listObjects: vi.fn(async (_handle: string, folder: string): Promise<Mdbx2ObjectSummaryPage> => ({ items: summaries().filter(row => row.collectionId === folder) })),
    revealObject: vi.fn(async (_handle: string, id: string) => structuredClone(records.find(row => row.objectId === id)!)),
    readWriteRevision: vi.fn(async () => ({ ...revision })) };
  const members = new MdbxBitwardenMembers();
  const verify = (index = 0) => members.verify(state, account, items[index], client, collections, { vaultId: 'vault', revisionSha256: 'revision' });
  return { account, state, items, records, collections, client, revision, members, verify };
}

it('checks members across folders once per state and revision, retaining only identities', async () => {
  const f = fixture(); await f.verify(); await f.verify(1);
  expect(f.client.listObjects).toHaveBeenCalledTimes(2); expect(f.client.revealObject).toHaveBeenCalledTimes(2);
  await f.members.verify(structuredClone(f.state), f.account, f.items[0], f.client, f.collections, f.revision);
  expect(f.client.listObjects).toHaveBeenCalledTimes(4);
});

it.each(['new','missing','version','moved','group','duplicate-local'] as const)('refuses %s membership drift', async mode => {
  const f = fixture();
  if (mode === 'new') f.records.push({ ...f.records[0], objectId: 'not-indexed' });
  if (mode === 'missing') f.records.pop();
  if (mode === 'version') f.records[1].headCommitId = 'newer';
  if (mode === 'moved') f.records[1].collectionId = 'folder-0';
  if (mode === 'group') f.records[1].payloadJson = '{"password_group_id":"other"}';
  if (mode === 'duplicate-local') f.items[1].providerRefs = f.items[0].providerRefs;
  await expect(f.verify()).rejects.toThrow('成员或版本');
});

it('ignores unrelated native groups while checking the selected group', async () => {
  const f = fixture(); f.records.push({ ...f.records[0], objectId: 'unrelated', payloadJson: '{"password_group_id":"other"}' });
  await expect(f.verify()).resolves.toBeUndefined();
});

it('invalidates the cached catalog after an authenticated revision change', async () => {
  const f = fixture(); await f.verify(); f.records.push({ ...f.records[0], objectId: 'not-indexed' }); f.revision.revisionSha256 = 'newer';
  await expect(f.members.verify(f.state, f.account, f.items[0], f.client, f.collections, f.revision)).rejects.toThrow('成员或版本');
});

it('refuses native changes during a scan and does not cache the failed scan', async () => {
  const f = fixture(); f.client.readWriteRevision.mockResolvedValueOnce({ ...f.revision, revisionSha256: 'newer' });
  await expect(f.verify()).rejects.toThrow('成员或版本'); await f.verify(); expect(f.client.listObjects).toHaveBeenCalledTimes(4);
});

it.each(['duplicate','empty-cursor','repeated-cursor','schema','shape','native-head'] as const)('refuses ambiguous %s native catalogs', async mode => {
  const f = fixture();
  if (mode === 'duplicate') f.records.push({ ...f.records[0] });
  if (mode === 'empty-cursor') f.client.listObjects.mockResolvedValue({ items: [], nextCursor: 'stuck' });
  if (mode === 'repeated-cursor') f.client.listObjects.mockImplementation(async () => ({ items: [{ ...f.records[0], objectId: crypto.randomUUID(), headCommitId: 'head-0', updatedAt: f.state.updatedAt }], nextCursor: 'stuck' }));
  if (mode === 'repeated-cursor') f.client.revealObject.mockImplementation(async (_handle, id) => ({ ...f.records[0], objectId: id }));
  if (mode === 'schema') f.records[0].payloadSchemaVersion = 2;
  if (mode === 'shape') f.records[0].payloadJson = '{"password_group_id":7}';
  if (mode === 'native-head') f.client.revealObject.mockResolvedValue({ ...f.records[0], headCommitId: 'newer' });
  await expect(f.verify()).rejects.toThrow('成员或版本');
});
