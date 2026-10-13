import type { VaultItem, VaultState } from '../core/model';
import { parseLosslessJson } from '../core/lossless-json';
import { isLocalTransferItem, validateLocalAttachments, type LocalItemAttachment } from '../core/local-transfer';
import { mdbx2TransferOperationScope as hash } from '../providers/mdbx2/mdbx2-transfer-identity';
import { normalizeCredentialId } from '../passkey/source-policy';
import { nearbyLocalItemToWire, nearbyWireToLocalItem } from './application-codec';
import { invalidNearby, validateNearbyWireData, wireInteger, wireObject, wireText, type NearbyWireData } from './wire-shape';

export interface NearbyIncomingRecord { id: string; clockJson: string; dataJson: string; deleted: boolean }
export interface NearbyLocalAcknowledgement {
  recordId: string; clockJson: string; localId: string; scope: 'local'; guard: string; dataJson: string;
}
export interface NearbyLocalReceipt {
  version: 1; providerId: string; recordId: string; itemId: string; fingerprint: string;
  dataJson: string; baseline: VaultItem; acknowledgement: NearbyLocalAcknowledgement;
}
export interface NearbyLocalBatch {
  providerId: string;
  sourceHash: string;
  records: NearbyIncomingRecord[];
  /** Already authenticated by the transport; verified again before storage. */
  assets: Array<{ id: string; dataBase64: string }>;
}

const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const digestPattern = /^[a-f0-9]{64}$/;
function clock(value: string): Map<string, bigint> {
  if (typeof value !== 'string' || value.length > 64 * 1024) invalidNearby('clock-size');
  const object = wireObject(parseLosslessJson(value)), result = new Map<string, bigint>();
  if (!Object.keys(object).length || Object.keys(object).length > 1024) invalidNearby('clock-count');
  for (const [key, value] of Object.entries(object)) {
    if (!idPattern.test(key)) invalidNearby('clock-device');
    result.set(key, wireInteger(value, (1n << 64n) - 1n));
  }
  return result;
}

export function readNearbyLocalReceipts(value: unknown): NearbyLocalReceipt[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20_000) invalidNearby('receipt-list');
  const ids = new Set<string>();
  for (const raw of value) {
    const row = wireObject(raw), ack = wireObject(row.acknowledgement), baseline = wireObject(row.baseline);
    if (row.version !== 1 || typeof row.providerId !== 'string' || !row.providerId || typeof row.recordId !== 'string' || !idPattern.test(row.recordId)
      || typeof row.itemId !== 'string' || baseline.id !== row.itemId || typeof row.fingerprint !== 'string' || !digestPattern.test(row.fingerprint)
      || ack.recordId !== row.recordId || ack.localId !== `local:${row.itemId}` || ack.scope !== 'local' || typeof ack.guard !== 'string' || !digestPattern.test(ack.guard)
      || typeof row.dataJson !== 'string' || row.dataJson.length > 1024 * 1024 || typeof ack.dataJson !== 'string' || ack.dataJson.length > 1024 * 1024) invalidNearby('receipt-invalid');
    if (ids.has(row.recordId)) invalidNearby('receipt-duplicate'); ids.add(row.recordId);
    clock(wireText(ack.clockJson)); validateNearbyWireData(parseLosslessJson(row.dataJson)); validateNearbyWireData(parseLosslessJson(ack.dataJson));
  }
  return structuredClone(value) as NearbyLocalReceipt[];
}

/** Bind incoming adoption to the exact local snapshot, including attachments,
 * origin archives and pending cross-provider work. No secrets leave the caller. */
export async function nearbyLocalSourceHash(state: VaultState): Promise<string> {
  return hash({ items: state.items.filter(item => isLocalTransferItem(item, state.providers)),
    providers: state.providers.filter(provider => provider.kind === 'local'), nearbyEpoch: state.nearbyPreferences?.epoch ?? null, attachments: state.localItemAttachments ?? [],
    origins: state.localItemOrigins ?? [], folders: state.localTransferFolders ?? [], receipts: readNearbyLocalReceipts(state.nearbyLocalReceipts),
    removals: state.passwordProjectRemovals ?? [], transfers: state.bitwardenBatchTransfers ?? [], queue: state.mutationQueue, conflicts: state.providerConflicts });
}

async function itemGuard(item: VaultItem, attachments: LocalItemAttachment[]): Promise<string> { return hash({ item, attachments }); }

export interface NearbyLocalSnapshot {
  sourceHash: string;
  records: Array<{ local_id: string; global_id: string; scope: 'local'; guard: string; deleted: boolean; data: NearbyWireData }>;
  assets: Array<{ id: string; dataBase64: string }>;
}

