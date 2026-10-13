import { describe, expect, it } from 'vitest';
import { Mdbx2BackendRouter } from './backend-router';
import { mdbx2RoutingError, type Mdbx2Backend, type Mdbx2HandleOrigin, type Mdbx2OriginStore, type Mdbx2OwnedHandle } from './backend-origin-store';
import type { Mdbx2NativeRuntime } from './native-client';

const id = (n: number) => `${n.toString().padStart(8, '0')}-1234-4234-8234-123456789abc`;
class MemoryOrigins implements Mdbx2OriginStore {
  rows = new Map<string, Mdbx2HandleOrigin>();
  failed = false;
  async read(ids: string[]) { return new Map(ids.flatMap(id => this.rows.has(id) ? [[id, structuredClone(this.rows.get(id)!)]] : [])); }
  async bind(backend: Mdbx2Backend, handles: Mdbx2OwnedHandle[]) {
    if (this.failed) throw mdbx2RoutingError('mdbx-routing-storage-unavailable');
    for (const item of handles) {
      const row = this.rows.get(item.handle); if (row && row.backend !== backend) throw mdbx2RoutingError();
      this.rows.set(item.handle, { version: 1, backend, roles: [...new Set([...(row?.roles || []), item.role])] });
    }
  }
}
function runtime(result: (request: any) => unknown) {
  const calls: any[] = []; let closed = 0, failNextPost = false;
  const value: Mdbx2NativeRuntime = {
    disconnectErrorMessage: () => undefined,
    connectNative: () => {
      const listeners = new Set<(value: never) => void>();
      return {
        postMessage(request: any) { if (failNextPost) { failNextPost = false; throw Error('synthetic transport loss'); } calls.push(request); queueMicrotask(() => { for (const fn of listeners) fn({ protocol: 2, requestId: request.requestId, ok: true, result: result(request) } as never); }); },
        disconnect() { closed++; },
        onMessage: { addListener: fn => { listeners.add(fn); }, removeListener: fn => { listeners.delete(fn); } },
        onDisconnect: { addListener: () => {}, removeListener: () => {} }
      };
    }
  };
  return { value, calls, failPost() { failNextPost = true; }, get closed() { return closed; } };
}
function fixture(result: (request: any) => unknown = () => ({})) {
  const native = runtime(result), browser = runtime(result), origins = new MemoryOrigins();
  return { native, browser, origins, router: new Mdbx2BackendRouter(native.value, browser.value, origins) };
}
describe('MDBX backend ownership', () => {
  it('keeps old unknown handles on Native Host and sends new unbound work to the browser', async () => {
    const f = fixture(r => r.method === 'transfer.begin' ? { transferId: id(2), nextOffset: 0, maxChunkBytes: 262144 } : {});
    await f.router.request('vault.status', { vaultHandle: id(1) });
    await f.router.beginInboundTransfer(3);
    expect(f.native.calls.map(r => r.method)).toEqual(['vault.status']); expect(f.browser.calls.map(r => r.method)).toEqual(['transfer.begin']);
    expect(f.origins.rows.get(id(1))?.backend).toBe('native'); expect(f.origins.rows.get(id(2))?.backend).toBe('browser'); f.router.close();
  });
  it('retains browser ownership after replacing the router and never rewrites an ID', async () => {
    const f = fixture(() => ({ vaultHandle: id(1) }));
    await f.router.request('vault.create', { password: 'synthetic', mode: 'sky' }); f.router.close();
    const fresh = new Mdbx2BackendRouter(f.native.value, f.browser.value, f.origins);
    await fresh.request('vault.open', { source: { kind: 'vault', handle: id(1) }, credential: { method: 'password', password: 'synthetic' } });
    expect(f.native.calls).toHaveLength(0); expect(f.browser.calls[1].params.source.handle).toBe(id(1)); fresh.close();
  });
  it('routes unbound incoming segments and capability checks using their owning vault', async () => {
    const f = fixture(() => ({ transferId: id(2), nextOffset: 0, maxChunkBytes: 262144 }));
    await f.router.beginInboundTransferForVault(id(1), 3, undefined, 'sync-segment');
    await f.router.request('host.hello', {}, 15000, id(1));
    expect(f.native.calls.map(r => r.method)).toEqual(['transfer.begin', 'host.hello']); expect(f.browser.calls).toHaveLength(0);
    expect(f.native.calls[0].params).not.toHaveProperty('vaultHandle'); expect(f.native.calls[0]).not.toHaveProperty('ownerVaultHandle'); f.router.close();
  });
  it('rejects mixed engines and wrong handle roles before either receives a request', async () => {
    const f = fixture(); await f.origins.bind('browser', [{ handle: id(1), role: 'vault' }, { handle: id(3), role: 'file' }]);
    await expect(f.router.request('sync.segment.inspect', { vaultHandle: id(1), fileHandle: id(2) })).rejects.toMatchObject({ code: 'mdbx-backend-conflict' });
    await expect(f.router.request('vault.open', { source: { kind: 'vault', handle: id(3) } })).rejects.toMatchObject({ code: 'mdbx-handle-role-invalid' });
    expect(f.native.calls).toHaveLength(0); expect(f.browser.calls).toHaveLength(0); f.router.close();
  });
  it('tracks local file handles but preserves remote stream and domain identities as data', async () => {
    const f = fixture(() => ({ stateHandle: id(2), file: { fileHandle: id(3) }, transferId: id(4), vaultId: id(5), payloadJson: JSON.stringify({ vaultHandle: id(6) }) }));
    await f.origins.bind('browser', [{ handle: id(1), role: 'vault' }]);
    const result = await f.router.request('sync.segment.prepare', { vaultHandle: id(1) });
    expect(result).toMatchObject({ transferId: id(4), vaultId: id(5) });
    expect(f.origins.rows.get(id(3))?.roles).toEqual(['file']); expect(f.origins.rows.has(id(4))).toBe(false); expect(f.origins.rows.has(id(5))).toBe(false); expect(f.origins.rows.has(id(6))).toBe(false); f.router.close();
  });
  it('snapshots opaque payloads before asynchronous routing', async () => {
    const f = fixture();
    const payload = '{"credential_id":"original","sign_count":0,"vaultHandle":"literal","large":9007199254740993}';
    const params = { vaultHandle: id(1), payloadJson: payload, mutations: [{ input: { credentialId: 'original', stateHandle: 'opaque data' } }] };
    const result = f.router.request('object.upsert', params); params.payloadJson = 'changed'; params.mutations[0].input.credentialId = 'changed'; await result;
    expect(f.native.calls[0].params.payloadJson).toBe(payload); expect(f.native.calls[0].params.mutations[0].input.credentialId).toBe('original'); f.router.close();
  });
  it('withholds the result and closes the session if durable origin binding fails', async () => {
    const f = fixture(() => ({ vaultHandle: id(1) })); f.origins.failed = true;
    await expect(f.router.request('vault.create', { password: 'synthetic', mode: 'sky' })).rejects.toMatchObject({ code: 'mdbx-routing-storage-unavailable' });
    expect(f.browser.calls).toHaveLength(1); expect(f.browser.closed).toBe(1);
  });
  it('does not dispatch a delayed lookup after closing', async () => {
    const f = fixture(); let release!: () => void;
    f.origins.read = async () => { await new Promise<void>(resolve => { release = resolve; }); return new Map(); };
    const result = f.router.request('vault.status', { vaultHandle: id(1) }); f.router.close(); release();
    await expect(result).rejects.toMatchObject({ code: 'native-host-closed' }); expect(f.native.calls).toHaveLength(0); expect(f.browser.calls).toHaveLength(0);
  });
  it('keeps native platform capabilities on Native Host', async () => {
    const f = fixture(); await f.router.request('nearby.call', { payload: 'unchanged' }); await f.router.request('hello.status', {});
    expect(f.native.calls).toHaveLength(2); expect(f.browser.calls).toHaveLength(0); f.router.close();
  });
  it('rejects an absent or malformed source handle before choosing an engine', async () => {
    const f = fixture();
    for (const handle of [undefined, null, 'not-a-handle']) await expect(f.router.request('vault.open', { source: { kind: 'file', handle } })).rejects.toMatchObject({ code: 'mdbx-handle-invalid' });
    expect(f.native.calls).toHaveLength(0); expect(f.browser.calls).toHaveLength(0); f.router.close();
  });
  it('reserves legacy origins before native writes and refuses a concurrent collision', async () => {
    const f = fixture();
    f.origins.read = async () => { await f.origins.bind('browser', [{ handle: id(1), role: 'vault' }]); return new Map(); };
    await expect(f.router.request('object.upsert', { vaultHandle: id(1) })).rejects.toMatchObject({ code: 'mdbx-backend-conflict' });
    expect(f.native.calls).toHaveLength(0); expect(f.browser.calls).toHaveLength(0); f.router.close();
  });
  it('does not acknowledge a completed write after closing during origin persistence', async () => {
    const f = fixture(() => ({ vaultHandle: id(1) }));
    let release!: () => void;
    const binding = f.origins.bind.bind(f.origins);
    f.origins.bind = async (backend, handles) => { await new Promise<void>(resolve => { release = resolve; }); await binding(backend, handles); };
    const result = f.router.request('vault.create', { password: 'synthetic', mode: 'sky' });
    // Wait for the successful engine response to reach the durable binding.
    for (let i = 0; !release && i < 20; i++) await Promise.resolve();
    expect(release).toBeTypeOf('function'); f.router.close(); release();
    await expect(result).rejects.toMatchObject({ code: 'native-host-closed' });
    expect(f.origins.rows.get(id(1))?.backend).toBe('browser'); expect(f.browser.calls).toHaveLength(1);
  });
  it('routes capability checks to each vault rather than the default engine', async () => {
    const f = fixture(() => ({}));
    await f.origins.bind('browser', [{ handle: id(2), role: 'vault' }]);
    // Invalid capability replies deliberately stop these calls before writes.
    for (const handle of [id(1), id(2)]) await expect(f.router.readWriteRevision(handle)).rejects.toBeDefined();
    expect(f.native.calls.map(r => r.method)).toEqual(['host.hello']);
    expect(f.browser.calls.map(r => r.method)).toEqual(['host.hello']); f.router.close();
  });
  it('does not touch a legacy vault if its origin cannot be durably reserved', async () => {
    const f = fixture(); f.origins.failed = true;
    await expect(f.router.request('object.upsert', { vaultHandle: id(1) })).rejects.toMatchObject({ code: 'mdbx-routing-storage-unavailable' });
    expect(f.native.calls).toHaveLength(0); expect(f.browser.calls).toHaveLength(0); f.router.close();
  });
  it('keeps the browser owner alive when the native transport fails and never falls back', async () => {
    const f = fixture(); await f.origins.bind('browser', [{ handle: id(2), role: 'vault' }]);
    await f.router.request('vault.status', { vaultHandle: id(2) });
    f.native.failPost();
    await expect(f.router.request('vault.status', { vaultHandle: id(1) })).rejects.toBeDefined();
    expect(f.browser.closed).toBe(0); expect(f.browser.calls).toHaveLength(1);
    await f.router.request('vault.status', { vaultHandle: id(2) }); expect(f.browser.calls).toHaveLength(2); f.router.close();
  });
  it('binds repair plans while leaving user and domain IDs untouched', async () => {
    const f = fixture(() => ({ planHandle: id(3), objectId: id(4) }));
    await f.origins.bind('browser', [{ handle: id(2), role: 'vault' }]);
    await f.router.request('health.repair.plan', { vaultHandle: id(2) });
    expect(f.origins.rows.get(id(3))?.roles).toEqual(['plan']); expect(f.origins.rows.has(id(4))).toBe(false);
    await expect(f.router.request('health.repair.apply', { vaultHandle: id(1), planHandle: id(3) })).rejects.toMatchObject({ code: 'mdbx-backend-conflict' });
    expect(f.native.calls).toHaveLength(0); f.router.close();
  });
  it('restores missing vault and state origins from the authenticated account before dispatch', async () => {
    const f = fixture();
    const router = new Mdbx2BackendRouter(f.native.value, f.browser.value, f.origins, (handle, role) =>
      handle === id(1) && role === 'vault' || handle === id(2) && role === 'state' ? 'browser' : undefined);
    await router.request('sync.state.status', { vaultHandle: id(1), stateHandle: id(2) });
    expect(f.native.calls).toHaveLength(0); expect(f.browser.calls).toHaveLength(1);
    expect(f.origins.rows.get(id(1))?.backend).toBe('browser'); expect(f.origins.rows.get(id(2))?.backend).toBe('browser'); router.close();
  });
  it('refuses an account origin that conflicts with a previously allocated handle', async () => {
    const f = fixture(); await f.origins.bind('native', [{ handle: id(1), role: 'vault' }]);
    const router = new Mdbx2BackendRouter(f.native.value, f.browser.value, f.origins, () => 'browser');
    await expect(router.request('vault.status', { vaultHandle: id(1) })).rejects.toMatchObject({ code: 'mdbx-backend-conflict' });
    expect(f.native.calls).toHaveLength(0); expect(f.browser.calls).toHaveLength(0); router.close();
  });
});
