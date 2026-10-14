import type { VaultState } from '../core/model';
import { localTransferFolders, validateLocalAttachments, type LocalItemAttachment } from '../core/local-transfer';
import { parseLosslessJson } from '../core/lossless-json';
import { mdbx2TransferOperationScope as hash } from '../providers/mdbx2/mdbx2-transfer-identity';
import { invalidNearby, validateNearbyWireData, wireInteger, wireObject, wireText, type NearbyWireData } from './wire-shape';
import type { NearbyIncomingRecord, NearbyLocalAcknowledgement } from './local-adoption';

/** Separate encrypted application metadata; folders/root tags are never fake password items. */
export interface NearbyLocalMetadata {
  version: 1; providerId: string; recordId: string; localId: string; categoryKey?: string;
  dataJson: string; deleted: boolean; attachments: LocalItemAttachment[];
  fingerprint?: string; acknowledgement?: NearbyLocalAcknowledgement;
  replayInvalidated?: boolean;
}
export interface NearbyMetadataSnapshot { value: NearbyLocalMetadata; data: NearbyWireData; guard: string }
const identity = /^[A-Za-z0-9_-]{1,64}$/, digest = /^[a-f0-9]{64}$/;
export const isNearbyTombstone = (data: Record<string, unknown>) => Object.keys(data).length === 0;
export const isNearbyMetadata = (data: Record<string, unknown>) => data.entry_type === 'folder' || data.entry_type === 'vault-metadata' || isNearbyTombstone(data);
export const nearbyCategoryKey = (row: { categoryId?: number; categoryName?: string }) => row.categoryId != null ? `id:${row.categoryId}` : row.categoryName ? `name:${row.categoryName}` : undefined;
export function readNearbyLocalMetadata(value: unknown): NearbyLocalMetadata[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20_000) invalidNearby('metadata-list');
  const ids = new Set<string>(), addresses = new Set<string>(), categories = new Set<string>();
  for (const raw of value) {
    const p = wireObject(raw);
    if (p.version !== 1 || typeof p.providerId !== 'string' || !p.providerId || !identity.test(wireText(p.recordId))
      || !/^local:metadata-[A-Za-z0-9_-]{1,64}$/.test(wireText(p.localId)) || typeof p.deleted !== 'boolean'
      || typeof p.dataJson !== 'string' || p.dataJson.length > 1024 * 1024 || !Array.isArray(p.attachments) || p.attachments.length > 512) invalidNearby('metadata-state');
    const data = wireObject(parseLosslessJson(p.dataJson));
    if (p.replayInvalidated !== undefined && typeof p.replayInvalidated !== 'boolean') invalidNearby('metadata-receipt');
    if (!(p.deleted && isNearbyTombstone(data))) validateNearbyWireData(data);
    if (!isNearbyMetadata(data) || ids.has(p.recordId as string) || addresses.has(p.localId as string)) invalidNearby('metadata-identity');
    ids.add(p.recordId as string); addresses.add(p.localId as string);
    if (p.categoryKey !== undefined) {
      if (data.entry_type !== 'folder' || typeof p.categoryKey !== 'string' || !/^(?:id:[0-9]+|name:.{1,4096})$/u.test(p.categoryKey)
        || categories.has(p.categoryKey)) invalidNearby('metadata-category');
      if (p.categoryKey.startsWith('id:') && (!Number.isSafeInteger(Number(p.categoryKey.slice(3))) || String(Number(p.categoryKey.slice(3))) !== p.categoryKey.slice(3))) invalidNearby('metadata-category');
      categories.add(p.categoryKey);
    }
    if (p.fingerprint !== undefined || p.acknowledgement !== undefined) {
      const a = wireObject(p.acknowledgement);
      if (!digest.test(wireText(p.fingerprint)) || a.recordId !== p.recordId || a.localId !== p.localId || a.scope !== 'local'
        || !digest.test(wireText(a.guard))) invalidNearby('metadata-receipt');
      const clocks = wireObject(parseLosslessJson(wireText(a.clockJson)));
      if (!Object.keys(clocks).length || Object.keys(clocks).length > 1024) invalidNearby('metadata-clock');
      for (const [id, count] of Object.entries(clocks)) { if (!identity.test(id)) invalidNearby('metadata-clock'); wireInteger(count, (1n << 64n) - 1n); }
      const acknowledged = wireObject(parseLosslessJson(wireText(a.dataJson)));
      if (!(p.deleted && isNearbyTombstone(acknowledged))) validateNearbyWireData(acknowledged);
    }
  }
  return structuredClone(value) as NearbyLocalMetadata[];
}
function uuid(digest: string): string { return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`; }
const pathOf = (data: NearbyWireData) => wireObject(data.payload).path as Array<{ id: string; title: string; parent: string | null }>;
const categoryId = (key?: string) => key?.startsWith('id:') ? Number(key.slice(3)) : undefined;

/** Include empty categories, retained hierarchy and independent root metadata. */
export async function captureNearbyMetadata(state: VaultState): Promise<NearbyMetadataSnapshot[]> {
  const values = readNearbyLocalMetadata(state.nearbyLocalMetadata), folders = localTransferFolders(state);
  const locals = state.providers.filter(p => p.kind === 'local' && p.enabled);
  const categories = new Set(values.map(row => row.categoryKey));
  if ((values.length || folders.length) && locals.length !== 1) invalidNearby('local-provider-required');
  for (const folder of folders) if (!categories.has(folder.key)) {
    if (folder.categoryId !== undefined && (!Number.isSafeInteger(folder.categoryId) || folder.categoryId < 0)) invalidNearby('metadata-category');
    const origin = state.localTransferFolders?.find(row => nearbyCategoryKey(row) === folder.key)?.origin;
    const portable = origin?.startsWith('nearby-folder:') ? origin.slice('nearby-folder:'.length) : undefined;
    const id = portable && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(portable) ? portable
      : uuid(await hash(['nearby-local-folder', folder.categoryId ?? folder.categoryName]));
    values.push({ version: 1, providerId: locals[0].id, recordId: id, localId: `local:metadata-${id}`, categoryKey: folder.key, deleted: false,
      attachments: [], dataJson: JSON.stringify({ title: folder.categoryName, folder: '', entry_type: 'folder', payload: { path: [{ id, title: folder.categoryName, parent: null }] } }) });
  }
  const names = new Map(folders.map(folder => [folder.key, folder.categoryName]));
  const result: NearbyMetadataSnapshot[] = [];
  for (const row of values) {
    if (row.providerId !== locals[0]?.id) invalidNearby('metadata-provider-changed');
    await validateLocalAttachments(row.attachments, row.localId);
    const data = parseLosslessJson(row.dataJson) as NearbyWireData;
    const deleted = row.deleted || row.categoryKey !== undefined && !names.has(row.categoryKey);
    if (row.categoryKey && !deleted) {
      data.title = names.get(row.categoryKey)!;
      const path = pathOf(data);
      path[path.length - 1].title = data.title;
    }
    if (!(deleted && isNearbyTombstone(data))) validateNearbyWireData(data);
    const value = { ...row, deleted };
    result.push({ value, data, guard: await hash({ dataJson: JSON.stringify(data), deleted, categoryKey: row.categoryKey ?? null, attachments: row.attachments }) });
  }
  return result;
}

export function nextNearbyCategoryId(state: VaultState): number {
  const used = [...state.items.map(row => row.categoryId ?? 0), ...(state.localTransferFolders ?? []).map(row => row.categoryId),
    ...(state.nearbyLocalMetadata ?? []).map(row => categoryId(row.categoryKey) ?? 0)];
  let maximum = 0;
  for (const n of used) { if (!Number.isSafeInteger(n) || n < 0) invalidNearby('local-category-limit'); maximum = Math.max(maximum, n); }
  if (maximum >= Number.MAX_SAFE_INTEGER) invalidNearby('local-category-limit');
  return maximum + 1;
}
/** Stages metadata/folders only. The caller updates item membership once all records are staged. */
export async function stageNearbyMetadata(state: VaultState, original: NearbyMetadataSnapshot[], providerId: string,
  record: NearbyIncomingRecord, data: NearbyWireData, fingerprint: string, attachments: LocalItemAttachment[]): Promise<NearbyLocalMetadata> {
  const sameId = original.find(row => row.value.recordId === record.id);
  const bound = record.localId && original.find(row => row.value.localId === record.localId);
  const previous = bound || sameId;
  if (record.localId && (!bound || bound.guard !== record.expectedGuard || sameId && sameId !== bound)) invalidNearby('metadata-binding-changed');
  if (previous && !isNearbyTombstone(previous.data) && previous.data.entry_type !== data.entry_type) invalidNearby('metadata-type-changed');
  const localId = previous?.value.localId ?? `local:metadata-${record.id}`;
  const row: NearbyLocalMetadata = { version: 1, providerId, recordId: record.id, localId, dataJson: JSON.stringify(data), deleted: record.deleted,
    categoryKey: previous?.value.categoryKey, attachments: attachments.map(file => ({ ...file, itemId: localId })), fingerprint };
  if (data.entry_type === 'folder') {
    if (record.deleted) {
      if (row.categoryKey) state.localTransferFolders = (state.localTransferFolders ?? []).filter(folder => nearbyCategoryKey(folder) !== row.categoryKey);
    } else {
      for (const [index, node] of pathOf(data).entries()) {
        const leaf = index === pathOf(data).length - 1, origin = `nearby-folder:${node.id}`;
        const known = state.nearbyLocalMetadata?.find(entry => entry.recordId === node.id);
        const key = leaf ? row.categoryKey : known?.categoryKey;
        let folder = state.localTransferFolders?.find(folder => key ? nearbyCategoryKey(folder) === key : folder.origin === origin);
        if (!folder) {
          const id = categoryId(key) ?? nextNearbyCategoryId(state);
          folder = { origin, categoryId: id, categoryName: leaf ? data.title : node.title };
          state.localTransferFolders = [...(state.localTransferFolders ?? []), folder];
        } else if (leaf) folder.categoryName = data.title;
        if (leaf) row.categoryKey = nearbyCategoryKey(folder);
      }
    }
  }
  row.acknowledgement = { recordId: record.id, clockJson: record.clockJson, localId, scope: 'local', guard: '0'.repeat(64), dataJson: row.dataJson };
  // The caller computes the final guard after all category updates in this transaction.
  const values = (state.nearbyLocalMetadata ?? []).filter(value => value.localId !== localId && value.recordId !== record.id);
  state.nearbyLocalMetadata = [...values, row];
  return row;
}