function uuidFromDigest(digest: string): string { return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`; }

/** Capture all local items from one authenticated state. Provider-backed entries
 * retain their separate sync policy; a failed row rejects the entire scan. */
export async function captureNearbyLocalSnapshot(state: VaultState): Promise<NearbyLocalSnapshot> {
  const receipts = readNearbyLocalReceipts(state.nearbyLocalReceipts), locals = state.items.filter(item => isLocalTransferItem(item, state.providers));
  const identities = new Map<string, string>(), references = new Map<string, string>();
  for (const item of locals) {
    requireUncontended(state, item.id);
    const receipt = receipts.find(row => row.itemId === item.id);
    if (!receipt && state.localItemOrigins?.some(origin => origin.itemId === item.id && origin.records.length)) invalidNearby('local-origin-adapter-required');
    const id = receipt?.recordId ?? uuidFromDigest(await hash(['nearby-local', item.id]));
    identities.set(item.id, id);
    references.set(item.id, id); references.set(`password:${item.id}`, id); references.set(`note:${item.id}`, id);
    if (item.replicaGroupId) {
      if (references.has(item.replicaGroupId) && references.get(item.replicaGroupId) !== id) invalidNearby('ambiguous-local-reference');
      references.set(item.replicaGroupId, id);
    }
  }
  const records: NearbyLocalSnapshot['records'] = [], assets = new Map<string, string>();
  for (const item of locals) {
    const receipt = receipts.find(row => row.itemId === item.id), previous = receipt ? wireObject(parseLosslessJson(receipt.dataJson)) as NearbyWireData : undefined;
    const files = (state.localItemAttachments ?? []).filter(file => file.itemId === item.id);
    await validateLocalAttachments(files, item.id);
    const descriptors: Record<string, unknown>[] = files.map(file => {
      const originals = (previous?.assets as Record<string, unknown>[] | undefined) ?? [];
      const old = originals.find((asset, index) => file.attachmentId === `nearby-${asset.id}-${index}`);
      if (assets.has(file.sha256) && assets.get(file.sha256) !== file.dataBase64) invalidNearby('conflicting-asset-content');
      assets.set(file.sha256, file.dataBase64);
      return { ...old, id: file.sha256, size: file.sizeBytes, file_name: file.fileName, media_type: file.mediaType ?? 'application/octet-stream' };
    });
    let folderPath = previous?.folder_path as unknown[] | undefined;
    if (!receipt || receipt.baseline.categoryId !== item.categoryId || receipt.baseline.categoryName !== item.categoryName) {
      folderPath = item.categoryName ? [{ id: uuidFromDigest(await hash(['nearby-local-folder', item.categoryId ?? item.categoryName])), title: item.categoryName, parent: null }] : [];
    }
    const data = await nearbyLocalItemToWire(item, { folder: item.categoryName ?? '', folder_path: folderPath ?? [], assets: descriptors,
      labels: previous?.labels as unknown[] | undefined, relations: previous?.relations as unknown[] | undefined },
    previous && receipt ? { data: previous, item: receipt.baseline } : undefined);
    if (item.kind === 'login') {
      const ext = wireObject(data.extensions);
      for (const [value, field] of [[item.boundNoteEntryId, 'bound_note_entry_id'], [item.ssoRefLogicalId, 'sso_ref_entry_id']] as const) {
        if (!value) continue;
        const target = references.get(value); if (!target) invalidNearby('local-reference-missing'); ext[field] = target;
      }
      if (item.ssoRefLogicalId) delete ext.sso_ref_logical_id;
    }
    if (item.kind === 'totp') {
      const owners = locals.filter(row => row.kind === 'login' && row.boundTotpItemId === item.id);
      if (owners.length > 1) invalidNearby('ambiguous-otp-owner');
      if (owners.length) wireObject(data.payload).bound_password_entry_id = identities.get(owners[0].id);
    }
    validateNearbyWireData(data);
    records.push({ local_id: `local:${item.id}`, global_id: identities.get(item.id)!, scope: 'local', guard: await itemGuard(item, files), deleted: Boolean(item.deletedAt), data });
  }
  return { sourceHash: await nearbyLocalSourceHash(state), records, assets: [...assets].map(([id, dataBase64]) => ({ id, dataBase64 })) };
}

function requireUncontended(state: VaultState, id: string): void {
  if (state.mutationQueue.some(row => row.itemId === id) || state.providerConflicts.some(row => row.itemId === id)
    || state.passwordProjectRemovals?.some(row => !['completed', 'cancelled'].includes(row.status)
      && [...row.retained, ...row.removed].some(item => item.id === id))
    || state.bitwardenBatchTransfers?.some(row => row.status === 'writing' && row.request.action === 'move' && row.request.itemIds.includes(id))) invalidNearby('local-operation-pending');
}

/** Returns an entirely new state. The service persists it once and only then
 * returns acknowledgements. A failed write cannot partially adopt a project. */
export async function applyNearbyLocalBatch(state: VaultState, input: NearbyLocalBatch, now: string): Promise<{ state: VaultState; acknowledgements: NearbyLocalAcknowledgement[]; changed: boolean }> {
  if (!Number.isFinite(Date.parse(now)) || !digestPattern.test(input.sourceHash) || !Array.isArray(input.records) || !input.records.length || input.records.length > 200
    || !Array.isArray(input.assets) || input.assets.length > 512) invalidNearby('adoption-batch');
  const provider = state.providers.find(row => row.id === input.providerId);
  if (!provider?.enabled || provider.kind !== 'local') invalidNearby('local-provider-required');
  const receipts = readNearbyLocalReceipts(state.nearbyLocalReceipts), byId = new Map(receipts.map(row => [row.recordId, row]));
  const ids = new Set<string>(), assets = new Map<string, string>();
  for (const asset of input.assets) {
    if (!digestPattern.test(asset.id) || assets.has(asset.id) || typeof asset.dataBase64 !== 'string' || asset.dataBase64.length > 24 * 1024 * 1024) invalidNearby('adoption-assets');
    assets.set(asset.id, asset.dataBase64);
  }
  const work = await Promise.all(input.records.map(async record => {
    if (!idPattern.test(record.id) || ids.has(record.id) || typeof record.deleted !== 'boolean' || typeof record.dataJson !== 'string' || record.dataJson.length > 1024 * 1024) invalidNearby('adoption-record');
    ids.add(record.id);
    const vector = clock(record.clockJson), data = parseLosslessJson(record.dataJson);
    validateNearbyWireData(data);
    const fingerprint = await hash(record), old = byId.get(record.id);
    if (old && old.providerId !== provider.id) invalidNearby('adoption-provider-changed');
    if (old?.fingerprint !== fingerprint && old) {
      const before = clock(old.acknowledgement.clockJson);
      let newer = false;
      for (const [device, count] of before) if ((vector.get(device) ?? 0n) < count) invalidNearby('adoption-clock-regression');
      for (const [device, count] of vector) if (count > (before.get(device) ?? 0n)) newer = true;
      if (!newer) invalidNearby('adoption-clock-conflict');
    }
    return { record, data, fingerprint, old, replay: old?.fingerprint === fingerprint };
  }));
  if (work.every(row => row.replay)) return { state, acknowledgements: work.map(row => structuredClone(row.old!.acknowledgement)), changed: false };
  if (await nearbyLocalSourceHash(state) !== input.sourceHash) invalidNearby('local-source-changed');
  const next = structuredClone(state), acknowledgements: NearbyLocalAcknowledgement[] = [], changedItems = new Set<string>();
  for (const row of work) {
    if (row.replay) { acknowledgements.push(structuredClone(row.old!.acknowledgement)); continue; }
    const { record, data, old } = row;
    let existing = old ? next.items.find(item => item.id === old.itemId) : undefined;
    if (old && !existing) invalidNearby('local-item-missing');
    if (!existing && data.entry_type === 'passkey') {
      const payload = wireObject(data.payload);
      const matches = next.items.filter((item): item is Extract<VaultItem, { kind: 'passkey' }> => item.kind === 'passkey' && isLocalTransferItem(item, next.providers)
        && item.rpId.toLowerCase() === wireText(payload.rp_id).toLowerCase() && normalizeCredentialId(item.credentialId) === normalizeCredentialId(wireText(payload.credential_id)));
      if (matches.length > 1) invalidNearby('duplicate-local-passkey'); existing = matches[0];
    }
    if (existing && !isLocalTransferItem(existing, next.providers)) invalidNearby('local-item-source-changed');
    const itemId = existing?.id ?? `nearby-${record.id}`;
    if (changedItems.has(itemId) || [...byId.values()].some(receipt => receipt.itemId === itemId && receipt.recordId !== record.id)) invalidNearby('duplicate-record-target');
    changedItems.add(itemId);
    if (!existing && next.items.some(item => item.id === itemId)) invalidNearby('local-item-collision');
    requireUncontended(next, itemId);
    const savedData = { ...data, trashed: record.deleted || data.trashed === true };
    const item = await nearbyWireToLocalItem(savedData, { id: itemId, providerId: provider.id, now, previous: existing });
    const files: LocalItemAttachment[] = [];
    for (const [index, raw] of ((data.assets as unknown[] | undefined) ?? []).entries()) {
      const asset = wireObject(raw), id = wireText(asset.id).toLowerCase(), body = assets.get(id);
      if (body === undefined) invalidNearby('adoption-asset-missing');
      files.push({ itemId, attachmentId: `nearby-${id}-${index}`, fileName: wireText(asset.file_name), mediaType: wireText(asset.media_type),
        sizeBytes: Number(wireInteger(asset.size, 16n * 1024n * 1024n)), sha256: id, dataBase64: body, protected: true });
    }
    await validateLocalAttachments(files, itemId);
    if (data.folder) {
      const path = data.folder_path as Array<{ id: string; title: string }> | undefined;
      const identity = path?.length ? path[path.length - 1].id : `legacy:${data.folder}`;
      const origin = `nearby-folder:${identity}`;
      let category = next.localTransferFolders?.find(folder => folder.origin === origin);
      if (!category) {
        const maximum = Math.max(0, ...next.items.map(item => item.categoryId ?? 0), ...(next.localTransferFolders ?? []).map(folder => folder.categoryId));
        if (!Number.isSafeInteger(maximum) || maximum >= Number.MAX_SAFE_INTEGER) invalidNearby('local-category-limit');
        category = { origin, categoryId: maximum + 1, categoryName: data.folder };
        next.localTransferFolders = [...(next.localTransferFolders ?? []), category];
      }
      item.categoryId = category.categoryId; item.categoryName = category.categoryName;
    }
    next.items = [...next.items.filter(candidate => candidate.id !== itemId), item];
    next.localItemAttachments = [...(next.localItemAttachments ?? []).filter(file => file.itemId !== itemId), ...files];
    const acknowledgement: NearbyLocalAcknowledgement = { recordId: record.id, clockJson: record.clockJson, localId: `local:${itemId}`, scope: 'local',
      guard: await itemGuard(item, files), dataJson: record.dataJson };
    const receipt: NearbyLocalReceipt = { version: 1, providerId: provider.id, recordId: record.id, itemId, fingerprint: row.fingerprint,
      dataJson: record.dataJson, baseline: item, acknowledgement };
    byId.set(record.id, receipt); acknowledgements.push(acknowledgement);
  }
  // Resolve complete project links after every item is staged, so input order
  // cannot disconnect a note, SSO account or bound authenticator.
  const resolve = (id: unknown): VaultItem | undefined => {
    if (typeof id !== 'string' || !idPattern.test(id)) return undefined;
    const receipt = byId.get(id), item = receipt && next.items.find(item => item.id === receipt.itemId);
    if (!item) invalidNearby('reference-target-missing');
    return item;
  };
  for (const row of work.filter(row => !row.replay)) {
    const receipt = byId.get(row.record.id)!, item = next.items.find(item => item.id === receipt.itemId)!;
    const payload = wireObject(row.data.entry_type === 'login' || row.data.entry_type === 'ssh-key' ? row.data.extensions ?? {} : row.data.payload);
    if (item.kind === 'login') {
      const note = resolve(payload.bound_note_entry_id);
      if (note) { if (note.kind !== 'secure-note') invalidNearby('note-target-type'); item.boundNoteEntryId = `note:${note.id}`; }
      const account = resolve(payload.sso_ref_entry_id);
      if (account) { if (account.kind !== 'login' || account.id === item.id) invalidNearby('sso-target-type'); item.ssoRefLogicalId = `password:${account.id}`; item.ssoRefEntryId = undefined; }
    }
    if (item.kind === 'totp') {
      const owner = resolve(payload.bound_password_entry_id);
      if (owner) { if (owner.kind !== 'login' || !changedItems.has(owner.id)) invalidNearby('otp-owner-not-in-batch'); owner.boundTotpItemId = item.id; }
      item.boundPasswordId = undefined;
    }
  }
  for (const row of work.filter(row => !row.replay)) {
    const receipt = byId.get(row.record.id)!, item = next.items.find(item => item.id === receipt.itemId)!;
    receipt.baseline = structuredClone(item);
    receipt.acknowledgement.guard = await itemGuard(item, (next.localItemAttachments ?? []).filter(file => file.itemId === item.id));
  }
  next.nearbyLocalReceipts = readNearbyLocalReceipts([...byId.values()]);
  next.updatedAt = now;
  return { state: next, acknowledgements, changed: true };
}
