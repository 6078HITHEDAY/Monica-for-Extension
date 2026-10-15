import { parseLosslessJson } from '../core/lossless-json';
import type { NearbyIncomingRecord } from './local-adoption';
import type { NearbySourceSnapshot } from './source-adapter';
import { invalidNearby, wireObject } from './wire-shape';

function pathIds(data: Record<string, unknown>): string[] {
  const path = data.entry_type === 'folder' ? wireObject(data.payload).path : data.folder_path;
  if (path === undefined) return [];
  if (!Array.isArray(path) || path.length > 128) invalidNearby('native-folder-path');
  return path.map(node => {
    const id = wireObject(node).id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) invalidNearby('native-folder-path');
    return id;
  });
}

/** Resolve hierarchy aliases separately from password/note dependencies. Folder
 * membership controls ordering; it must not make an entire large directory one
 * indivisible password project. */
export function nearbyHierarchyReferences(record: NearbyIncomingRecord): string[] {
  return pathIds(wireObject(parseLosslessJson(record.dataJson)));
}

/** Topologically order complete dependency components, then select a bounded
 * prefix. Every retry prefix preserves folder prerequisites. The coordinator
 * rescans native bindings after each successful transaction. */
export function scheduleNearbyNativeGroups(groups: NearbyIncomingRecord[][], snapshot: NearbySourceSnapshot,
  canonicalIds: ReadonlyMap<string, string> = new Map(), maximum = 128): NearbyIncomingRecord[][] {
  const canonical = (id: string) => canonicalIds.get(id) ?? id;
  const before = new Map(snapshot.records.map(row => [row.local_id, row]));
  const index = new Map<string, number>();
  const pending = new Map<string, { row: NearbyIncomingRecord; data: Record<string, unknown>; old?: NearbySourceSnapshot['records'][number] }>();
  for (const [group, records] of groups.entries()) for (const row of records) {
    if (index.has(row.id)) invalidNearby('native-schedule-identity');
    index.set(row.id, group);
    pending.set(row.id, {row, data: wireObject(parseLosslessJson(row.dataJson)), old: row.localId ? before.get(row.localId) : undefined});
  }
  const folder = (value: NonNullable<ReturnType<typeof pending.get>>) => value.data.entry_type === 'folder'
    || value.old?.data.entry_type === 'folder' || value.row.localId?.startsWith(`${value.row.scope}:folder:`) === true;
  const dependencies = groups.map(() => new Set<number>()), dependents = groups.map(() => new Set<number>());
  const depend = (child: number, parent: number) => { if (child !== parent) dependencies[child].add(parent); };
  const priorities = groups.map(() => ({phase: 4, depth: 0, id: ''}));
  for (const [id, value] of pending) {
    const group = index.get(id)!, isFolder = folder(value);
    const desired = pathIds(value.data).map(canonical);
    const original = pathIds(value.old?.data ?? value.data).map(canonical);
    const phase = isFolder ? value.row.deleted ? 3 : 0 : value.data.entry_type === 'vault-metadata' || value.row.localId?.includes(':metadata:') ? 2 : 1;
    const depth = isFolder ? value.row.deleted ? -original.length : desired.length : 0;
    const p = priorities[group];
    if (phase < p.phase || phase === p.phase && depth < p.depth || !p.id) {p.phase = phase; p.depth = depth;}
    if (!p.id || id < p.id) p.id = id;
    // Incoming parents must be created/restored/moved before their descendants.
    for (const ancestor of desired) {
      const target = pending.get(ancestor);
      if (ancestor !== id && target && folder(target) && !target.row.deleted) depend(group, index.get(ancestor)!);
    }
    // A parent cannot be trashed until its former children/items have been
    // deleted or moved out, even if their new paths no longer mention it.
    for (const ancestor of original) {
      const target = pending.get(ancestor);
      if (ancestor !== id && target && folder(target) && target.row.deleted) depend(index.get(ancestor)!, group);
    }
  }
  for (const [child, parents] of dependencies.entries()) for (const parent of parents) dependents[parent].add(child);
  const counts = dependencies.map(set => set.size), ready: number[] = [], ordered: number[] = [];
  const less = (a: number, b: number) => {
    const x = priorities[a], y = priorities[b];
    return x.phase !== y.phase ? x.phase < y.phase : x.depth !== y.depth ? x.depth < y.depth : x.id < y.id;
  };
  const push = (value: number) => {
    let i = ready.length; ready.push(value);
    while (i) {const parent = (i - 1) >> 1; if (!less(value, ready[parent])) break; ready[i] = ready[parent]; i = parent;}
    ready[i] = value;
  };
  const pop = () => {
    const first = ready[0], last = ready.pop()!;
    if (ready.length) {
      let i = 0;
      while (i * 2 + 1 < ready.length) {
        let child = i * 2 + 1;
        if (child + 1 < ready.length && less(ready[child + 1], ready[child])) child++;
        if (!less(ready[child], last)) break;
        ready[i] = ready[child]; i = child;
      }
      ready[i] = last;
    }
    return first;
  };
  counts.forEach((count, i) => { if (!count) push(i); });
  while (ready.length) {
    const group = pop(); ordered.push(group);
    for (const child of dependents[group]) if (--counts[child] === 0) push(child);
  }
  if (ordered.length !== groups.length) invalidNearby('native-folder-cycle');
  const result: NearbyIncomingRecord[][] = []; let size = 0;
  for (const index of ordered) {
    if (groups[index].length > maximum) invalidNearby('project-batch-limit');
    if (size + groups[index].length > maximum) break;
    result.push(groups[index]); size += groups[index].length;
  }
  return result;
}
