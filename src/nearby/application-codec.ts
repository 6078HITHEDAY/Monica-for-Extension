import type { VaultItem } from '../core/model';
import { cloneLosslessJson, parseLosslessJson } from '../core/lossless-json';
import { decodeMdbx2Object, encodeMdbx2Object } from '../providers/mdbx2/mdbx2-item-codec';
import type { Mdbx2ObjectRecord, Mdbx2ObjectUpsertInput } from '../providers/mdbx2/native-contract';
import { passkeyKeyMaterialHint } from '../passkey/private-key-portability';
import { API_TOKEN_METADATA_SCHEMA, decodeApiTokenMetadata } from '../core/api-token';
import { assertPasskeyCounterNotRegressed, preservePasskeyCounterHistory } from '../passkey/ownership-policy';
import { prepareNearbyPasskey, retainNearbyPasskey } from './passkey-material';
import { invalidNearby, NEARBY_ENTRY_TYPES, nearbyNativeBusinessPayload, nearbyNativePayload, normalizeNearbyNativeData,
  validateNearbyWireData, wireObject, type NearbyEntryType, type NearbyWireData } from './wire-shape';

/** Raw relationship/asset metadata from the authenticated source catalog. The
 * caller must retain this alongside the item projection and save attachments
 * before acknowledging adoption; a VaultItem alone is not a lossless record. */
export interface NearbyContentMetadata {
  folder?: string;
  folder_path?: unknown[];
  labels?: unknown[];
  relations?: unknown[];
  assets?: unknown[];
  password_history?: unknown[];
  trashed?: boolean;
}
const API_FIELDS = 'monica:api-token:fields:v1';
const API_FAVORITE = 'monica:api-token:favorite:v1';

function entryType(type: string): NearbyEntryType {
  const normalized = type === 'steam_mafile' ? 'steam-mafile' : type;
  if (!NEARBY_ENTRY_TYPES.includes(normalized as NearbyEntryType)) invalidNearby('unsupported-content-type');
  return normalized as NearbyEntryType;
}

async function preparePayload(source: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reference = source.key_status === 'reference' && !source.private_key_alias
    || passkeyKeyMaterialHint(source.private_key_alias) === 'device-reference';
  return prepareNearbyPasskey(source, reference);
}

export async function nearbyNativeObjectToWire(record: Mdbx2ObjectRecord, metadata: NearbyContentMetadata): Promise<NearbyWireData> {
  if (record.payloadSchemaVersion !== 1) invalidNearby('unsupported-content-version');
  const type = entryType(record.objectTypeId);
  let payload = nearbyNativeBusinessPayload(wireObject(parseLosslessJson(record.payloadJson)), type);
  // Native passwords can contain old installation-local encryption. Exporting
  // such a string as a password is not decryption and is never inferred here.
  if ((type === 'login' || type === 'ssh-key') && payload.monica_password_encoding != null && payload.monica_password_encoding !== 'plaintext-v1') invalidNearby('password-encoding');
  if (type === 'passkey') payload = await preparePayload(payload);
  const data = normalizeNearbyNativeData(payload, record.title, metadata.folder ?? '', type);
  for (const key of ['folder_path', 'labels', 'relations', 'assets', 'password_history', 'trashed'] as const) {
    if (metadata[key] !== undefined) data[key] = cloneLosslessJson(metadata[key]);
  }
  if (type === 'api-token') {
    if (record.apiTokenFavorite === undefined && metadata.labels === undefined) invalidNearby('api-token-catalog-required');
    const labels = (data.labels as Record<string, unknown>[] | undefined) ?? [];
    const fields = labels.filter(label => label.name === API_FIELDS);
    if (fields.length > 1 || record.apiTokenMetadataJson !== undefined && fields.some(label => label.payload !== record.apiTokenMetadataJson)) invalidNearby('api-token-catalog-conflict');
    if (record.apiTokenMetadataJson !== undefined && !fields.length) labels.push({ name: API_FIELDS, payload: record.apiTokenMetadataJson, version: 1 });
    if (record.apiTokenFavorite === false && labels.some(label => label.name === API_FAVORITE)) invalidNearby('api-token-catalog-conflict');
    if (record.apiTokenFavorite && !labels.some(label => label.name === API_FAVORITE)) labels.push({ name: API_FAVORITE, payload: '{"kind":"monica-api-token-favorites"}', version: 1 });
    data.labels = labels;
  }
  validateNearbyWireData(data);
  return data;
}

/** Maps a local editor item without reading a remote provider. Original wire
 * data and its original item projection preserve unknown fields on later edits. */
