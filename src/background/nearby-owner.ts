import { assertTrustedManagerPage } from '../runtime/sender-policy';
import type { SecureVaultService } from '../security/secure-vault-service';
import { NearbyCoordinatorError, type NearbyLocalCoordinator } from '../nearby/local-coordinator';
import { nearbyPreferencesView, NearbyPreferencesError } from '../nearby/preferences';
import { NEARBY_MANAGER_PORT, readNearbyManagerRequest, type NearbyManagerRequest } from '../nearby/manager-contract';
import { nearbyNativeRecoveryView } from '../nearby/native-journal';

type Session = { id?: string; expiresAt: number };
type Store = Pick<SecureVaultService, 'nearbySessionPreferences' | 'updateNearbyPreferences' | 'readState' | 'readNearbyNativeJournal'>;
type Coordinator = Pick<NearbyLocalCoordinator, keyof NearbyLocalCoordinator>;
interface Lease {
  port: chrome.runtime.Port; session?: Session; coordinator?: Coordinator;
  timer?: ReturnType<typeof setTimeout>; lastId: number; busy: boolean;
  message: (value: unknown) => void; disconnect: () => void;
}

/** One full manager document owns one native connection. No work survives its lease. */
export class NearbyManagerOwner {
  private lease?: Lease;
  constructor(private readonly options: {
    runtimeId: string; extensionRoot: string; store: Store;
    readSession: () => Promise<Session | null>;
    createCoordinator: (assertActive: () => void) => Coordinator;
    changed: () => void;
    now?: () => number;
  }) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }

  attach(port: chrome.runtime.Port): void {
    if (port.name !== NEARBY_MANAGER_PORT) return;
    try {
      const sender = port.sender ?? {};
      assertTrustedManagerPage(sender, this.options.runtimeId, this.options.extensionRoot);
      const root = new URL(this.options.extensionRoot);
      if (sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || sender.tab!.id! < 0
        || typeof sender.documentId !== 'string' || !/^[0-9a-f-]{16,64}$/i.test(sender.documentId)
        || sender.origin !== undefined && sender.origin !== `${root.protocol}//${root.host}`
        || sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active') throw new Error('Invalid manager document');
    } catch { port.disconnect(); return; }
    if (this.lease) { port.postMessage({ type: 'closed', reason: 'manager-busy' }); port.disconnect(); return; }
    const lease: Lease = { port, lastId: 0, busy: true,
      message: value => this.receive(lease, value), disconnect: () => { if (this.lease === lease) this.close('manager-closed'); } };
    this.lease = lease;
    port.onMessage.addListener(lease.message); port.onDisconnect.addListener(lease.disconnect);
    void this.options.readSession().then(session => {
      if (this.lease !== lease) return;
      if (!this.validSession(session)) { this.close('vault-locked'); return; }
      lease.session = session; lease.busy = false; this.arm(lease);
      this.post(lease, { type: 'ready' });
    }).catch(() => { if (this.lease === lease) this.close('vault-locked'); });
  }

  /** Called directly by runtime lock/restore hooks, before their first await. */
  close(reason = 'cancelled'): void {
    const lease = this.lease; if (!lease) return;
    this.lease = undefined;
    clearTimeout(lease.timer); lease.coordinator?.close(); lease.coordinator = undefined; lease.session = undefined;
    lease.port.onMessage.removeListener(lease.message); lease.port.onDisconnect.removeListener(lease.disconnect);
    try { lease.port.postMessage({ type: 'closed', reason }); } catch { /* The document may already be gone. */ }
    try { lease.port.disconnect(); } catch { /* Already disconnected. */ }
  }
  /** Ordinary user activity may extend this deadline; polling never does. */
  sessionChanged(session: Session | null): void {
    const lease = this.lease; if (!lease) return;
    if (!this.validSession(session) || lease.session?.id !== session.id) { this.close('session-changed'); return; }
    lease.session = session; this.arm(lease);
  }
  private validSession(session: Session | null): session is Session {
    return !!session && typeof session.id === 'string' && session.id.length > 0 && Number.isSafeInteger(session.expiresAt) && session.expiresAt > this.now();
  }
  private arm(lease: Lease): void {
    clearTimeout(lease.timer);
    lease.timer = setTimeout(() => {
      if (this.lease !== lease) return;
      if (!this.validSession(lease.session ?? null)) this.close('session-expired');
      else this.arm(lease);
    }, Math.max(1, Math.min(2_147_483_647, lease.session!.expiresAt - this.now())));
  }
  private active(lease: Lease): void {
    if (this.lease !== lease) throw new NearbyCoordinatorError('session-closed');
    if (!this.validSession(lease.session ?? null)) { this.close('session-expired'); throw new NearbyCoordinatorError('session-closed'); }
  }
  private post(lease: Lease, response: unknown): void {
    if (this.lease !== lease) return;
    try { lease.port.postMessage(response); } catch { this.close('manager-closed'); }
  }
  private receive(lease: Lease, value: unknown): void {
    if (this.lease !== lease) return;
    let request: NearbyManagerRequest;
    try {
      request = readNearbyManagerRequest(value);
      if (request.id <= lease.lastId) throw new Error('Replayed request');
      lease.lastId = request.id;
    } catch { this.close('invalid-request'); return; }
    if (request.type === 'cancel') { this.close(); return; }
    if (lease.busy) { this.post(lease, { id: request.id, ok: false, error: 'busy' }); return; }
    lease.busy = true;
    void this.execute(lease, request).then(data => {
      this.active(lease); this.post(lease, { id: request.id, ok: true, data });
    }).catch(error => {
      // Never forward native messages, keys, stack traces or database contents.
      const code = error instanceof NearbyCoordinatorError || error instanceof NearbyPreferencesError ? error.code : 'operation-failed';
      this.post(lease, { id: request.id, ok: false, error: code });
    }).finally(() => { lease.busy = false; });
  }
  private async execute(lease: Lease, request: NearbyManagerRequest): Promise<unknown> {
    this.active(lease);
    const assertActive = () => this.active(lease), sessionId = lease.session!.id!;
    if (request.type === 'sources') {
      const state = await this.options.store.readState(); assertActive();
      return state.providers.filter(p => p.enabled && ['local', 'mdbx2'].includes(p.kind)).map(p => ({ id: p.id, name: p.name, kind: p.kind }));
    }
    if (request.type === 'preferences') {
      const preferences = await this.options.store.nearbySessionPreferences(sessionId, assertActive);
      assertActive(); return nearbyPreferencesView(preferences);
    }
    if (request.type === 'update') {
      lease.coordinator?.close(); lease.coordinator = undefined;
      const preferences = await this.options.store.updateNearbyPreferences(request.change, request.epoch, sessionId, assertActive);
      assertActive(); this.options.changed(); return preferences;
    }
    if (request.type === 'status') return lease.coordinator?.status() ?? { phase: 'idle' };
    if (request.type === 'recovery-status') {
      const journal = await this.options.store.readNearbyNativeJournal(sessionId); assertActive();
      return nearbyNativeRecoveryView(journal);
    }
    const coordinator = lease.coordinator ??= this.options.createCoordinator(assertActive);
    switch (request.type) {
      case 'recover': {
        const result = await coordinator.recover(request.operationId); assertActive();
        this.options.changed(); return result;
      }
      case 'discover': return coordinator.discover(request.target);
      case 'discovery-progress': return coordinator.discoveryProgress();
      case 'pair': return coordinator.pair(request.invitation);
      case 'prepare': return coordinator.prepare(request.peerId);
      case 'confirm': return coordinator.confirm(request.reviewId);
      case 'start': return coordinator.start(request.endpoint);
      case 'progress': {
        const view = await coordinator.poll(); assertActive();
        if (view.phase === 'completed') this.options.changed();
        return view;
      }
    }
  }
}
