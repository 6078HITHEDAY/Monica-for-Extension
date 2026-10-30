import type { LoginItem, ProviderAccount, VaultItem } from '../../core/model';
import { sameProviderBinding } from '../../core/provider';
import type { BitwardenProjectDeletionJournal } from '../../core/bitwarden-project-removal-journal';
import { readPasswordProjectRemovalJournal, type PasswordProjectRemovalRecord } from '../../core/password-project-removal-journal';
import { bytesToBase64 } from '../../security/encoding';
import { createSourceRecord } from '../../core/source-records';
import type { BitwardenProjectRemovalReadback } from './bitwarden-project-removal-readback';
import type { BitwardenProjectRestorationReadback, BitwardenProjectPreparationReadback } from './bitwarden-project-removal-restoration';
import { bitwardenProjectLocalSha256 } from '../../core/bitwarden-project-removal-local';
import { parseLosslessJson } from '../../core/lossless-json';
import { PasswordProjectAttachmentChangedError, verifyPasswordProjectRemovalAttachments, type PasswordProjectAttachmentReader } from '../attachments/password-project-removal-attachments';
import { BitwardenAttachmentDownloadService } from './bitwarden-attachments';
import { BitwardenClient, type BitwardenSessionConfig } from './bitwarden-client';
import { assertKnownBitwardenCipher, decodeBitwardenCipher } from './bitwarden-cipher-codec';
import { decryptBitwardenString, type BitwardenSymmetricKey } from './bitwarden-crypto';
import { bitwardenMutationFingerprint } from './bitwarden-durable-sync';
import { bitwardenOrganizationRecords, resolveBitwardenOrganizationKeys } from './bitwarden-organization';
import { ciphersOf } from './bitwarden-sync-cache';
import { BitwardenProjectRemovalConflict, bitwardenRemovalSnapshotSha256, type BitwardenProjectRemovalRemote } from './bitwarden-project-removal-transaction';
import { hasBitwardenPasskeyPreservationMarker, verifyBitwardenPasskeyPreservationCopy } from './bitwarden-passkey-preservation';

const field = (raw: Record<string, unknown>, name: string) => {
  const upper = name[0].toUpperCase() + name.slice(1);
  if (name in raw && upper in raw && JSON.stringify(raw[name]) !== JSON.stringify(raw[upper])) throw unavailable();
  return raw[name] ?? raw[upper];
};
const unavailable = () => new Error('无法完整核实 Bitwarden 项目及关联凭据，已保留原始记录和恢复日志。');
const clearKey = (key: BitwardenSymmetricKey) => { key.encKey.fill(0); key.macKey.fill(0); };

interface Inspection {
  raw: Map<string, Record<string, unknown>>;
  decoded: Map<string, VaultItem[]>;
  folders: Map<string, string>;
  organizationKeys: Map<string, BitwardenSymmetricKey>;
  decodeContext: BitwardenProjectRestorationReadback['decodeContext'];
}

/** Uncached production verifier. It performs no Cipher writes and never accepts
 * manager-supplied hashes as evidence. The caller holds the provider operation
 * queue, checks the current account binding and persists preparation atomically.
 */
export class BitwardenProjectRemovalVerifier {
  private session: BitwardenSessionConfig;
  constructor(private readonly client: BitwardenClient, private readonly account: ProviderAccount,
    private readonly downloads = new BitwardenAttachmentDownloadService(), private readonly signal?: AbortSignal) {
    if (account.kind !== 'bitwarden' || !account.enabled) throw unavailable();
    this.account = structuredClone(account);
    this.session = structuredClone(account.config) as BitwardenSessionConfig;
  }

