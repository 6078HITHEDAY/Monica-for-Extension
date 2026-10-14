import { cloneLosslessJson, parseLosslessJson } from '../core/lossless-json';
import type { Mdbx2ContentAttachment } from '../providers/mdbx2/content-attachments';
import { mdbx2TransferOperationScope as hash } from '../providers/mdbx2/mdbx2-transfer-identity';
import { nearbyNativeObjectToWire } from './application-codec';
import { NATIVE_FOLDER_TITLE, NATIVE_PROJECT_TAG, NATIVE_ROOT_TAGS, nearbyNativeFolderPaths, projectNearbyNativeMetadata } from './native-metadata';
import { nativeActive, type NearbyNativeSource } from './native-source';
import { invalidNearby, NearbyDataError, NEARBY_ENTRY_TYPES, nearbyNativeBusinessPayload, remapNearbyAssetPaths, validateNearbyWireData, wireObject, type NearbyEntryType, type NearbyWireData } from './wire-shape';

export interface NearbyNativeScanRecord { local_id: string; global_id: string; scope: string; guard: string; deleted: boolean; data: NearbyWireData | Record<string, never> }
export interface NearbyNativeProjection {
  sourceHash: string; scope: string; records: NearbyNativeScanRecord[];
  /** Lazy native attachment references. Read and hash-verify bytes only when the
   * transport requests them; do not allocate the complete vault in memory. */
  assets: Mdbx2ContentAttachment[];
  excluded: Array<{ id: string; reason: 'connector-owned' | 'staging' }>;
  blockers: Array<{ id: string; reason: string }>;
}
const byId = <T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> => {
  const result = new Map<string, T[]>(); for (const row of rows) { const id = key(row), values = result.get(id) ?? []; values.push(row); result.set(id, values); } return result;
};
const ordered = <T>(rows: readonly T[]) => [...rows].sort((a, b) => { const x = JSON.stringify(a), y = JSON.stringify(b); return x < y ? -1 : x > y ? 1 : 0; });

/** Converts supported native content, while returning explicit blockers for
 * content whose lossless archive/restore path is not integrated yet. The source
 * inventory retains every such row and its available original payload. */