export async function nearbyLocalItemToWire(item: VaultItem, metadata: NearbyContentMetadata,
  previous?: { data: NearbyWireData; item: VaultItem }): Promise<NearbyWireData> {
  if (item.kind === 'opaque') invalidNearby('opaque-local-content');
  if (item.kind === 'passkey') assertPasskeyCounterNotRegressed(item);
  const old = previous ? nearbyNativePayload(previous.data, previous.item.id, null) : undefined;
  const encoded = encodeMdbx2Object(item, old, previous?.item);
  if (!encoded) invalidNearby('unsupported-local-content');
  const record: Mdbx2ObjectRecord = { objectId: item.id, collectionId: '', objectTypeId: encoded.objectTypeId,
    title: item.title, payloadSchemaVersion: 1, payloadJson: encoded.payloadJson, deleted: Boolean(item.deletedAt),
    apiTokenMetadataJson: encoded.apiTokenMetadataJson, apiTokenFavorite: encoded.apiTokenFavorite };
  // API token business payload and its Android companion metadata are separate.
  // Apply intentional editor changes before checking the native catalog. Passing
  // the old companion labels would incorrectly reject every subsequent edit.
  let currentMetadata = metadata;
  if (encoded.apiTokenMetadataJson !== undefined) {
    const previousLabels = cloneLosslessJson(metadata.labels ?? previous?.data.labels ?? []) as Record<string, unknown>[];
    if (!Array.isArray(previousLabels)) invalidNearby('api-token-metadata');
    previousLabels.forEach(wireObject);
    const fields = previousLabels.filter(label => label.name === API_FIELDS);
    const favorite = previousLabels.filter(label => label.name === API_FAVORITE);
    if (fields.length > 1 || favorite.length > 1 || fields.some(label => label.version !== 1 || typeof label.payload !== 'string' || !decodeApiTokenMetadata(label.payload))
      || favorite.some(label => label.version !== 1)) invalidNearby('api-token-metadata');
    const labels = previousLabels.filter(label => ![API_FIELDS, API_FAVORITE].includes(String(label.name)));
    labels.push({ ...fields[0], name: API_FIELDS, payload: encoded.apiTokenMetadataJson, version: 1 });
    if (item.favorite) labels.push({ ...favorite[0], name: API_FAVORITE, payload: favorite[0]?.payload ?? '{"kind":"monica-api-token-favorites"}', version: 1 });
    currentMetadata = { ...metadata, labels };
  }
  const data = await nearbyNativeObjectToWire(record, { ...currentMetadata, trashed: Boolean(item.deletedAt) });
  const result = previous ? { ...cloneLosslessJson(previous.data), ...data } : data;
  validateNearbyWireData(result);
  return result;
}

export interface NearbyNativeTarget {
  logicalId: string;
  collectionId?: string;
  expectedHeadCommitId?: string;
  previousPayload?: Record<string, unknown>;
}

/** Build a native write only after reference/folder resolution by the caller.
 * It is not an acknowledgement and performs no mutation. */
export async function nearbyWireToNativeObject(input: NearbyWireData, target: NearbyNativeTarget): Promise<Mdbx2ObjectUpsertInput> {
  validateNearbyWireData(input);
  if (!target.logicalId || target.logicalId.length > 512) invalidNearby('target-identity');
  if (input.entry_type === 'folder' || input.entry_type === 'vault-metadata') invalidNearby('metadata-requires-catalog');
  const data = cloneLosslessJson(input);
  if (data.entry_type === 'passkey') {
    const payload = wireObject(data.payload);
    data.payload = target.previousPayload ? await retainNearbyPasskey(payload, target.previousPayload) : await preparePayload(payload);
  }
  const result: Mdbx2ObjectUpsertInput = { logicalObjectId: target.logicalId, collectionId: target.collectionId, expectedHeadCommitId: target.expectedHeadCommitId,
    objectTypeId: data.entry_type, title: data.title, payloadSchemaVersion: 1,
    payloadJson: JSON.stringify(nearbyNativePayload(data, target.logicalId, target.collectionId ?? null, target.previousPayload)) };
  if (data.entry_type === 'api-token') {
    const labels = (data.labels as Record<string, unknown>[] | undefined) ?? [];
    const fields = labels.filter(label => label.name === API_FIELDS);
    if (fields.length > 1 || fields.some(label => label.version !== 1 || typeof label.payload !== 'string' || !decodeApiTokenMetadata(label.payload))) invalidNearby('api-token-metadata');
    result.payloadJson = JSON.stringify(data.payload);
    result.apiTokenMetadataJson = fields.length ? String(fields[0].payload) : JSON.stringify({ schema: API_TOKEN_METADATA_SCHEMA, notes: '', custom_fields: [] });
    result.apiTokenFavorite = labels.some(label => label.name === API_FAVORITE);
  }
  return result;
}

/** Projection for the actual local editor. `data` remains authoritative for
 * fields outside the editor and must be persisted by the adoption transaction. */
export async function nearbyWireToLocalItem(data: NearbyWireData, target: { id: string; providerId: string; now: string; previous?: VaultItem }): Promise<VaultItem> {
  if (!Number.isFinite(Date.parse(target.now))) invalidNearby('target-time');
  const previous = target.previous ? encodeMdbx2Object(target.previous) : undefined;
  const write = await nearbyWireToNativeObject(data, { logicalId: target.id, previousPayload: previous ? wireObject(parseLosslessJson(previous.payloadJson)) : undefined });
  const record: Mdbx2ObjectRecord = { objectId: target.id, collectionId: '', objectTypeId: write.objectTypeId,
    title: write.title, payloadJson: write.payloadJson, payloadSchemaVersion: 1, deleted: data.trashed === true };
  if (data.entry_type === 'api-token') {
    record.apiTokenMetadataJson = write.apiTokenMetadataJson; record.apiTokenFavorite = write.apiTokenFavorite;
  }
  const decoded = decodeMdbx2Object(record, { headCommitId: 'nearby-received', updatedAt: target.now }, target.providerId);
  if (!decoded.item || decoded.item.kind === 'opaque') invalidNearby('unsupported-local-projection');
  let item = decoded.item;
  if (item.kind === 'passkey' && target.previous?.kind === 'passkey') item = preservePasskeyCounterHistory(target.previous, item);
  item.id = target.id; item.providerRefs = [{ providerId: target.providerId }]; item.replicaGroupId = target.id;
  for (const field of ['mdbxFolderId', 'mdbxDatabaseId', 'keepassDatabaseId', 'keepassGroupPath', 'keepassEntryUuid', 'keepassGroupUuid', 'boundNoteId'] as const) delete item[field];
  return item;
}