  /** Verification and deletion share refreshed credentials; independent copies
   * can otherwise replay an expired/rotated refresh token during a long copy.
   */
  remote(): BitwardenProjectRemovalRemote {
    return {
      readCipher: async id => { const result = await this.client.getCipherDetails(this.session, id, this.signal); this.session = result.session; return result.payload; },
      deleteCipher: async id => { this.session = await this.client.softDeleteCipher(this.session, id, this.signal); },
      restoreCipher: async id => { this.session = (await this.client.restoreCipherOnce(this.session, id, this.signal)).session; },
      verifyRetained: record => this.verify(record)
    };
  }
  currentAccount(): ProviderAccount { return { ...this.account, config: structuredClone(this.session) }; }

  /** Called after retained edits, shared attachments and source Passkey copies
   * have been acknowledged. Every copied credential is independently re-read. */
  async prepare(input: PasswordProjectRemovalRecord): Promise<BitwardenProjectDeletionJournal> {
    const record = this.record(input);
    if (record.status !== 'preparing' || record.bitwardenDeletion) throw unavailable();
    const inspected = await this.inspect(record);
    try {
      await this.verifyDraft(record, inspected);
      await this.verifyPreservedPasskeys(record, inspected);
      const digest = async (row: LoginItem) => ({ itemId: row.id, cipherId: this.cipherId(row),
        snapshotSha256: await bitwardenRemovalSnapshotSha256(inspected.raw.get(this.cipherId(row))!) });
      const intent: BitwardenProjectDeletionJournal = { version: 1, revision: 1, phase: 'deleting',
        members: await Promise.all(record.removed.map(async row => ({ ...await digest(row), stage: 'ready' as const }))),
        retainedSnapshots: await Promise.all(record.retained.map(digest)) };
      const checking = { ...record, status: 'deleting' as const, bitwardenDeletion: intent };
      readPasswordProjectRemovalJournal([checking]);
      await this.verifyAttachments(checking, inspected);
      // Copy/download can take time: repeat membership and native content checks.
      await this.verify(checking);
      return intent;
    } finally { inspected.organizationKeys.forEach(clearKey); }
  }

  async verify(input: PasswordProjectRemovalRecord): Promise<void> {
    const record = this.record(input);
    if (record.status !== 'deleting' || !record.bitwardenDeletion?.retainedSnapshots) throw unavailable();
    const inspected = await this.inspect(record);
    try {
      await this.verifySnapshots(record, inspected);
      await this.verifyAttachments(record, inspected);
      const final = await this.inspect(record);
      try { await this.verifySnapshots(record, final); }
      finally { final.organizationKeys.forEach(clearKey); }
    } finally { inspected.organizationKeys.forEach(clearKey); }
  }

  /** Authoritative final projection, still separate from the vault's atomic save. */
  async committedReadback(input: PasswordProjectRemovalRecord): Promise<BitwardenProjectRemovalReadback> {
    const record = this.record(input);
    if (record.bitwardenDeletion?.phase !== 'committed') throw unavailable();
    await this.verify(record);
    const inspected = await this.inspect(record);
    try {
      await this.verifySnapshots(record, inspected);
      const items: VaultItem[] = [], sourceRecords = [];
      for (const row of [...record.retained, ...record.removed]) {
        const id = this.cipherId(row), raw = inspected.raw.get(id)!;
        if (Boolean(field(raw, 'deletedDate')) !== record.removed.some(source => source.id === row.id))
          throw new BitwardenProjectRemovalConflict('source-live');
        items.push(...inspected.decoded.get(id)!);
        sourceRecords.push(await createSourceRecord({ providerId: this.account.id, remoteId: id, format: 'bitwarden-cipher', encoding: 'json',
          revision: String(field(raw, 'revisionDate')), payload: JSON.stringify(raw) }));
      }
      const copyRecords = [];
      for (const saved of record.bitwardenPasskeyPreservation?.sources || []) for (const copy of saved.copies) {
        const raw = inspected.raw.get(copy.remoteId!)!;
        copyRecords.push(await createSourceRecord({ providerId: this.account.id, remoteId: copy.remoteId!, format: 'bitwarden-cipher', encoding: 'json',
          revision: String(field(raw, 'revisionDate')), payload: JSON.stringify(raw) }));
      }
      return { operationId: record.id, journalRevision: record.bitwardenDeletion.revision, items, sourceRecords,
        ...(copyRecords.length ? { passkeyCopies: { sourceRecords: copyRecords, decodeContext: inspected.decodeContext } } : {}),
        account: { ...this.account, config: structuredClone(this.session) } };
    } finally { inspected.organizationKeys.forEach(clearKey); }
  }

