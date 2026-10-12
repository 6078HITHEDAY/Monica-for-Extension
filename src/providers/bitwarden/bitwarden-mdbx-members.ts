import type { LoginItem, ProviderAccount, VaultState } from '../../core/model';
import { passwordGroupMembers } from '../../core/password-groups';
import { parseLosslessJson } from '../../core/lossless-json';
import type { Mdbx2CollectionSummary, Mdbx2ObjectRecord, Mdbx2ObjectSummary, Mdbx2ObjectSummaryPage, Mdbx2WriteRevision } from '../mdbx2/native-contract';

export interface MdbxBitwardenMembershipClient {
  listObjects(handle: string, collectionId: string, input: { objectTypeId: string; deleted: boolean; pageSize: number; cursor?: string }): Promise<Mdbx2ObjectSummaryPage>;
  revealObject(handle: string, id: string): Promise<Mdbx2ObjectRecord>;
  readWriteRevision(handle: string): Promise<Mdbx2WriteRevision>;
}
type Member = Pick<Mdbx2ObjectSummary, 'objectId' | 'collectionId' | 'headCommitId'> & { groupId?: string };
type Catalog = { handle: string; revision: string; vaultId: string; members: Member[] };

/** Cache only identities, scoped to one immutable preview/execute state. Never
 * retain decrypted native payloads or rescan the whole vault for each member. */
export class MdbxBitwardenMembers {
  private readonly snapshots = new WeakMap<VaultState, Map<string, Catalog>>();

  async verify(state: VaultState, account: ProviderAccount, item: LoginItem, client: MdbxBitwardenMembershipClient,
    collections: Mdbx2CollectionSummary[], revision: Mdbx2WriteRevision): Promise<void> {
    if (!item.passwordGroupId) return;
    const handle = String(account.config.vaultHandle), cache = this.snapshots.get(state) || new Map<string, Catalog>();
    this.snapshots.set(state, cache);
    let catalog = cache.get(account.id);
    if (!catalog || catalog.handle !== handle || catalog.vaultId !== revision.vaultId || catalog.revision !== revision.revisionSha256) {
      cache.delete(account.id);
      const members = await scan(client, handle, collections);
      const after = await client.readWriteRevision(handle);
      if (after.vaultId !== revision.vaultId || after.revisionSha256 !== revision.revisionSha256) throw changed();
      catalog = { handle, vaultId: revision.vaultId, revision: revision.revisionSha256, members }; cache.set(account.id, catalog);
    }
    const actual = catalog.members.filter(row => row.groupId === item.passwordGroupId);
    const expected = passwordGroupMembers(item, state.items);
    const seen = new Set<string>();
    if (actual.length !== expected.length || !actual.length) throw changed();
    for (const row of expected) {
      const ref = row.providerRefs[0];
      if (row.providerRefs.length !== 1 || ref.providerId !== account.id || !ref.remoteId || seen.has(ref.remoteId)) throw changed();
      seen.add(ref.remoteId);
      if (!actual.some(native => native.objectId === ref.remoteId && native.collectionId === ref.remoteFolderId && native.headCommitId === ref.revision)) throw changed();
    }
  }
}

async function scan(client: MdbxBitwardenMembershipClient, handle: string, collections: Mdbx2CollectionSummary[]): Promise<Member[]> {
  const folders = new Set<string>(), objects = new Set<string>(), members: Member[] = [];
  for (const folder of collections) {
    if (folder.deleted || folders.has(folder.collectionId) || folders.size >= 10_000) throw changed();
    folders.add(folder.collectionId);
    let cursor: string | undefined; const cursors = new Set<string>();
    do {
      const page = await client.listObjects(handle, folder.collectionId, { objectTypeId: 'login', deleted: false, pageSize: 200, cursor });
      for (const summary of page.items) {
        if (summary.deleted || summary.objectTypeId !== 'login' || summary.collectionId !== folder.collectionId
          || !summary.headCommitId || objects.has(summary.objectId) || objects.size >= 50_000) throw changed();
        objects.add(summary.objectId);
        const record = await client.revealObject(handle, summary.objectId);
        if (record.deleted || record.objectId !== summary.objectId || record.collectionId !== folder.collectionId
          || record.objectTypeId !== 'login' || record.headCommitId !== summary.headCommitId || record.payloadSchemaVersion !== 1) throw changed();
        let payload: Record<string, unknown>;
        try {
          const value = parseLosslessJson(record.payloadJson);
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw changed();
          payload = value as Record<string, unknown>;
        } catch { throw changed(); }
        if (payload.password_group_id != null && typeof payload.password_group_id !== 'string') throw changed();
        members.push({ objectId: record.objectId, collectionId: record.collectionId, headCommitId: record.headCommitId,
          groupId: typeof payload.password_group_id === 'string' ? payload.password_group_id : undefined });
      }
      cursor = page.nextCursor;
      if (cursor && (!page.items.length || cursors.has(cursor) || cursors.size >= 1_000)) throw changed();
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }
  return members;
}
function changed() { return new Error('MDBX 密码项目成员或版本已变化，无法确认完整复制，请先同步再预览。'); }
