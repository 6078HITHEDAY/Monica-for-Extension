import { parseLosslessJson } from '../core/lossless-json';
import type { NearbyIncomingRecord } from './local-adoption';
import type { NearbyNativeTransport } from './native-transport';
import { invalidNearby, validateNearbyWireData, wireInteger, wireObject, wireText } from './wire-shape';
import { isNearbyMetadata, isNearbyTombstone } from './local-metadata';

const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
export function nearbyApplicationReferences(record: NearbyIncomingRecord): string[] {
  const data = wireObject(parseLosslessJson(record.dataJson)), result = new Set<string>();
  for (const raw of [data, data.payload, data.extensions]) {
    if (raw == null) continue;
    const node = wireObject(raw);
    for (const field of ['bound_note_entry_id', 'sso_ref_entry_id', 'bound_password_entry_id']) {
      const value = node[field]; if (typeof value === 'string' && idPattern.test(value)) result.add(value);
    }
  }
  if (Array.isArray(data.relations)) for (const value of data.relations) { const row = wireObject(value); if (typeof row.target === 'string' && idPattern.test(row.target)) result.add(row.target); }
  return [...result];
}

/** Collect before mutating: stable lexicographic cursors must not skip records
 * while applications acknowledge earlier pages. Native pages are at most 256. */
export async function collectNearbyPending(transport: NearbyNativeTransport, handle: string, signal?: AbortSignal, scope = 'local'): Promise<NearbyIncomingRecord[]> {
  const records: NearbyIncomingRecord[] = []; let after: string | undefined, total: number | undefined, bytes = 0;
  for (;;) {
    const page = wireObject(await transport.call('replica_pending', { handle, ...(after ? { after } : {}) }, signal));
    const count = Number(wireInteger(page.total, 20_000n));
    if (total !== undefined && total !== count || !Array.isArray(page.items) || page.items.length > 256) invalidNearby('pending-page');
    total = count;
    for (const raw of page.items) {
      const row = wireObject(raw), record = wireObject(row.record), id = wireText(record.id);
      if (!idPattern.test(id) || id <= (records[records.length - 1]?.id ?? '') || typeof record.deleted !== 'boolean') invalidNearby('pending-order');
      if (!(record.deleted && isNearbyTombstone(wireObject(record.data)))) validateNearbyWireData(record.data);
      const value: NearbyIncomingRecord = { id, deleted: record.deleted, clockJson: JSON.stringify(wireObject(record.clock)), dataJson: JSON.stringify(record.data) };
      if (row.local_id != null || row.scope != null || row.expected_guard != null) {
        value.localId = wireText(row.local_id); value.scope = wireText(row.scope); value.expectedGuard = wireText(row.expected_guard);
        if (!value.localId.startsWith(`${scope}:`) || value.scope !== scope || !/^[a-f0-9]{64}$/.test(value.expectedGuard)) invalidNearby('pending-binding');
      }
      bytes += new TextEncoder().encode(value.dataJson + value.clockJson).length;
      if (bytes > 48 * 1024 * 1024 || records.length >= 20_000) invalidNearby('pending-limit');
      records.push(value);
    }
    if (page.next_cursor == null) { if (records.length !== total) invalidNearby('pending-count'); return records; }
    const next = wireText(page.next_cursor);
    if (!page.items.length || next !== records[records.length - 1].id || next <= (after ?? '') || records.length >= total) invalidNearby('pending-cursor');
    after = next;
  }
}

/** Complete projects/dependencies stay in one local transaction. Independent
 * components share batches; oversize connected projects fail before any write. */
export function groupNearbyPending(records: readonly NearbyIncomingRecord[], canonicalIds: ReadonlyMap<string, string> = new Map(),
  localGroups: ReadonlyMap<string, string> = new Map(), maximum = 200, combine = true): NearbyIncomingRecord[][] {
  const byId = new Map(records.map(row => [row.id, row])), parents = new Map(records.map(row => [row.id, row.id]));
  const find = (id: string): string => {
    let root = id; while (parents.get(root) !== root) root = parents.get(root)!;
    while (id !== root) { const next = parents.get(id)!; parents.set(id, root); id = next; }
    return root;
  };
  const union = (left: string, right: string) => { const a = find(left), b = find(right); if (a !== b) parents.set(b, a); };
  const projects = new Map<string, string>();
  for (const row of records) {
    for (const reference of nearbyApplicationReferences(row)) {
      const target = canonicalIds.get(reference) ?? reference;
      if (byId.has(target)) union(row.id, target);
    }
    const data = wireObject(parseLosslessJson(row.dataJson));
    const extension = data.extensions == null ? undefined : wireObject(data.extensions);
    const group = extension?.password_group_id ?? localGroups.get(row.id);
    if (typeof group === 'string' && group) {
      const old = projects.get(group); if (old) union(row.id, old); else projects.set(group, row.id);
    }
  }
  const components = new Map<string, NearbyIncomingRecord[]>();
  for (const record of records) { const root = find(record.id), values = components.get(root) ?? []; values.push(record); components.set(root, values); }
  const batches: NearbyIncomingRecord[][] = []; let current: NearbyIncomingRecord[] = [];
  // A folder rename/delete can change many local item guards. Apply metadata
  // after all content pages, without combining every item in one folder into
  // an oversized project transaction.
  const ordered = [...components.values()].map(records => ({ records,
    metadata: records.every(row => isNearbyMetadata(wireObject(parseLosslessJson(row.dataJson)))) }))
    .sort((a, b) => Number(a.metadata) - Number(b.metadata)).map(group => group.records);
  for (const group of ordered) {
    if (group.length > maximum) invalidNearby('project-batch-limit');
    if (!combine) { batches.push(group); continue; }
    if (current.length + group.length > maximum) { batches.push(current); current = []; }
    current.push(...group);
  }
  if (current.length) batches.push(current);
  return batches;
}