  /** Compensation adopts current server bytes; it never PUTs a saved draft.
   * Read twice so a changing project cannot be presented as a stable rollback.
   */
  async restoredReadback(input: PasswordProjectRemovalRecord): Promise<BitwardenProjectRestorationReadback> {
    const record = this.record(input);
    if (record.status !== 'deleting' || record.bitwardenDeletion?.phase !== 'restored') throw unavailable();
    const selected = (inspection: Inspection) => new Set([...record.retained, ...record.removed].map(row => this.cipherId(row)).concat(
      [...inspection.decoded].flatMap(([id, items]) => items.some(row => row.kind === 'login' && !row.deletedAt
        && row.passwordGroupId === record.retained[0].passwordGroupId) ? [id] : [])));
    const first = await this.inspect(record, true);
    try {
      const second = await this.inspect(record, true);
      try {
        const ids = [...selected(first)].sort(), finalIds = [...selected(second)].sort();
        if (JSON.stringify(ids) !== JSON.stringify(finalIds) || ids.length > 1000) throw unavailable();
        const sourceRecords = [];
        for (const id of ids) {
          const before = first.raw.get(id)!, raw = second.raw.get(id)!;
          const member = record.bitwardenDeletion.members.find(row => row.cipherId === id);
          if (Boolean(field(before, 'deletedDate')) !== Boolean(field(raw, 'deletedDate'))
            || await bitwardenRemovalSnapshotSha256(before) !== await bitwardenRemovalSnapshotSha256(raw)
            || member && member.stage !== 'ready' && field(raw, 'deletedDate')) throw unavailable();
          sourceRecords.push(await createSourceRecord({ providerId: this.account.id, remoteId: id, format: 'bitwarden-cipher', encoding: 'json',
            revision: String(field(raw, 'revisionDate')), payload: JSON.stringify(raw) }));
        }
        return { operationId: record.id, journalRevision: record.bitwardenDeletion.revision, account: this.currentAccount(),
          sourceRecords, decodeContext: second.decodeContext };
      } finally { second.organizationKeys.forEach(clearKey); }
    } finally { first.organizationKeys.forEach(clearKey); }
  }

