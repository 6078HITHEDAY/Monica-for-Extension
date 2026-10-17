import { NEARBY_MANAGER_PORT, type NearbyManagerRequest } from './manager-contract';

type Body = NearbyManagerRequest extends infer R ? R extends { id: number } ? Omit<R, 'id'> : never : never;
type PortLike = Pick<chrome.runtime.Port, 'postMessage' | 'disconnect' | 'onMessage' | 'onDisconnect'>;

export class NearbyManagerError extends Error {
  constructor(readonly code: string) { super(`Nearby manager: ${code}.`); this.name = 'NearbyManagerError'; }
}

/** The manager page's side of `monica-nearby-manager-v1`. One instance holds at
 * most one lease; the background closes it on lock, expiry or cancellation. */
export class NearbyManagerClient {
  private port?: PortLike;
  private nextId = 1;
  private reason?: string;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(private readonly events: { ready: () => void; closed: (reason: string) => void },
    private readonly connect: () => PortLike = () => chrome.runtime.connect({ name: NEARBY_MANAGER_PORT })) {}

  get connected(): boolean { return !!this.port; }

  open(): void {
    if (this.port) return;
    this.reason = undefined;
    let port: PortLike;
    try { port = this.connect(); }
    catch { this.events.closed('manager-closed'); return; }
    this.port = port;
    port.onMessage.addListener(message => this.receive(port, message));
    port.onDisconnect.addListener(() => this.finish(port));
  }

  request<T>(body: Body): Promise<T> {
    const port = this.port;
    if (!port) return Promise.reject(new NearbyManagerError(this.reason ?? 'manager-closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try { port.postMessage({ ...body, id }); }
      catch { this.pending.delete(id); reject(new NearbyManagerError('manager-closed')); }
    });
  }

  /** Cancellation ends the whole lease immediately, including pending native work. */
  cancel(): void {
    const port = this.port;
    if (!port) return;
    try { port.postMessage({ id: this.nextId++, type: 'cancel' }); } catch { this.finish(port); }
  }

  close(): void {
    const port = this.port;
    if (!port) return;
    this.reason = 'manager-closed';
    try { port.disconnect(); } catch { /* Already closed. */ }
    this.finish(port);
  }

  private receive(port: PortLike, message: unknown): void {
    if (port !== this.port || !message || typeof message !== 'object') return;
    const value = message as { type?: unknown; reason?: unknown; id?: unknown; ok?: unknown; data?: unknown; error?: unknown };
    if (value.type === 'ready') { this.events.ready(); return; }
    if (value.type === 'closed') { this.reason = typeof value.reason === 'string' ? value.reason : 'manager-closed'; return; }
    if (typeof value.id !== 'number') return;
    const entry = this.pending.get(value.id);
    if (!entry) return;
    this.pending.delete(value.id);
    if (value.ok === true) entry.resolve(value.data);
    else entry.reject(new NearbyManagerError(typeof value.error === 'string' ? value.error : 'operation-failed'));
  }

  private finish(port: PortLike): void {
    if (port !== this.port) return;
    this.port = undefined;
    const reason = this.reason ?? 'manager-closed';
    for (const entry of this.pending.values()) entry.reject(new NearbyManagerError(reason));
    this.pending.clear();
    this.events.closed(reason);
  }
}
