import { cloneLosslessJson, parseLosslessJson } from '../core/lossless-json';
import { base64ToBytes, bytesToBase64 } from '../security/encoding';
import { mdbx2TransferUuid } from '../providers/mdbx2/mdbx2-transfer-identity';
import type { Mdbx2ContentCommand, Mdbx2ContentWriteInput } from '../providers/mdbx2/content-write';
import { nearbyWireToNativeObject } from './application-codec';
import type { NearbyIncomingRecord } from './local-adoption';
import { NATIVE_FOLDER_TITLE, NATIVE_PROJECT_TAG, NATIVE_ROOT_TAGS, planNearbyNativeMetadata, projectNearbyNativeMetadata, type NearbyNativeMetadataChange } from './native-metadata';
import { projectNearbyNativeRecords } from './native-records';
import { nativeActive, nativeId, nearbyJavaNameUuid, type NearbyNativeSource } from './native-source';
import { invalidNearby, nearbyNativeBusinessPayload, remapNearbyAssetPaths, remapNearbyReferences, validateNearbyWireData,
  wireInteger, wireObject, type NearbyWireData } from './wire-shape';

export interface NearbyNativeBatch {
  operationId: string; sourceHash: string; records: readonly NearbyIncomingRecord[];
  /** Resolved by the authenticated replica, never guessed from titles. */
  references?: readonly { id: string; localId: string }[];
  assets: readonly { id: string; dataBase64: string }[];
}
export interface NearbyNativeAdoption {
  providerId: string; vaultHandle: string; sourceHash: string;
  /** Keep this exact operation for uncertain-outcome recovery. */
  write: Mdbx2ContentWriteInput;
  bindings: { recordId: string; clockJson: string; localId: string; deleted: boolean; dataJson: string }[];
}
const identity = /^[A-Za-z0-9_-]{1,64}$/, digest = /^[a-f0-9]{64}$/;
const order = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const rows = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value)) invalidNearby('native-adoption-array'); return value.map(wireObject);
};
function exactFields(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).some(key => !fields.includes(key))) invalidNearby('native-record-archive-required');
}
function validateClock(text: string): void {
  if (typeof text !== 'string' || text.length > 64 * 1024) invalidNearby('native-clock');
  const clock = wireObject(parseLosslessJson(text)), entries = Object.entries(clock);
  if (!entries.length || entries.length > 1024) invalidNearby('native-clock');
  for (const [id, count] of entries) { if (!identity.test(id)) invalidNearby('native-clock'); wireInteger(count, (1n << 64n) - 1n); }
}
/** A prepared batch contains plaintext only in owned memory. Call after commit,
 * cancellation or durable encrypted staging; never clear caller-owned buffers. */
export function clearNearbyNativeAdoption(plan: NearbyNativeAdoption): void { for (const asset of plan.write.assets) asset.bytes.fill(0); }

/** Pure adoption planning. It validates the complete batch before any native
 * mutation. The caller must durably retain the exact intent before writing and
 * save verified acknowledgements before acknowledging the transport. */