  /** Stop preparing without any new copies, deletes, restores or ordinary sync.
   * An attempted create with no discoverable result remains uncertain. */
  async preparationReadback(input: PasswordProjectRemovalRecord): Promise<BitwardenProjectPreparationReadback> {
    const record = this.record(input);
    if (record.status !== 'preparing' || !record.bitwardenPreparationRecovery) throw unavailable();
    const snapshot = async () => {
      const inspected = await this.inspect(record, true);
      try {
        const ids = new Set([...record.retained, ...record.removed].map(row => this.cipherId(row)).concat(
          [...inspected.decoded].flatMap(([id, items]) => items.some(row => row.kind === 'login' && !row.deletedAt
            && row.passwordGroupId === record.retained[0].passwordGroupId) ? [id] : [])));
        if (ids.size > 1000) throw unavailable();
        const sourceRecords = [];
        for (const id of [...ids].sort()) {
          const raw = inspected.raw.get(id)!;
          if (field(raw, 'deletedDate')) throw unavailable();
          sourceRecords.push(await createSourceRecord({ providerId: this.account.id, remoteId: id, format: 'bitwarden-cipher', encoding: 'json',
            revision: String(field(raw, 'revisionDate')), payload: JSON.stringify(raw) }));
        }
        const passkeyCopies: BitwardenProjectPreparationReadback['passkeyCopies'] = [];
        const vaultKey = this.client.vaultKey(this.session);
        try {
          for (const source of record.bitwardenPasskeyPreservation?.sources || []) for (const copy of source.plan.copies) {
            const progress = source.copies.find(row => row.copyId === copy.copyId)!;
            const expected = parseLosslessJson(copy.payloadJson) as Record<string, unknown>;
            const matches: Record<string, unknown>[] = [];
            for (const raw of inspected.raw.values()) {
              const organization = field(raw, 'organizationId');
              if ((organization ?? null) !== (field(expected, 'organizationId') ?? null)) continue;
              const key = organization ? inspected.organizationKeys.get(String(organization)) : vaultKey;
              if (!key) throw unavailable();
              if (await hasBitwardenPasskeyPreservationMarker(copy, raw, key)) matches.push(raw);
            }
            if (matches.length > 1 || !matches.length && progress.stage !== 'ready') throw unavailable();
            if (!matches.length) continue;
            const raw = matches[0], id = field(raw, 'id');
            if (typeof id !== 'string' || !id || ids.has(id) || progress.stage === 'verified' && progress.remoteId !== id) throw unavailable();
            const details = await this.client.getCipherDetails(this.session, id, this.signal); this.session = details.session;
            if (!details.payload || await bitwardenRemovalSnapshotSha256(raw) !== await bitwardenRemovalSnapshotSha256(details.payload)
              || Boolean(field(raw, 'deletedDate')) !== Boolean(field(details.payload, 'deletedDate'))) throw unavailable();
            const organization = field(raw, 'organizationId'), key = organization ? inspected.organizationKeys.get(String(organization)) : vaultKey;
            if (!key) throw unavailable();
            await verifyBitwardenPasskeyPreservationCopy(source.plan, copy, details.payload, key);
            passkeyCopies.push({ sourceCipherId: source.plan.sourceCipherId, copyId: copy.copyId,
              sourceRecord: await createSourceRecord({ providerId: this.account.id, remoteId: id, format: 'bitwarden-cipher', encoding: 'json',
                revision: String(field(details.payload, 'revisionDate')), payload: JSON.stringify(details.payload) }) });
          }
        } finally { clearKey(vaultKey); }
        return { sourceRecords, passkeyCopies, decodeContext: inspected.decodeContext };
      } finally { inspected.organizationKeys.forEach(clearKey); }
    };
    const first = await snapshot(), second = await snapshot();
    if (JSON.stringify(first) !== JSON.stringify(second)) throw unavailable();
    return { ...second, operationId: record.id, preparationSnapshotSha256: await bitwardenProjectLocalSha256(record), account: this.currentAccount() };
  }

  private record(input: PasswordProjectRemovalRecord): PasswordProjectRemovalRecord {
    const [record] = readPasswordProjectRemovalJournal([input]);
    const external = record.providerBindings.filter(row => row.kind !== 'local');
    if (external.length !== 1 || !sameProviderBinding(external[0], this.account)) throw unavailable();
    const ids = [...record.retained, ...record.removed].map(row => this.cipherId(row));
    if (new Set(ids).size !== ids.length) throw unavailable();
    return record;
  }

