import { createLoginItem, type LoginItem, type ProviderAccount, type VaultState, type VaultItem } from '../../core/model';
import { passwordGroupMembers } from '../../core/password-groups';
import { parseLosslessJson } from '../../core/lossless-json';
import type { Mdbx2CollectionSummary, Mdbx2ObjectRecord, Mdbx2ObjectSummary, Mdbx2ObjectSummaryPage, Mdbx2WriteRevision } from '../mdbx2/native-contract';
import { decodeMdbx2Object } from '../mdbx2/mdbx2-item-codec';
import { mdbx2TransferDependencies } from '../mdbx2/mdbx2-transfer-dependencies';
import { normalizeCredentialId } from '../../passkey/source-policy';
import { readPasskeyBindings } from '../../core/passkey-bindings';

export interface MdbxBitwardenMembershipClient {
  listObjects(handle: string, collectionId: string, input: { objectTypeId: string; deleted: boolean; pageSize: number; cursor?: string }): Promise<Mdbx2ObjectSummaryPage>;
  revealObject(handle: string, id: string): Promise<Mdbx2ObjectRecord>;
  readWriteRevision(handle: string): Promise<Mdbx2WriteRevision>;
}
type Member = Pick<Mdbx2ObjectSummary, 'objectId' | 'collectionId' | 'headCommitId'> & {
  groupId?: string; links?: LoginItem; moveIssue?: string; boundCredentials?: Array<string | undefined>;
};
type Catalog = { handle: string; revision: string; vaultId: string; withMoveLinks: boolean; members: Member[] };

/** Cache only identities, scoped to one immutable preview/execute state. Never
 * retain decrypted native payloads or rescan the whole vault for each member. */
export class MdbxBitwardenMembers {
  private readonly snapshots = new WeakMap<VaultState, Map<string, Catalog>>();

  async verify(state: VaultState, account: ProviderAccount, item: LoginItem, client: MdbxBitwardenMembershipClient,
    collections: Mdbx2CollectionSummary[], revision: Mdbx2WriteRevision): Promise<void> {
    if (!item.passwordGroupId) return;
    const catalog = await this.catalog(state, account, client, collections, revision);
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

  /** Incoming native owners matter for moves even when the local index has not
   * seen them. Keep only relationship metadata in the cached catalog. */
  async verifyMove(state: VaultState, account: ProviderAccount, items: VaultItem[], client: MdbxBitwardenMembershipClient,
    collections: Mdbx2CollectionSummary[], revision: Mdbx2WriteRevision): Promise<void> {
    const catalog = await this.catalog(state, account, client, collections, revision, true);
    if (catalog.members.some(row => row.moveIssue || !row.links)) throw new Error('MDBX 原生关联含有尚不能确认的字段，请保留来源并使用复制。');
    const credentials = new Set(items.flatMap(item => item.kind === 'passkey' ? [normalizeCredentialId(item.credentialId)] : []));
    if (credentials.size && catalog.members.some(row => row.boundCredentials?.some(id => !id || credentials.has(id))))
      throw new Error('MDBX Passkey 仍有关联密码，关联迁移尚未完成，请使用复制。');
    const selected = new Map(items.map(item => [item.providerRefs[0].remoteId, item]));
    for (const item of items.filter(item => item.kind === 'login')) {
      const native = catalog.members.find(row => row.objectId === item.providerRefs[0].remoteId);
      if (!native || native.headCommitId !== item.providerRefs[0].revision || native.collectionId !== item.providerRefs[0].remoteFolderId) throw changed();
    }
    const normalize = (item: VaultItem): VaultItem => {
      const result = structuredClone(item); delete result.mdbxDatabaseId; delete result.keepassDatabaseId; return result;
    };
    const candidates = [...items, ...catalog.members.filter(row => !selected.has(row.objectId)).map(row => row.links!)].map(normalize);
    if (new Set(candidates.map(item => item.id)).size !== candidates.length) throw changed();
    const expanded = mdbx2TransferDependencies(items.map(item => item.id), candidates, 'move').selectedIds;
    if (expanded.length !== items.length || expanded.some(id => !items.some(item => item.id === id)))
      throw new Error('MDBX 原生库还有未包含的项目成员或关联，请先同步再移动。');
  }

  private async catalog(state: VaultState, account: ProviderAccount, client: MdbxBitwardenMembershipClient,
    collections: Mdbx2CollectionSummary[], revision: Mdbx2WriteRevision, withMoveLinks = false): Promise<Catalog> {
    const handle = String(account.config.vaultHandle), cache = this.snapshots.get(state) || new Map<string, Catalog>();
    this.snapshots.set(state, cache);
    let catalog = cache.get(account.id);
    if (!catalog || catalog.handle !== handle || catalog.vaultId !== revision.vaultId || catalog.revision !== revision.revisionSha256 || withMoveLinks && !catalog.withMoveLinks) {
      cache.delete(account.id);
      const members = await scan(client, handle, account.id, collections, withMoveLinks);
      const after = await client.readWriteRevision(handle);
      if (after.vaultId !== revision.vaultId || after.revisionSha256 !== revision.revisionSha256) throw changed();
      catalog = { handle, vaultId: revision.vaultId, revision: revision.revisionSha256, withMoveLinks, members }; cache.set(account.id, catalog);
    }
    return catalog;
  }
}

async function scan(client: MdbxBitwardenMembershipClient, handle: string, providerId: string, collections: Mdbx2CollectionSummary[], withMoveLinks: boolean): Promise<Member[]> {
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
        const member: Member = { objectId: record.objectId, collectionId: record.collectionId, headCommitId: record.headCommitId,
          groupId: typeof payload.password_group_id === 'string' ? payload.password_group_id : undefined };
        if (withMoveLinks) {
          const decoded = decodeMdbx2Object(record, { headCommitId: record.headCommitId!, updatedAt: summary.updatedAt }, providerId).item;
          if (decoded?.kind !== 'login') member.moveIssue = 'unknown-login';
          else {
            member.links = { ...createLoginItem({ title: '' }), id: decoded.id, providerRefs: decoded.providerRefs,
              replicaGroupId: decoded.replicaGroupId, passwordGroupId: decoded.passwordGroupId, ssoRefLogicalId: decoded.ssoRefLogicalId,
              boundNoteEntryId: decoded.boundNoteEntryId, boundTotpItemId: decoded.boundTotpItemId };
            if (decoded.boundNoteId != null && !decoded.boundNoteEntryId || decoded.ssoRefEntryId != null && !decoded.ssoRefLogicalId)
              member.moveIssue = 'legacy-reference';
            if (decoded.passkeyBindings) {
              try { member.boundCredentials = readPasskeyBindings(decoded.passkeyBindings).map(binding => normalizeCredentialId(binding.credentialId || '') || undefined); }
              catch { member.boundCredentials = [undefined]; }
            }
          }
        }
        members.push(member);
      }
      cursor = page.nextCursor;
      if (cursor && (!page.items.length || cursors.has(cursor) || cursors.size >= 1_000)) throw changed();
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }
  return members;
}
function changed() { return new Error('MDBX 密码项目成员或版本已变化，无法确认完整复制，请先同步再预览。'); }
