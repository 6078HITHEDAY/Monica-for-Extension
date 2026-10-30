import { parseLosslessJson } from '../../core/lossless-json';
import { Mdbx2NativeClient, type Mdbx2NativeRuntime } from './native-client';
import { Mdbx2NativeHostError, type Mdbx2NativeMethod } from './native-contract';
import { IndexedDbMdbx2OriginStore, mdbx2RoutingError, validateMdbx2RuntimeHandle, type Mdbx2Backend, type Mdbx2HandleOrigin, type Mdbx2HandleRole, type Mdbx2OriginStore, type Mdbx2OwnedHandle } from './backend-origin-store';

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const localTransfer = (method: string) => method.startsWith('transfer.') || method.startsWith('attachment.upload.');
function handlesOf(method: string, input: Record<string, unknown>, result: boolean): Mdbx2OwnedHandle[] {
  const handles: Mdbx2OwnedHandle[] = [];
  const add = (value: unknown, role: Mdbx2HandleRole) => { if (value !== undefined && value !== null) handles.push({ handle: validateMdbx2RuntimeHandle(value), role }); };
  add(input.vaultHandle, 'vault'); add(input.stateHandle, 'state'); add(input.fileHandle, 'file'); add(input.readHandle, 'read');
  if (method.startsWith('health.repair.')) add(input.planHandle, 'plan');
  if (localTransfer(method)) add(input.transferId, 'transfer');
  if (result && (method.startsWith('sync.bootstrap.') || method.startsWith('sync.segment.'))) add(object(input.file)?.fileHandle, 'file');
  if (!result && (method === 'vault.open' || method === 'vault.inspect')) {
    const source = object(input.source);
    if (!source || !['file', 'vault'].includes(source.kind as string)) throw mdbx2RoutingError('mdbx-handle-invalid');
    handles.push({ handle: validateMdbx2RuntimeHandle(source.handle), role: source.kind as 'file' | 'vault' });
  }
  return handles;
}

/** Keeps every native/core/domain ID byte-for-byte unchanged. A durable origin
 * index distinguishes the engine that allocated each runtime handle. Unknown
 * pre-existing handles retain the old Native Host route; new unbound work uses
 * the bundled engine. Mixed-backend parameters are rejected before dispatch. */
export class Mdbx2BackendRouter extends Mdbx2NativeClient {
  private readonly native: Mdbx2NativeClient;
  private readonly browser: Mdbx2NativeClient;
  private readonly known = new Map<string, Mdbx2HandleOrigin>();
  private epoch = 0;
  constructor(nativeRuntime: Mdbx2NativeRuntime, browserRuntime: Mdbx2NativeRuntime, private readonly origins: Mdbx2OriginStore = new IndexedDbMdbx2OriginStore(),
    private readonly accountOrigin?: (handle: string, role: Mdbx2HandleRole) => Mdbx2Backend | undefined) {
    super(nativeRuntime); this.native = new Mdbx2NativeClient(nativeRuntime); this.browser = new Mdbx2NativeClient(browserRuntime);
  }
  override close(): void { this.epoch++; super.close(); this.native.close(); this.browser.close(); this.known.clear(); }