  private cipherId(row: LoginItem): string {
    const id = row.providerRefs.find(ref => ref.providerId === this.account.id)?.remoteId;
    if (!id || /[:#]/.test(id)) throw unavailable();
    return id;
  }

  private async inspect(record: PasswordProjectRemovalRecord, recovery = false): Promise<Inspection> {
    this.signal?.throwIfAborted();
    const result = await this.client.sync(this.session, this.signal);
    this.session = result.session;
    if (!Array.isArray(field(result.payload, 'ciphers')) || field(result.payload, 'continuationToken') != null) throw unavailable();
    const raw = new Map(ciphersOf(result.payload).map(row => [String(field(row, 'id')), row]));
    const vaultKey = this.client.vaultKey(this.session);
    const organizations = await resolveBitwardenOrganizationKeys(result.payload, vaultKey).catch(cause => { clearKey(vaultKey); throw cause; });
    const inspected: Inspection = { raw, decoded: new Map(), folders: new Map(), organizationKeys: organizations.keys,
      decodeContext: { folders: [], organizations: [] } };
    try {
      const profile = field(result.payload, 'profile');
      if (profile != null && (typeof profile !== 'object' || Array.isArray(profile))) throw unavailable();
      const privateKey = profile && field(profile as Record<string, unknown>, 'privateKey') || field(result.payload, 'privateKey');
      inspected.decodeContext = { folders: [], organizations: bitwardenOrganizationRecords(result.payload), ...(typeof privateKey === 'string' ? { privateKey } : {}) };
      const folders = field(result.payload, 'folders');
      if (folders !== undefined && !Array.isArray(folders)) throw unavailable();
      inspected.decodeContext.folders = (folders || []) as Record<string, unknown>[];
      for (const folder of (folders || []) as Record<string, unknown>[]) {
        if (!folder || typeof folder !== 'object') throw unavailable();
        const name = field(folder, 'name'), id = field(folder, 'id');
        if (typeof name !== 'string' || typeof id !== 'string' || !id) throw unavailable();
        const plain = (await decryptBitwardenString(name, vaultKey)).trim().slice(0, 256);
        if (plain) inspected.folders.set(id, plain);
      }
      const expected = new Set([...record.retained, ...record.removed].map(row => this.cipherId(row)));
      const activeProject = new Set<string>();
      for (const [id, cipher] of raw) {
        this.signal?.throwIfAborted();
        // Inaccessible unrelated active login Ciphers could hide a new member;
        // their absence from local caches is not evidence of non-membership.
        if (!expected.has(id) && field(cipher, 'deletedDate')) continue;
        const type = field(cipher, 'type');
        if (typeof type !== 'number' || ![1, 2, 3, 4, 5].includes(type)) throw unavailable();
        if (!expected.has(id) && type !== 1) continue;
        const items = await this.decode(cipher, inspected, vaultKey);
        inspected.decoded.set(id, items);
        if (!field(cipher, 'deletedDate') && items.some(row => row.kind === 'login' && row.passwordGroupId === record.retained[0].passwordGroupId))
          activeProject.add(id);
      }
      if (!recovery && [...activeProject].some(id => !expected.has(id))) throw new BitwardenProjectRemovalConflict('retained-changed');
      for (const row of [...record.retained, ...record.removed]) {
        const id = this.cipherId(row), cipher = raw.get(id);
        // A missing record/access failure is uncertain, never deletion success.
        if (!cipher) throw unavailable();
        const isSource = record.removed.some(source => source.id === row.id);
        if (!recovery && !inspected.decoded.get(id)?.some(item => item.kind === 'login' && item.passwordGroupId === row.passwordGroupId))
          throw new BitwardenProjectRemovalConflict(isSource ? 'source-changed' : 'retained-changed');
        if (!recovery && (!isSource || record.status === 'preparing') && field(cipher, 'deletedDate'))
          throw new BitwardenProjectRemovalConflict(isSource ? 'source-changed' : 'retained-changed');
        // Hash /details, the same representation used by deletion readback.
        const details = await this.client.getCipherDetails(this.session, id, this.signal);
        this.session = details.session;
        if (!details.payload) throw unavailable();
        raw.set(id, details.payload);
        inspected.decoded.set(id, await this.decode(details.payload, inspected, vaultKey));
      }
      if (recovery) for (const id of activeProject) {
        if (expected.has(id)) continue;
        const details = await this.client.getCipherDetails(this.session, id, this.signal); this.session = details.session;
        if (!details.payload) throw unavailable();
        raw.set(id, details.payload); inspected.decoded.set(id, await this.decode(details.payload, inspected, vaultKey));
      }
      if (!recovery) for (const source of record.bitwardenPasskeyPreservation?.sources || []) for (const copy of source.copies) {
        if (copy.stage !== 'verified' || !copy.remoteId) throw unavailable();
        if (!raw.has(copy.remoteId)) throw new BitwardenProjectRemovalConflict('retained-changed');
        const details = await this.client.getCipherDetails(this.session, copy.remoteId, this.signal); this.session = details.session;
        if (!details.payload) throw unavailable();
        raw.set(copy.remoteId, details.payload); inspected.decoded.set(copy.remoteId, await this.decode(details.payload, inspected, vaultKey));
      }
      return inspected;
    } catch (cause) { organizations.keys.forEach(clearKey); throw cause; }
    finally { clearKey(vaultKey); }
  }

  private async decode(raw: Record<string, unknown>, context: Inspection, vaultKey: BitwardenSymmetricKey): Promise<VaultItem[]> {
    const organizationId = field(raw, 'organizationId');
    const key = organizationId ? context.organizationKeys.get(String(organizationId)) : vaultKey;
    if (!key) throw unavailable();
    assertKnownBitwardenCipher(raw);
    if (field(raw, 'type') === 1) {
      const login = field(raw, 'login');
      if (!login || typeof login !== 'object' || Array.isArray(login)) throw unavailable();
      for (const name of ['fido2Credentials', 'uris']) {
        const entries = field(login as Record<string, unknown>, name);
        if (entries != null && (!Array.isArray(entries) || entries.some(row => !row || typeof row !== 'object' || Array.isArray(row)))) throw unavailable();
      }
      const fields = field(raw, 'fields');
      if (fields != null && (!Array.isArray(fields) || fields.some(row => !row || typeof row !== 'object' || Array.isArray(row)))) throw unavailable();
    }
    const result = await decodeBitwardenCipher(raw, this.account.id, key, context.folders.get(String(field(raw, 'folderId'))),
      { requireReadableProjectMembership: true });
    if (result.warning || result.historyWarning || result.unsupported || !result.items.length) throw unavailable();
    return result.items;
  }

  private async verifyDraft(record: PasswordProjectRemovalRecord, inspected: Inspection): Promise<void> {
    for (const expected of [...record.retained, ...record.removed]) {
      const remote = inspected.decoded.get(this.cipherId(expected))?.find((row): row is LoginItem => row.kind === 'login');
      const ref = expected.providerRefs.find(ref => ref.providerId === this.account.id)!;
      const actual = remote?.providerRefs[0];
      if (!remote || remote.deletedAt || remote.passwordGroupId !== expected.passwordGroupId
        || actual?.remoteFolderId !== ref.remoteFolderId
        || JSON.stringify(actual?.remoteCollectionIds) !== JSON.stringify(ref.remoteCollectionIds)
        || await bitwardenMutationFingerprint(remote) !== await bitwardenMutationFingerprint(expected))
        throw new BitwardenProjectRemovalConflict(record.removed.some(row => row.id === expected.id) ? 'source-changed' : 'retained-changed');
    }
  }

  private async verifySnapshots(record: PasswordProjectRemovalRecord, inspected: Inspection): Promise<void> {
    const journal = record.bitwardenDeletion!;
    for (const snapshot of [...journal.members, ...journal.retainedSnapshots!]) {
      const raw = inspected.raw.get(snapshot.cipherId);
      if (!raw) throw unavailable();
      const source = journal.members.find(row => row.itemId === snapshot.itemId);
      if (!source && field(raw, 'deletedDate') || source?.stage === 'ready' && field(raw, 'deletedDate')
        || await bitwardenRemovalSnapshotSha256(raw) !== snapshot.snapshotSha256)
        throw new BitwardenProjectRemovalConflict(source ? 'source-changed' : 'retained-changed');
    }
    await this.verifyPreservedPasskeys(record, inspected);
  }

  private async verifyPreservedPasskeys(record: PasswordProjectRemovalRecord, inspected: Inspection): Promise<void> {
    const vaultKey = this.client.vaultKey(this.session);
    try {
      for (const row of record.removed) {
        const sourceId = this.cipherId(row), original = inspected.raw.get(sourceId)!;
        const children = inspected.decoded.get(sourceId)!.filter(row => row.kind === 'passkey');
        const saved = record.bitwardenPasskeyPreservation?.sources.find(row => row.plan.sourceCipherId === sourceId);
        if (!saved) {
          if (children.length) throw new Error('待移除密码包含 Passkey，尚未完成凭据保留流程，原密码和 Passkey 均未删除。');
          continue;
        }
        if (saved.plan.sourceSha256 !== await bitwardenRemovalSnapshotSha256(original) || children.length !== saved.copies.length
          || children.some(child => !saved.plan.copies.some(copy => copy.sourceRemoteId === child.providerRefs[0].remoteId)))
          throw new BitwardenProjectRemovalConflict('source-changed');
        const organization = field(original, 'organizationId'), key = organization ? inspected.organizationKeys.get(String(organization)) : vaultKey;
        if (!key) throw unavailable();
        for (let index = 0; index < saved.copies.length; index++) {
          const progress = saved.copies[index], copy = saved.plan.copies[index], matches = [];
          if (progress.stage !== 'verified' || !progress.remoteId) throw unavailable();
          for (const raw of inspected.raw.values()) {
            if ((field(raw, 'organizationId') ?? null) !== (organization ?? null)) continue;
            if (await hasBitwardenPasskeyPreservationMarker(copy, raw, key)) matches.push(raw);
          }
          if (matches.length !== 1 || field(matches[0], 'id') !== progress.remoteId) throw new BitwardenProjectRemovalConflict('retained-changed');
          try {
            const preserved = await verifyBitwardenPasskeyPreservationCopy(saved.plan, copy, matches[0], key);
            const child = children.find(row => row.providerRefs[0].remoteId === copy.sourceRemoteId);
            if (!child || await bitwardenMutationFingerprint(child) !== await bitwardenMutationFingerprint(preserved))
              throw new BitwardenProjectRemovalConflict('retained-changed');
          }
          catch { throw new BitwardenProjectRemovalConflict('retained-changed'); }
        }
      }
    } finally { clearKey(vaultKey); }
  }

  private async verifyAttachments(record: PasswordProjectRemovalRecord, inspected: Inspection): Promise<void> {
    const context = async (providerId: string, itemId: string) => {
      const row = [...record.retained, ...record.removed].find(row => row.id === itemId);
      if (providerId !== this.account.id || !row) throw unavailable();
      const details = await this.client.getCipherDetails(this.session, this.cipherId(row), this.signal);
      this.session = details.session;
      if (!details.payload) throw unavailable();
      return { providerId, itemId, session: this.session, rawCipher: details.payload, organizationKeys: inspected.organizationKeys };
    };
    const reader: PasswordProjectAttachmentReader = {
      listAttachments: async (providerId, itemId, cursor) => this.downloads.listAttachments(await context(providerId, itemId), { cursor }),
      beginRead: async (providerId, itemId, attachmentId) => {
        const result = await this.downloads.beginDownload({ ...await context(providerId, itemId), attachmentId, signal: this.signal });
        const { session, ...read } = result; this.session = session; return read;
      },
      readChunk: async (providerId, handle, offset, maxBytes) => {
        this.signal?.throwIfAborted();
        const { bytes, ...chunk } = this.downloads.readChunk(providerId, handle, offset, maxBytes);
        try { return { ...chunk, dataBase64: bytesToBase64(bytes) }; }
        finally { bytes.fill(0); }
      },
      releaseRead: async (providerId, handle) => this.downloads.release(providerId, handle)
    };
    try { await verifyPasswordProjectRemovalAttachments(record, record.proofs || [], reader); }
    catch (cause) {
      if (cause instanceof PasswordProjectAttachmentChangedError) throw new BitwardenProjectRemovalConflict('retained-changed');
      // Transport, cryptographic and missing-file errors retain recovery state.
      throw cause;
    }
  }
}