export async function planNearbyNativeAdoption(input: NearbyNativeSource, incoming: NearbyNativeBatch, signal?: AbortSignal): Promise<NearbyNativeAdoption> {
  if (!Array.isArray(incoming.assets) || incoming.assets.length > 64 || !Array.isArray(incoming.records) || incoming.records.length > 128
    || incoming.references !== undefined && (!Array.isArray(incoming.references) || incoming.references.length > 10_000)) invalidNearby('native-adoption-limit');
  let encodedBytes = 0;
  for (const asset of incoming.assets) {
    if (typeof asset.dataBase64 !== 'string') invalidNearby('native-adoption-assets');
    encodedBytes += asset.dataBase64.length; if (encodedBytes > 90 * 1024 * 1024) invalidNearby('native-asset-limit');
  }
  const source = cloneLosslessJson(input), batch = cloneLosslessJson(incoming), operation = nativeId(batch.operationId), scope = `mdbx:${source.providerId}`;
  nativeActive(signal);
  if (batch.sourceHash !== source.sourceHash) invalidNearby('native-source-changed');
  if (!Array.isArray(batch.records) || !batch.records.length || batch.records.length > 128 || !Array.isArray(batch.assets) || batch.assets.length > 64) invalidNearby('native-adoption-limit');
  const projection = await projectNearbyNativeRecords(source, signal), existing = new Map(projection.records.map(row => [row.local_id, row]));
  const summaries = new Map(source.objects.map(row => [row.summary.objectId, row]));
  const metadata = new Map((await projectNearbyNativeMetadata(source)).map(row => [row.id, row]));
  nativeActive(signal);
  const ids = new Set<string>(), targets = new Set<string>(), mapping = new Map<string, string>();
  const consumedPurges: string[] = [];
  const work: { record: NearbyIncomingRecord; id: string; kind: 'object' | 'folder' | 'root'; data: NearbyWireData; tombstone: boolean; localId: string }[] = [];
  for (const record of [...batch.records].sort(order)) {
    if (!identity.test(record.id) || ids.has(record.id) || typeof record.deleted !== 'boolean' || typeof record.dataJson !== 'string' || record.dataJson.length > 1024 * 1024) invalidNearby('native-adoption-record');
    ids.add(record.id); validateClock(record.clockJson);
    const data = wireObject(parseLosslessJson(record.dataJson)) as NearbyWireData, tombstone = record.deleted && Object.keys(data).length === 0;
    if (!tombstone) { validateNearbyWireData(data); if (record.deleted !== (data.trashed === true)) { if (record.deleted) invalidNearby('native-trash-payload'); if (data.trashed === true) invalidNearby('native-trash-state'); } }
    const bound = record.localId !== undefined || record.scope !== undefined || record.expectedGuard !== undefined;
    let localId: string, id: string, kind: 'object' | 'folder' | 'root';
    if (bound) {
      if (typeof record.localId !== 'string' || !record.localId.startsWith(`${scope}:`) || record.scope !== scope || !digest.test(record.expectedGuard ?? '')) invalidNearby('native-adoption-binding');
      localId = record.localId; const old = existing.get(localId);
      if (!old || old.guard !== record.expectedGuard) invalidNearby('native-binding-changed');
      const suffix = localId.slice(scope.length + 1);
      kind = suffix.startsWith('metadata:') ? 'root' : suffix.startsWith('folder:') ? 'folder' : 'object';
      id = suffix.slice(kind === 'root' ? 9 : kind === 'folder' ? 7 : 0);
      if (kind === 'root' && old.deleted && Object.keys(old.data).length === 0 && !tombstone && data.entry_type !== 'vault-metadata') {
        // First-seen purges live in Android-compatible root metadata. Consume
        // that marker atomically when real content later arrives, without ever
        // inventing an object type or changing an existing native object's type.
        const marker=source.metadata.labels.find(label=>!label.deleted && label.collectionId===source.rootId && label.payloadJson!==null && (()=>{try{const p=wireObject(parseLosslessJson(label.payloadJson!));return p.kind===NATIVE_ROOT_TAGS && p.owner===id;}catch{return false;}})());
        if(!marker)invalidNearby('native-purge-marker-missing');consumedPurges.push(marker.labelId);
        kind=data.entry_type==='folder'?'folder':'object';
        id=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(record.id)?record.id:await mdbx2TransferUuid(source.rootId,`nearby-record:${record.id}`);
        if(summaries.has(id)||source.collections.some(row=>row.collectionId===id))invalidNearby('native-identity-collision');
        localId=`${scope}:${kind==='folder'?'folder:':''}${id}`;
      }
    } else {
      kind = tombstone || data.entry_type === 'vault-metadata' ? 'root' : data.entry_type === 'folder' ? 'folder' : 'object';
      id = kind === 'root' ? record.id : /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(record.id) ? record.id : await mdbx2TransferUuid(source.rootId, `nearby-record:${record.id}`);
      localId = `${scope}:${kind === 'root' ? 'metadata:' : kind === 'folder' ? 'folder:' : ''}${id}`;
      if (summaries.has(id) || metadata.has(id) || source.collections.some(row => row.collectionId === id)) invalidNearby('native-identity-collision');
    }
    if (!tombstone && (kind === 'folder' ? data.entry_type !== 'folder' : kind === 'root' ? data.entry_type !== 'vault-metadata' : ['folder', 'vault-metadata'].includes(data.entry_type))) invalidNearby('native-object-type-changed');
    if (targets.has(id)) invalidNearby('native-target-collision'); targets.add(id); mapping.set(record.id, id);
    work.push({ record, id, kind, data, tombstone, localId });
  }
  for (const reference of batch.references ?? []) {
    if (!identity.test(reference.id) || !reference.localId.startsWith(`${scope}:`)) invalidNearby('native-reference-binding');
    const id = reference.localId.slice(scope.length + 1);
    if (!summaries.has(id) || !existing.has(reference.localId) || mapping.has(reference.id) && mapping.get(reference.id) !== id) invalidNearby('native-reference-unavailable');
    mapping.set(reference.id, id);
  }
  const resolve = (id: string): string => {
    const found = mapping.get(id); if (found) return found;
    if (summaries.has(id) && existing.has(`${scope}:${id}`) || source.collections.some(row => row.collectionId === id)) return id;
    if (/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) return id; // New folder identities are checked separately below.
    return invalidNearby('native-reference-unavailable');
  };
  for (const row of work) if (!row.tombstone) row.data = remapNearbyReferences(row.data, resolve);
  for (const row of work.filter(row => row.kind === 'object' && !row.tombstone)) for (const node of [row.data, row.data.payload, row.data.extensions]) {
    if (node === undefined) continue;
    for (const field of ['bound_password_entry_id', 'bound_note_entry_id', 'sso_ref_entry_id']) {
      const target = wireObject(node)[field];
      if (typeof target === 'string' && identity.test(target) && !work.some(row => row.id === target && row.kind === 'object' && !row.record.deleted)
        && (!summaries.has(target) || !existing.has(`${scope}:${target}`) || work.some(row => row.id === target && row.record.deleted))) invalidNearby('native-reference-unavailable');
    }
  }
  const metaChanges = new Map<string, NearbyNativeMetadataChange>();
  for (const row of work.filter(row => row.kind !== 'object')) metaChanges.set(row.id, { kind: row.kind as 'folder' | 'root', id: row.id,
    expectedGuard: row.localId===row.record.localId ? row.record.expectedGuard ?? null : null, deleted: row.record.deleted, data: row.data });
  const ownerById = new Map<string, string>();
  for (const row of work.filter(row => row.kind === 'object' && !row.tombstone)) {
    const path = row.data.folder_path === undefined ? [] : rows(row.data.folder_path);
    if (!path.length && row.data.folder) {
      // Match Android's legacy deterministic name identity. Do not guess between
      // duplicate titles or silently attach content to a nested namesake.
      const candidates = source.collections.filter(c=>!c.deleted && c.collectionId!==source.rootId && (!c.groupId || c.groupId===source.rootId) && c.title===row.data.folder);
      if(candidates.length>1)invalidNearby('native-folder-title-ambiguous');
      path.push({id:candidates[0]?.collectionId ?? await nearbyJavaNameUuid(`device-folder:${source.rootId}:${row.data.folder}`),title:row.data.folder,parent:null});
      row.data.folder_path=path;
    }
    let parent: string | null = null;
    for (let index = 0; index < path.length; index++) {
      const node = path[index], id = nativeId(node.id);
      if (id === source.rootId || node.parent !== parent) invalidNearby('native-folder-path');
      exactFields(node, ['id', 'title', 'parent']);
      if (!source.collections.some(folder => folder.collectionId === id)) {
        const data: NearbyWireData = { title: node.title as string, folder: '', entry_type: 'folder', payload: { path: path.slice(0, index + 1), tags: [] } };
        const old = metaChanges.get(id);
        if (old && (old.kind !== 'folder' || old.deleted || old.data.title !== node.title)) invalidNearby('native-folder-path-conflict');
        if (!old) metaChanges.set(id, { kind: 'folder', id, expectedGuard: null, deleted: false, data });
      } else if (source.collections.find(folder => folder.collectionId === id)!.deleted && !metaChanges.has(id)) invalidNearby('native-folder-deleted');
      parent = id;
    }
    ownerById.set(row.id, parent ?? source.rootId);
  }
  const metadataSource = consumedPurges.length ? { ...source, metadata: { ...source.metadata, labels: source.metadata.labels.filter(label=>!consumedPurges.includes(label.labelId)) } } : source;
  const commands: Mdbx2ContentCommand[] = await planNearbyNativeMetadata(metadataSource, operation, [...metaChanges.values()]);
  commands.push(...consumedPurges.map(labelId=>({kind:'label-delete' as const,labelId})));
  if (!source.collections.some(row => row.collectionId === source.rootId) && !commands.some(row => row.kind === 'collection-create' && row.collectionId === source.rootId) && work.some(row => row.kind === 'object')) commands.unshift({ kind: 'collection-create', collectionId: source.rootId, title: '.monica-root', parentId: null });
  const late: Mdbx2ContentCommand[] = [], fileCommands: Mdbx2ContentWriteInput['plan']['attachments'][number][] = [], buffers: { id: string; bytes: Uint8Array }[] = [];
  const supplied = new Map<string, string>(), loaded = new Map<string, { id: string; bytes: Uint8Array }>();
  let total = 0, copies = 0;
  for (const asset of batch.assets) {
    if (!digest.test(asset.id) || supplied.has(asset.id) || typeof asset.dataBase64 !== 'string' || asset.dataBase64.length > 90 * 1024 * 1024) invalidNearby('native-adoption-assets');
    supplied.set(asset.id, asset.dataBase64);
  }
  const load = async (hash: string, size: number) => {
    let value = loaded.get(hash);
    if (!value) {
      const text = supplied.get(hash); if (text === undefined) invalidNearby('native-asset-unavailable');
      const bytes = base64ToBytes(text); buffers.push({ id: '', bytes }); total += bytes.length;
      if (bytesToBase64(bytes) !== text || total > 64 * 1024 * 1024 || bytes.length !== size) invalidNearby('native-asset-size');
      const checksum = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)); nativeActive(signal);
      if ([...checksum].map(n => n.toString(16).padStart(2, '0')).join('') !== hash) invalidNearby('native-asset-hash');
      value = buffers[buffers.length - 1]; value.id = await mdbx2TransferUuid(operation, `asset:${hash}`); loaded.set(hash, value);
    }
    if (value.bytes.length !== size) invalidNearby('native-asset-size');
    copies += size; if (copies > 64 * 1024 * 1024) invalidNearby('native-asset-limit'); return value.id;
  };
  try {
    for (const row of work.filter(row => row.kind === 'object')) {
      nativeActive(signal);
      const previous = summaries.get(row.id), before = previous?.summary;
      if (before && !previous?.record) invalidNearby('deleted-content-unavailable');
      const oldPayload = previous?.record ? wireObject(parseLosslessJson(previous.record.payloadJson)) : undefined;
      if (before && !row.tombstone && (before.objectTypeId === 'steam_mafile' ? 'steam-mafile' : before.objectTypeId) !== row.data.entry_type) invalidNearby('native-object-type-changed');
      const files = source.attachments.filter(file => file.objectId === row.id && !file.deleted), assignments = source.metadata.assignments.filter(a => a.objectId === row.id && !a.deleted);
      const relations = source.metadata.relations.filter(r => r.sourceObjectId === row.id && !r.deleted);
      if (before?.deleted) commands.push({kind:'object-restore',objectId:row.id,collectionId:before.collectionId});
      if (row.tombstone) {
        if (!before) invalidNearby('native-tombstone-target-missing');
        const empty: Record<string, unknown> = { kind: ['login', 'ssh-key'].includes(before.objectTypeId) ? 'password' : before.objectTypeId, password_plain: '', item_data: '', deleted_at: 0, monica_entry_id: row.id };
        if (before.objectTypeId === 'passkey') { empty.credential_id = oldPayload!.credential_id; empty.rp_id = oldPayload!.rp_id; }
        commands.push({ kind: 'object-update', objectId: row.id, collectionId: before.collectionId, objectTypeId: before.objectTypeId, title: before.title, payloadJson: JSON.stringify(empty) });
        assignments.forEach(a => late.push({ kind: 'label-unassign', assignmentId: a.assignmentId })); relations.forEach(r => late.push({ kind: 'relation-delete', relationId: r.relationId }));
        files.forEach(file => fileCommands.push({ kind: 'delete', attachmentId: file.attachmentId })); late.push({ kind: 'object-delete', objectId: row.id, collectionId: before.collectionId }); continue;
      }
      const data = row.data, owner = ownerById.get(row.id)!;
      // Labels are collection-owned. A move with omitted metadata preserves the
      // assignments by recreating their exact label payloads in the new owner.
      if (data.labels === undefined && before && before.collectionId !== owner) data.labels = assignments.map(a => {
        const label = source.metadata.labels.find(label => label.labelId === a.labelId && !label.deleted);
        if (!label || label.payloadJson === null) invalidNearby('native-assignment-unavailable');
        return { name: label.name, payload: label.payloadJson, version: label.payloadSchemaVersion };
      });
      const raw = oldPayload ? nearbyNativeBusinessPayload(oldPayload, data.entry_type) : {};
      const saved = rows(raw.device_sync_assets ?? []), descriptors = data.assets === undefined ? undefined : rows(data.assets);
      if (descriptors && descriptors.length > 64) invalidNearby('native-asset-limit');
      const kept = new Set<string>(), stored: Record<string, unknown>[] = [], paths = new Map<string, string>();
      for (let index = 0; index < (descriptors?.length ?? 0); index++) {
        const descriptor = descriptors![index], hash = descriptor.id as string, size = Number(wireInteger(descriptor.size, 64n * 1024n * 1024n));
        for (const flag of ['image', 'icon']) if (descriptor[flag] !== undefined && typeof descriptor[flag] !== 'boolean') invalidNearby('native-asset-map');
        const original = saved.find(old => typeof descriptor.attachment_id === 'string' && old.attachment_id === descriptor.attachment_id);
        const file = files.find(file => !kept.has(file.attachmentId) && file.attachmentId === original?.local_id)
          ?? files.find(file => !kept.has(file.attachmentId) && file.contentHash === hash && file.fileName === descriptor.file_name && file.storedSize === size);
        const id = file?.attachmentId ?? await mdbx2TransferUuid(operation, `attachment:${row.id}:${index}`); kept.add(id);
        if (!file) fileCommands.push({ kind: 'create', attachmentId: id, collectionId: owner, objectId: row.id, fileName: descriptor.file_name as string, mediaType: descriptor.media_type as string, assetId: await load(hash, size) });
        else {
          if (file.contentHash !== hash || file.storedSize !== size) fileCommands.push({ kind: 'replace', attachmentId: id, assetId: await load(hash, size) });
          if (file.fileName !== descriptor.file_name || file.mediaType !== descriptor.media_type) fileCommands.push({ kind: 'rename', attachmentId: id, fileName: descriptor.file_name as string, mediaType: descriptor.media_type as string });
        }
        stored.push({ ...descriptor, local_id: id }); paths.set(`device-asset:${hash}`, `mdbx:${id}`);
      }
      if (descriptors) { for (const file of files) if (!kept.has(file.attachmentId)) fileCommands.push({ kind: 'delete', attachmentId: file.attachmentId }); }
      else { for (const file of files) paths.set(`device-asset:${file.contentHash}`, `mdbx:${file.attachmentId}`); }
      const remapped = remapNearbyAssetPaths(data, path => {
        if (paths.has(path)) return paths.get(path)!;
        if (path.startsWith('device-asset:') || /^(?:mdbx:|file:|content:|[A-Za-z]:[\\/]|\/)/.test(path)) invalidNearby('native-asset-reference-unavailable'); return path;
      });
      const encoded = await nearbyWireToNativeObject(remapped, { logicalId: row.id, collectionId: owner, previousPayload: oldPayload }); nativeActive(signal);
      const payload = wireObject(parseLosslessJson(encoded.payloadJson));
      if (descriptors) { payload.device_sync_assets = stored; payload.device_sync_images = {}; }
      else for (const key of ['device_sync_assets', 'device_sync_images']) if (raw[key] !== undefined) payload[key] = cloneLosslessJson(raw[key]);
      if (before && before.collectionId !== owner) commands.push({ kind: 'object-move', objectId: row.id, collectionId: before.collectionId, targetCollectionId: owner });
      commands.push({ kind: before ? 'object-update' : 'object-create', objectId: row.id, collectionId: owner, objectTypeId: encoded.objectTypeId, title: encoded.title, payloadJson: JSON.stringify(payload) });
      if (data.labels !== undefined) {
        const keptAssignments = new Set<string>();
        for (const [index, label] of rows(data.labels).entries()) {
          exactFields(label, ['name', 'payload', 'version']);
          const match = assignments.find(a => !keptAssignments.has(a.assignmentId) && source.metadata.labels.some(l => l.labelId === a.labelId && !l.deleted && l.collectionId === owner && l.name === label.name && l.payloadJson === label.payload && l.payloadSchemaVersion === Number(wireInteger(label.version, 0xffff_ffffn))));
          if (match) { keptAssignments.add(match.assignmentId); continue; }
          const labelId = await mdbx2TransferUuid(operation, `label:${row.id}:${index}`);
          late.push({ kind: 'label-create', labelId, collectionId: owner, name: label.name as string, payloadJson: label.payload as string, payloadSchemaVersion: Number(wireInteger(label.version, 0xffff_ffffn)) },
            { kind: 'label-assign', labelId, objectId: row.id, assignmentId: await mdbx2TransferUuid(operation, `assignment:${row.id}:${index}`) });
        }
        assignments.filter(a => !keptAssignments.has(a.assignmentId)).forEach(a => late.push({ kind: 'label-unassign', assignmentId: a.assignmentId }));
      }
      if (data.relations !== undefined) {
        relations.forEach(r => late.push({ kind: 'relation-delete', relationId: r.relationId }));
        for (const [index, relation] of rows(data.relations).entries()) {
          exactFields(relation, ['target', 'kind', 'payload', 'version']); const target = nativeId(relation.target);
          if (!work.some(row => row.id === target && row.kind === 'object' && !row.record.deleted) && (!summaries.has(target) || !existing.has(`${scope}:${target}`) || work.some(row => row.id === target && row.record.deleted))) invalidNearby('native-reference-unavailable');
          late.push({ kind: 'relation-create', relationId: await mdbx2TransferUuid(operation, `relation:${row.id}:${index}`), sourceObjectId: row.id, targetObjectId: target,
            relationKind: relation.kind as string, payloadJson: relation.payload as string, payloadSchemaVersion: Number(wireInteger(relation.version, 0xffff_ffffn)) });
        }
      } else if (raw.device_sync_pending_relations !== undefined) invalidNearby('native-relations-required');
      if (row.record.deleted) late.push({ kind: 'object-delete', objectId: row.id, collectionId: owner });
    }
    const removedAssignments = new Set(late.filter(row => row.kind === 'label-unassign').map(row => row.assignmentId));
    const removedLabels = new Set(source.metadata.assignments.filter(row => removedAssignments.has(row.assignmentId)).map(row => row.labelId));
    for (const id of removedLabels) {
      if (source.metadata.assignments.some(row => row.labelId === id && !row.deleted && !removedAssignments.has(row.assignmentId))) continue;
      const label = source.metadata.labels.find(row => row.labelId === id && !row.deleted); if (!label) continue;
      let kind: unknown;
      try { kind = wireObject(parseLosslessJson(label.payloadJson!)).kind; } catch { /* Opaque labels retain their own payload until explicitly replaced. */ }
      if ([NATIVE_PROJECT_TAG, NATIVE_ROOT_TAGS, NATIVE_FOLDER_TITLE].includes(kind as string)) continue;
      if (![...commands, ...late].some(row => row.kind === 'label-delete' && row.labelId === id)) late.push({ kind: 'label-delete', labelId: id });
    }
    const folderDeletes = commands.filter(row => row.kind === 'collection-delete');
    const finalCommands = [...commands.filter(row => row.kind !== 'collection-delete'), ...late, ...folderDeletes]; nativeActive(signal);
    const usedIds = new Set([...source.collections.map(row => row.collectionId), ...summaries.keys(), ...source.metadata.labels.map(row => row.labelId),
      ...source.metadata.assignments.map(row => row.assignmentId), ...source.metadata.relations.map(row => row.relationId), ...source.attachments.map(row => row.attachmentId)]);
    for (const command of [...finalCommands, ...fileCommands]) if (command.kind.endsWith('-create') || command.kind === 'create' || command.kind === 'label-assign') {
      const id = 'attachmentId' in command ? command.attachmentId : command.kind === 'collection-create' ? command.collectionId
        : command.kind === 'object-create' ? command.objectId : command.kind === 'label-create' ? command.labelId : command.kind === 'label-assign' ? command.assignmentId
          : command.kind === 'relation-create' ? command.relationId : undefined;
      if (!id || usedIds.has(id)) invalidNearby('native-created-identity-collision'); usedIds.add(id);
    }
    if (finalCommands.length > 128 || fileCommands.length > 64 || new TextEncoder().encode(JSON.stringify({ commands: finalCommands, attachments: fileCommands })).length > 8 * 1024 * 1024) invalidNearby('native-adoption-limit');
    return { providerId: source.providerId, vaultHandle: source.vaultHandle, sourceHash: source.sourceHash,
      write: { operationId: operation, writeRevision: { ...source.writeRevision }, plan: { commands: finalCommands, attachments: fileCommands }, assets: buffers },
      bindings: work.map(row => ({ recordId: row.record.id, clockJson: row.record.clockJson, localId: row.localId, deleted: row.record.deleted, dataJson: row.record.dataJson })) };
  } catch (error) { buffers.forEach(asset => asset.bytes.fill(0)); throw error; }
}
