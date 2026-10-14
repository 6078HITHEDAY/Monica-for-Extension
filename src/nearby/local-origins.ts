import type { ProviderSourceRecord, VaultState } from '../core/model';
import { cloneLosslessJson } from '../core/lossless-json';
import { invalidNearby, validateNearbyWireData, wireObject, type NearbyWireData } from './wire-shape';

/** Android preserves labels with the encrypted content. These are immutable
 * archives, never live provider references or inputs to credential discovery. */
export const NEARBY_LOCAL_ORIGINS_LABEL = 'monica:extension-local-origins:v1';
const schema = 'monica-extension-local-origins';
const maximumBytes = 1024 * 1024;
const fields = new Set(['providerId', 'itemId', 'remoteId', 'revision', 'format', 'encoding', 'payload', 'contentHash']);
const bounded = (value: unknown, maximum: number, empty = false): value is string => typeof value === 'string'
  && (empty || value.length > 0) && value.length <= maximum;

function records(value: unknown): ProviderSourceRecord[] {
  if (!Array.isArray(value) || value.length > 1024) invalidNearby('origin-records');
  for (const raw of value) {
    const row = wireObject(raw);
    if (Object.keys(row).some(key => !fields.has(key))
      || !bounded(row.providerId, 4096) || !bounded(row.remoteId, 4096) || !bounded(row.contentHash, 4096)
      || !bounded(row.format, 64) || !bounded(row.encoding, 64) || !bounded(row.payload, maximumBytes, true)
      || row.itemId !== undefined && !bounded(row.itemId, 4096) || row.revision !== undefined && !bounded(row.revision, 4096)) invalidNearby('origin-record');
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > maximumBytes) invalidNearby('origin-limit');
  return structuredClone(value) as ProviderSourceRecord[];
}

/** Complete descriptor + opaque payload establish identity. Hash/revision from
 * the original provider alone must not collapse two distinct archived values. */
export function mergeNearbyOrigins(...groups: readonly ProviderSourceRecord[][]): ProviderSourceRecord[] {
  const entries = new Map<string, ProviderSourceRecord>();
  for (const group of groups) for (const row of records(group)) {
    const key = JSON.stringify(Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
    entries.set(key, row);
  }
  return records([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, row]) => row));
}

export function nearbyLocalOriginIndex(state: VaultState): Map<string, ProviderSourceRecord[]> {
  if (state.localItemOrigins !== undefined && (!Array.isArray(state.localItemOrigins) || state.localItemOrigins.length > 20_000)) invalidNearby('origin-list');
  const groups = new Map<string, ProviderSourceRecord[][]>();
  for (const value of state.localItemOrigins ?? []) {
    const row = wireObject(value);
    if (!bounded(row.itemId, 4096) || Object.keys(row).some(key => !['itemId', 'records'].includes(key))) invalidNearby('origin-owner');
    const list = groups.get(row.itemId) ?? []; list.push(records(row.records)); groups.set(row.itemId, list);
  }
  return new Map([...groups].map(([id, rows]) => [id, mergeNearbyOrigins(...rows)]));
}

export function nearbyLocalOrigins(state: VaultState, itemId: string): ProviderSourceRecord[] {
  return nearbyLocalOriginIndex(state).get(itemId) ?? [];
}

function archiveLabel(data: NearbyWireData): Record<string, unknown> | undefined {
  if (data.labels === undefined) return undefined;
  if (!Array.isArray(data.labels)) invalidNearby('origin-label');
  const labels = data.labels.map(wireObject).filter(row => typeof row.name === 'string' && row.name.startsWith('monica:extension-local-origins:'));
  if (labels.length > 1 || labels.some(row => row.name !== NEARBY_LOCAL_ORIGINS_LABEL || row.version !== 1 || !bounded(row.payload, maximumBytes))) invalidNearby('origin-label');
  return labels[0];
}

export function readNearbyOrigins(data: NearbyWireData): ProviderSourceRecord[] {
  const label = archiveLabel(data); if (!label) return [];
  let envelope: Record<string, unknown>;
  try { envelope = wireObject(JSON.parse(label.payload as string)); } catch { return invalidNearby('origin-envelope'); }
  if (envelope.schema !== schema || envelope.version !== 1 || Object.keys(envelope).length !== 3) invalidNearby('origin-envelope');
  return mergeNearbyOrigins(records(envelope.records));
}

export function withNearbyOrigins(data: NearbyWireData, origins: ProviderSourceRecord[]): NearbyWireData {
  const previous = archiveLabel(data), combined = mergeNearbyOrigins(readNearbyOrigins(data), origins);
  if (!previous && !combined.length) return data;
  const result = cloneLosslessJson(data);
  result.labels = [...(result.labels as Record<string, unknown>[] ?? []).filter(row => row.name !== NEARBY_LOCAL_ORIGINS_LABEL),
    { ...previous, name: NEARBY_LOCAL_ORIGINS_LABEL, version: 1, payload: JSON.stringify({ schema, version: 1, records: combined }) }];
  validateNearbyWireData(result);
  return result;
}