  async backendForVault(handle: string): Promise<Mdbx2Backend> {
    return this.route([{ handle: validateMdbx2RuntimeHandle(handle), role: 'vault' }]);
  }
  async bindKnownVault(handle: string, backend: Mdbx2Backend): Promise<void> {
    await this.origins.bind(backend, [{ handle, role: 'vault' }]); this.known.delete(handle);
  }
  private async route(handles: Mdbx2OwnedHandle[]): Promise<Mdbx2Backend> {
    const missing = [...new Set(handles.filter(item => !this.known.has(item.handle)).map(item => item.handle))];
    for (const [handle, row] of await this.origins.read(missing)) this.known.set(handle, row);
    // The encrypted account is a second durable source of ownership. Restore a
    // missing index, but never overwrite a conflicting origin. This callback
    // must be synchronous: native verification can run inside a vault mutation.
    for (const item of handles) {
      const expected = this.accountOrigin?.(item.handle, item.role), row = this.known.get(item.handle);
      if (expected && row?.backend && expected !== row.backend) throw mdbx2RoutingError();
      if (expected && (!row || !row.roles.includes(item.role))) {
        await this.origins.bind(expected, [item]);
        this.known.set(item.handle, { version: 1, backend: expected, roles: [...new Set([...(row?.roles || []), item.role])] });
      }
    }
    let backend: Mdbx2Backend | undefined;
    for (const item of handles) {
      const row = this.known.get(item.handle);
      if (row && !row.roles.includes(item.role)) throw mdbx2RoutingError('mdbx-handle-role-invalid');
      // Unbound inbound files and transfers are created by the bundled engine.
      // Unknown vault handles still keep Native Host semantics for pre-index copies.
      const origin = row?.backend || (item.role === 'file' || item.role === 'transfer' ? 'browser' : 'native');
      if (backend && backend !== origin) throw mdbx2RoutingError(); backend = origin;
    }
    return backend || 'browser';
  }
  override async request(method: Mdbx2NativeMethod, params: Record<string, unknown>, timeoutMs = 15_000, ownerVaultHandle?: string): Promise<unknown> {
    const epoch = this.epoch;
    // Snapshot before any asynchronous origin lookup. No caller-owned payload
    // may change after the route or source deletion preconditions were checked.
    const encoded = JSON.stringify(params);
    if (!encoded || new TextEncoder().encode(encoded).length > 1024 * 1024 - 512) throw mdbx2RoutingError('mdbx-request-limit');
    const snapshot = object(parseLosslessJson(encoded)); if (!snapshot) throw mdbx2RoutingError('mdbx-request-invalid');
    const handles = handlesOf(method, snapshot, false);
    if (ownerVaultHandle !== undefined) handles.push({ handle: validateMdbx2RuntimeHandle(ownerVaultHandle), role: 'vault' });
    let backend = await this.route(handles);
    if (method.startsWith('hello.') || method.startsWith('nearby.')) { if (handles.length && backend !== 'native') throw mdbx2RoutingError(); backend = 'native'; }
    if (method === 'vault.create' && backend !== 'browser') throw mdbx2RoutingError();
    if (epoch !== this.epoch) throw new Mdbx2NativeHostError('native-host-closed', 'MDBX 会话已关闭。', false);
    // Reserve previously unindexed legacy handles before touching the native
    // vault. A concurrent origin collision or failed index write must stop the
    // operation before either engine can mutate data.
    const remember = (items: Mdbx2OwnedHandle[]) => {
      for (const item of items) {
        const row = this.known.get(item.handle);
        this.known.set(item.handle, { version: 1, backend, roles: [...new Set([...(row?.roles || []), item.role])] });
      }
    };
    const legacy = handles.filter(item => !this.known.has(item.handle));
    if (legacy.length) { await this.origins.bind(backend, legacy); remember(legacy); }
    if (epoch !== this.epoch) throw new Mdbx2NativeHostError('native-host-closed', 'MDBX 会话已关闭。', false);
    const result = backend === 'browser' ? await this.browser.request(method, snapshot, timeoutMs) : await this.native.request(method, snapshot, timeoutMs);
    const response = object(result), allocated = response ? handlesOf(method, response, true) : [];
    // Includes existing input handles, so legacy roots become explicit too.
    const learned = [...handles, ...allocated];
    try {
      const changed = learned.filter(item => this.known.get(item.handle)?.backend !== backend || !this.known.get(item.handle)?.roles.includes(item.role));
      await this.origins.bind(backend, changed);
      remember(changed);
    } catch (error) { this.close(); throw error; }
    if (epoch !== this.epoch) throw new Mdbx2NativeHostError('native-host-closed', 'MDBX 会话已关闭。', false);
    return result;
  }
}