export async function projectNearbyNativeRecords(input: NearbyNativeSource, signal?: AbortSignal): Promise<NearbyNativeProjection> {
  const source = cloneLosslessJson(input), scope = `mdbx:${source.providerId}`;
  nativeActive(signal);
  const metadata = await projectNearbyNativeMetadata(source); nativeActive(signal);
  const paths = nearbyNativeFolderPaths(source), labels = new Map(source.metadata.labels.map(row => [row.labelId, row]));
  const assignments = byId(source.metadata.assignments.filter(row => !row.deleted), row => row.objectId);
  const relations = byId(source.metadata.relations.filter(row => !row.deleted), row => row.sourceObjectId);
  const attachments = byId(source.attachments, row => row.objectId ?? `folder:${row.collectionId}`);
  const assets = new Map<string, Mdbx2ContentAttachment>();
  const result: NearbyNativeProjection = { sourceHash: source.sourceHash, scope, records: [], assets: [], excluded: [], blockers: [] };
  const recordIds = new Set<string>();
  const add = (row: NearbyNativeScanRecord) => {
    if (recordIds.has(row.global_id)) invalidNearby('native-record-identity-collision'); recordIds.add(row.global_id);
    result.records.push(row);
  };
  const withAssets = (input: NearbyWireData, rows: Mdbx2ContentAttachment[], payload: Record<string, unknown> = {}) => {
    const data = cloneLosslessJson(input), paths = new Map<string, string>();
    const saved = payload.device_sync_assets === undefined ? [] : payload.device_sync_assets;
    if (!Array.isArray(saved)) invalidNearby('native-asset-map');
    const savedById = byId(saved.map(wireObject), row => typeof row.local_id === 'string' ? row.local_id : '');
    const imageMap = payload.device_sync_images === undefined ? {} : wireObject(payload.device_sync_images);
    data.assets = [...rows].filter(row => !row.deleted).sort((a, b) => a.contentHash < b.contentHash ? -1 : a.contentHash > b.contentHash ? 1 : a.attachmentId < b.attachmentId ? -1 : 1).map(row => {
      if (row.originalSize !== row.storedSize || row.storedSize > 64 * 1024 * 1024) invalidNearby('native-asset-size');
      const previous = savedById.get(row.attachmentId) ?? [];
      if (previous.length > 1) invalidNearby('native-asset-map');
      const old = previous[0], descriptor: Record<string, unknown> = { ...old, id: row.contentHash, attachment_id: typeof old?.attachment_id === 'string' ? old.attachment_id : row.attachmentId,
        file_name: row.fileName, media_type: row.mediaType ?? 'application/octet-stream', size: row.storedSize };
      delete descriptor.local_id;
      for (const key of ['image', 'icon']) if (old?.[key] !== undefined) { if (typeof old[key] !== 'boolean') invalidNearby('native-asset-map'); descriptor[key] = old[key]; }
      const known = assets.get(row.contentHash); if (known && known.storedSize !== row.storedSize) invalidNearby('native-asset-conflict');
      assets.set(row.contentHash, known ?? row);
      paths.set(`mdbx:${row.attachmentId}`, `device-asset:${row.contentHash}`);
      if (typeof imageMap[row.contentHash] === 'string') paths.set(imageMap[row.contentHash] as string, `device-asset:${row.contentHash}`);
      return descriptor;
    });
    const uploaded = [wireObject(data.extensions ?? {})];
    const itemData = wireObject(data.payload ?? {}).item_data;
    if (typeof itemData === 'string' && itemData.startsWith('{')) uploaded.push(wireObject(parseLosslessJson(itemData)));
    for (const item of uploaded) {
      const value = item.custom_icon_type === 'UPLOADED' ? item.custom_icon_value : item.customIconType === 'UPLOADED' ? item.customIconValue : undefined;
      if (typeof value === 'string' && value && !paths.has(value) && !rows.some(row => !row.deleted && value === `device-asset:${row.contentHash}`)) invalidNearby('native-icon-asset-unavailable');
    }
    const output = remapNearbyAssetPaths(data, path => {
      const found = paths.get(path); if (found) return found;
      if (path.startsWith('mdbx:') || /^(?:file:|content:|[A-Za-z]:[\\/]|\/)/.test(path)) invalidNearby('native-asset-reference-unavailable');
      if (path.startsWith('device-asset:') && !rows.some(row => !row.deleted && `device-asset:${row.contentHash}` === path)) invalidNearby('native-asset-reference-unavailable');
      return path;
    });
    validateNearbyWireData(output); return output;
  };
  for (const row of metadata) {
    let data = row.data;
    if (Object.keys(data).length && row.kind === 'folder') data = withAssets(data as NearbyWireData, attachments.get(`folder:${row.id}`) ?? []);
    add({ local_id: row.localId, global_id: row.id, scope, guard: row.guard, deleted: row.deleted, data });
    if (row.kind === 'folder' && (attachments.get(`folder:${row.id}`) ?? []).some(file => !file.deleted)) result.blockers.push({ id: row.id, reason: 'native-folder-assets-adoption-required' });
    if (row.kind === 'root' && Array.isArray(data.assets) && data.assets.length) result.blockers.push({ id: row.id, reason: 'native-root-metadata-assets-unavailable' });
  }
  if ((attachments.get(`folder:${source.rootId}`) ?? []).some(row => !row.deleted)) result.blockers.push({ id: source.rootId, reason: 'native-root-assets-adoption-required' });
  const objectIds = new Set(source.objects.map(row => row.summary.objectId));
  for (const attachment of source.attachments) if (!attachment.deleted && attachment.objectId !== null && !objectIds.has(attachment.objectId)) result.blockers.push({ id: attachment.attachmentId, reason: 'native-orphan-attachment' });
  for (const collection of source.collections) if (collection.favorite || collection.archived || collection.iconRef || (collection.profileSchemaVersion ?? 1) !== 1) result.blockers.push({ id: collection.collectionId, reason: 'native-folder-profile-archive-required' });
  for (const object of source.objects) {
    nativeActive(signal); const id = object.summary.objectId;
    if (!object.record) { result.blockers.push({ id, reason: 'deleted-content-unavailable' }); continue; }
    try {
      const record = object.record, type = (record.objectTypeId === 'steam_mafile' ? 'steam-mafile' : record.objectTypeId) as NearbyEntryType;
      if (!NEARBY_ENTRY_TYPES.includes(type) || ['folder', 'vault-metadata'].includes(type) || record.payloadSchemaVersion !== 1) invalidNearby('unsupported-native-content');
      const payload = nearbyNativeBusinessPayload(wireObject(parseLosslessJson(record.payloadJson)), type);
      if (payload.device_sync_staging === true) { result.excluded.push({ id, reason: 'staging' }); continue; }
      if (payload.bitwarden_mode === true || payload.keepass_mode === true) { result.excluded.push({ id, reason: 'connector-owned' }); continue; }
      const ownLabels = (assignments.get(id) ?? []).map(row => {
        const label = labels.get(row.labelId); if (!label || label.deleted || label.payloadJson === null) invalidNearby('native-assignment-unavailable');
        return { name: label.name, payload: label.payloadJson, version: label.payloadSchemaVersion };
      });
      const ownRelations = (relations.get(id) ?? []).map(row => {
        if (row.payloadJson === null) invalidNearby('native-relation-unavailable');
        return { target: row.targetObjectId, kind: row.relationKind, payload: row.payloadJson, version: row.payloadSchemaVersion };
      });
      const path = paths.get(record.collectionId); if (!path) invalidNearby('native-owner-unavailable');
      const data = await nearbyNativeObjectToWire(record, { folder: path[path.length - 1]?.title ?? '', folder_path: path,
        labels: ordered(ownLabels), relations: payload.device_sync_pending_relations === undefined ? ordered(ownRelations) : payload.device_sync_pending_relations as unknown[], trashed: false });
      nativeActive(signal);
      const files = attachments.get(id) ?? [], output = withAssets(data, files, payload);
      const guard = await hash({ summary: object.summary, labels: ownLabels, assignments: assignments.get(id) ?? [], relations: relations.get(id) ?? [], attachments: files });
      add({ local_id: `${scope}:${id}`, global_id: id, scope, guard, deleted: false, data: output });
    } catch (error) {
      if (!(error instanceof NearbyDataError)) throw error;
      result.blockers.push({ id, reason: error.code });
    }
  }
  const assigned = new Set(source.metadata.assignments.filter(row => !row.deleted).map(row => row.labelId));
  for (const label of source.metadata.labels) if (!label.deleted && !assigned.has(label.labelId)) {
    let kind: unknown; try { kind = wireObject(parseLosslessJson(label.payloadJson!)).kind; } catch { /* retained opaque metadata */ }
    if (kind !== NATIVE_PROJECT_TAG && kind !== NATIVE_FOLDER_TITLE && !(kind === NATIVE_ROOT_TAGS && label.collectionId === source.rootId)) result.blockers.push({ id: label.labelId, reason: 'unassigned-native-label-archive-required' });
  }
  nativeActive(signal); result.assets = [...assets.values()]; return result;
}

/** Mandatory before giving records to replica_scan_begin/batch/end. An omitted
 * source row would otherwise become a destructive remote deletion. */
export function requireCompleteNearbyNativeProjection(value: NearbyNativeProjection): NearbyNativeProjection {
  if (value.blockers.length) invalidNearby('native-projection-incomplete'); return value;
}
