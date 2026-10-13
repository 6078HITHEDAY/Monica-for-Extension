import { Mdbx2NativeHostError } from './native-contract';

export type Mdbx2Backend = 'native' | 'browser';
export type Mdbx2HandleRole = 'vault' | 'state' | 'file' | 'transfer' | 'read' | 'plan';
export interface Mdbx2OwnedHandle { handle: string; role: Mdbx2HandleRole }
export interface Mdbx2HandleOrigin { version: 1; backend: Mdbx2Backend; roles: Mdbx2HandleRole[] }
export interface Mdbx2OriginStore {
  read(handles: string[]): Promise<Map<string, Mdbx2HandleOrigin>>;
  bind(backend: Mdbx2Backend, handles: Mdbx2OwnedHandle[]): Promise<void>;
}
export function mdbx2RoutingError(code = 'mdbx-backend-conflict'): Mdbx2NativeHostError {
  return new Mdbx2NativeHostError(code, 'MDBX 连接归属无法确认，已停止操作。请重新打开对应密码库。', false);
}
export function validateMdbx2RuntimeHandle(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw mdbx2RoutingError('mdbx-handle-invalid');
  return value;
}
const ROLES: Mdbx2HandleRole[] = ['vault', 'state', 'file', 'transfer', 'read', 'plan'];
function parse(value: unknown): Mdbx2HandleOrigin {
  const row = value as Mdbx2HandleOrigin | undefined;
  if (!row || typeof row !== 'object' || Object.keys(row).length !== 3 || row.version !== 1 || !['browser', 'native'].includes(row.backend)
    || !Array.isArray(row.roles) || !row.roles.length || row.roles.length > ROLES.length || new Set(row.roles).size !== row.roles.length
    || row.roles.some(role => !ROLES.includes(role))) throw mdbx2RoutingError('mdbx-routing-storage-invalid');
  return { version: 1, backend: row.backend, roles: row.roles.slice() };
}

/** Only opaque runtime IDs and their origin are stored here, never passwords,
 * record IDs, cloud credentials or payloads. Bind before acknowledging a newly
 * allocated handle. Keep retired identities so stale requests cannot fall back
 * to another backend. Existing unrecorded handles retain Native Host semantics. */
export class IndexedDbMdbx2OriginStore implements Mdbx2OriginStore {
  constructor(private readonly name = 'monica-extension-mdbx-origins-v1', private readonly factory: IDBFactory = indexedDB) {}
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.factory.open(this.name, 1); let settled = false;
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('origins')) request.result.createObjectStore('origins'); };
      request.onerror = request.onblocked = () => { settled = true; reject(mdbx2RoutingError('mdbx-routing-storage-unavailable')); };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true; request.result.onversionchange = () => request.result.close(); resolve(request.result);
      };
    });
  }
  async read(handles: string[]): Promise<Map<string, Mdbx2HandleOrigin>> {
    if (handles.length > 16) throw mdbx2RoutingError('mdbx-routing-limit');
    for (const handle of handles) validateMdbx2RuntimeHandle(handle);
    if (!handles.length) return new Map();
    const db = await this.open();
    try { return await new Promise((resolve, reject) => {
      const tx = db.transaction('origins'), results = new Map<string, unknown>();
      for (const handle of new Set(handles)) {
        const request = tx.objectStore('origins').get(handle); request.onsuccess = () => { if (request.result !== undefined) results.set(handle, request.result); };
      }
      tx.oncomplete = () => { try { resolve(new Map([...results].map(([handle, row]) => [handle, parse(row)]))); } catch (error) { reject(error); } };
      tx.onabort = () => reject(mdbx2RoutingError('mdbx-routing-storage-unavailable'));
    }); } finally { db.close(); }
  }
  async bind(backend: Mdbx2Backend, handles: Mdbx2OwnedHandle[]): Promise<void> {
    if (!['browser', 'native'].includes(backend) || handles.length > 16) throw mdbx2RoutingError('mdbx-routing-limit');
    const grouped = new Map<string, Set<Mdbx2HandleRole>>();
    for (const { handle, role } of handles) {
      validateMdbx2RuntimeHandle(handle); if (!ROLES.includes(role)) throw mdbx2RoutingError('mdbx-handle-invalid');
      const roles = grouped.get(handle) || new Set<Mdbx2HandleRole>(); roles.add(role); grouped.set(handle, roles);
    }
    if (!grouped.size) return;
    const db = await this.open();
    try { await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('origins', 'readwrite', { durability: 'strict' }); let failure: unknown;
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(failure || mdbx2RoutingError('mdbx-routing-storage-unavailable'));
      const store = tx.objectStore('origins');
      for (const [handle, roles] of grouped) {
        const request = store.get(handle); request.onsuccess = () => {
          try {
            const previous = request.result === undefined ? undefined : parse(request.result);
            if (previous && previous.backend !== backend) throw mdbx2RoutingError();
            const combined = ROLES.filter(role => roles.has(role) || previous?.roles.includes(role));
            if (!previous || combined.length !== previous.roles.length) store.put({ version: 1, backend, roles: combined } satisfies Mdbx2HandleOrigin, handle);
          } catch (error) { failure = error; tx.abort(); }
        };
      }
    }); } finally { db.close(); }
  }
}
