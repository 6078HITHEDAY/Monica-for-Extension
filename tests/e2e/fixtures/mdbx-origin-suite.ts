import { IndexedDbMdbx2OriginStore } from '../../../src/providers/mdbx2/backend-origin-store';

const check = (condition: unknown, label: string) => { if (!condition) throw Error(label); };
async function rejected(promise: Promise<unknown>, code: string) {
  try { await promise; } catch (error) { check((error as { code?: string }).code === code, `expected ${code}`); return; }
  throw Error(`missing ${code}`);
}

/** Real IndexedDB, synthetic metadata only. No mock transaction semantics. */
export async function originStoreSuite() {
  const name = `synthetic-mdbx-origins-${crypto.randomUUID()}`;
  let store = new IndexedDbMdbx2OriginStore(name);
  const first = crypto.randomUUID(), second = crypto.randomUUID(), third = crypto.randomUUID();
  await store.bind('browser', [{ handle: first, role: 'vault' }]);
  store = new IndexedDbMdbx2OriginStore(name);
  check((await store.read([first])).get(first)?.backend === 'browser', 'restart ownership');
  await Promise.all([
    store.bind('browser', [{ handle: first, role: 'state' }]),
    new IndexedDbMdbx2OriginStore(name).bind('browser', [{ handle: first, role: 'file' }])
  ]);
  check((await store.read([first])).get(first)?.roles.length === 3, 'concurrent role union');
  await rejected(store.bind('native', [{ handle: second, role: 'vault' }, { handle: first, role: 'vault' }]), 'mdbx-backend-conflict');
  check(!(await store.read([second])).has(second), 'collision rolls back whole batch');

  const original = IDBObjectStore.prototype.put;
  let aborted = false;
  IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
    const request = original.apply(this, args);
    if (this.transaction.db.name === name) request.addEventListener('success', () => { if (!aborted) { aborted = true; this.transaction.abort(); } });
    return request;
  };
  try { await rejected(store.bind('browser', [{ handle: second, role: 'file' }, { handle: third, role: 'transfer' }]), 'mdbx-routing-storage-unavailable'); }
  finally { IDBObjectStore.prototype.put = original; }
  check(aborted && (await store.read([second, third])).size === 0, 'real abort preserves old generation');
  check((await store.read([first])).get(first)?.backend === 'browser', 'abort preserves old owner');

  const race = crypto.randomUUID();
  const results = await Promise.allSettled([
    store.bind('native', [{ handle: race, role: 'vault' }]),
    new IndexedDbMdbx2OriginStore(name).bind('browser', [{ handle: race, role: 'vault' }])
  ]);
  check(results.filter(r => r.status === 'fulfilled').length === 1, 'exactly one concurrent origin wins');
  const loser = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  check(loser.reason.code === 'mdbx-backend-conflict', 'concurrent collision rejected');

  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('origins', 'readwrite', { durability: 'strict' });
      tx.objectStore('origins').put({ version: 1, backend: 'other', roles: ['vault'] }, third);
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    await rejected(store.read([third]), 'mdbx-routing-storage-invalid');
    await rejected(store.bind('native', [{ handle: second, role: 'file' }, { handle: third, role: 'vault' }]), 'mdbx-routing-storage-invalid');
    check(!(await store.read([second])).has(second), 'corrupt metadata aborts entire batch');
  } finally { db.close(); }
  return { restart: true, roleUnion: true, collisionAtomicity: true, realAbort: true, concurrentCollision: true, corruptionFailsClosed: true };
}
