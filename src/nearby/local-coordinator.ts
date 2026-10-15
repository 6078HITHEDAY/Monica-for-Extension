import { localNearbySource, type NearbySourceAdapter, type NearbySourceSnapshot } from './source-adapter';
import type { NearbyAcknowledgement } from './native-journal';
import { Mdbx2NativeHostError } from '../providers/mdbx2/native-contract';
import { remapNearbyReferences, type NearbyWireData } from './wire-shape';
import { parseLosslessJson } from '../core/lossless-json';
import { base64ToBytes, bytesToBase64 } from '../security/encoding';
import type { SecureVaultService } from '../security/secure-vault-service';
import { NearbyNativeTransport, NearbyTransportError, appendNearbyAsset, readNearbyAsset, type NearbyOperation } from './native-transport';
import { NearbyPasskeyConsent, type NearbyPasskeyReview } from './passkey-consent';
import { nearbyDeviceHello, nearbySettingsCounter, type NearbyPreferences, type NearbySavedPeer } from './preferences';
import { collectNearbyPending, groupNearbyPending, nearbyApplicationReferences } from './pending';
import { nearbyHierarchyReferences, scheduleNearbyNativeGroups } from './native-schedule';
import { adoptNearbyNativeGroups } from './native-batches';
import type { NearbyIncomingRecord, NearbyLocalAcknowledgement } from './local-adoption';
import { NearbyDataError, wireInteger, wireObject, wireText } from './wire-shape';

type Store = Pick<SecureVaultService, 'passkeySessionId' | 'nearbySessionPreferences' | 'assertNearbySession' | 'updateNearbyPreferences'
  | 'captureNearbyLocalRecords' | 'nearbyLocalSnapshotHash' | 'nearbySavedAcknowledgements' | 'nearbyPendingPasswordGroups' | 'adoptNearbyLocalTransaction'>;
export interface NearbyEndpoint { addresses: string[]; port: number }
export interface NearbyDiscoveredPeer { deviceId: string; name: string; endpoint: NearbyEndpoint }
export interface NearbyDiscoveryView { searching: boolean; devices: NearbyDiscoveredPeer[] }
export interface NearbyCoordinatorView {
  phase: 'idle' | 'pairing' | 'preparing' | 'review' | 'ready' | 'transferring' | 'saving' | 'completed' | 'failed' | 'cancelled';
  operationId?: string; peerId?: string; peerName?: string; recoveryOnly?: boolean;
  pairing?: { code: string; invitations: string[] }; endpoint?: NearbyEndpoint;
  review?: NearbyPasskeyReview; applied?: number; error?: string;
}
export class NearbyCoordinatorError extends Error {
  constructor(readonly code: string) { super(`Nearby: ${code}.`); this.name = 'NearbyCoordinatorError'; }
}
function failure(code: string): never { throw new NearbyCoordinatorError(code); }
const identity = /^[A-Za-z0-9_-]{1,64}$/;
const token = (value: unknown) => { const text = wireText(value); if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(text)) failure('invalid-handle'); return text; };
const string = (value: unknown, length = 128) => { const text = wireText(value); if (text.length > length || /[\u0000-\u001f\u007f-\u009f]/.test(text)) failure('invalid-peer'); return text; };
const validId = (value: unknown) => { const text = wireText(value); if (!identity.test(text)) failure('invalid-peer'); return text; };

function endpoint(value: unknown): NearbyEndpoint {
  const item = wireObject(value);
  if (!Array.isArray(item.addresses) || !item.addresses.length || item.addresses.length > 16 || typeof item.port !== 'number'
    || !Number.isInteger(item.port) || item.port < 1 || item.port > 65535) failure('invalid-endpoint');
  const addresses = item.addresses.map(raw => {
    const address = string(raw, 15), parts = address.split('.');
    if (parts.length !== 4 || parts.some(p => !/^(?:0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255)) failure('invalid-endpoint');
    const [a, b] = parts.map(Number);
    if (!(a === 127 || a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254)) failure('local-network-only');
    return address;
  });
  if (new Set(addresses).size !== addresses.length) failure('invalid-endpoint');
  return { addresses, port: item.port };
}
function invitation(value: unknown): { address: NearbyEndpoint; key: string; text: string } {
  const text = string(value, 512), parts = text.split(':');
  if (parts.length !== 5 || parts[0] !== 'monica-lan' || parts[1] !== '2' || !/^[A-Za-z0-9_-]{43}$/.test(parts[4]) || !/^[1-9]\d{0,4}$/.test(parts[3])) failure('invalid-invitation');
  return { address: endpoint({ addresses: parts[2].split(','), port: Number(parts[3]) }), key: parts[4], text };
}
function chunks<T>(items: readonly T[], maximum = 256): T[][] {
  const result: T[][] = []; let batch: T[] = [], bytes = 0;
  for (const item of items) {
    const size = new TextEncoder().encode(JSON.stringify(item)).length;
    if (size > 6 * 1024 * 1024) failure('record-limit');
    if (batch.length && (batch.length >= maximum || bytes + size > 6 * 1024 * 1024)) { result.push(batch); batch = []; bytes = 0; }
    batch.push(item); bytes += size;
  }
  if (batch.length) result.push(batch); return result;
}

/** One background-owned coordinator and dedicated native port. There is no raw
 * RPC/runtime exposure. Call close synchronously on lock, settings change or
 * manager disposal; every awaited boundary also checks the session/epoch. */
export class NearbyLocalCoordinator {
  private transport?: NearbyNativeTransport;
  private abort = new AbortController();
  private preferences?: NearbyPreferences;
  private sessionId?: string;
  private replica?: string;
  private snapshot?: string;
  private transfer?: string;
  private sourceHash?: string;
  private revision = '';
  private peer?: NearbySavedPeer;
  private enrolling = false;
  private acknowledged = false;
  private consent = new NearbyPasskeyConsent();
  private view: NearbyCoordinatorView = { phase: 'idle' };
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private discovery?: string;
  private source?: NearbySourceAdapter;
  private listenerDiscovery?: string;
  private nextListenerDiscovery = 0;
  private listenerConnect?: NearbyEndpoint;

  constructor(private readonly store: Store, private readonly factory: () => NearbyNativeTransport, private readonly listenAddress?: string,
    private readonly assertOwner?: () => void,
    private readonly sourceFactory?: (preferences: NearbyPreferences, sessionId: string, signal: AbortSignal, active: () => void, epoch: () => string) => Promise<NearbySourceAdapter>) {}
  status(): NearbyCoordinatorView { return structuredClone(this.view); }
  close(): void {
    this.generation++;
    this.abort.abort(); this.transport?.close(); this.transport = undefined;
    this.consent.reset(); this.preferences = undefined; this.peer = undefined; this.sessionId = undefined;
    this.replica = this.snapshot = this.transfer = this.sourceHash = undefined;
    this.discovery = undefined; this.source = undefined;
    this.listenerDiscovery = undefined;
    this.listenerConnect = undefined;
    this.view = { phase: 'cancelled' };
  }
  private run<T>(action: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const result = this.tail.then(async () => {
      try {
        this.assertOwner?.();
        if (generation !== this.generation) failure('session-closed');
        const result = await action();
        if (generation !== this.generation) failure('session-closed');
        return result;
      }
      catch (error) {
        const code = error instanceof NearbyCoordinatorError || error instanceof NearbyDataError || error instanceof NearbyTransportError ? error.code : error instanceof Mdbx2NativeHostError && /^(?:native-host-|content-write-|nearby-)[a-z-]{1,64}$/.test(error.code) ? error.code : 'operation-failed';
        this.close(); this.view = { phase: 'failed', error: code }; throw new NearbyCoordinatorError(code);
      }
    });
    this.tail = result.catch(() => {}); return result;
  }
  private async guard(source = false): Promise<void> {
    this.assertOwner?.();
    if (this.abort.signal.aborted || !this.preferences || !this.sessionId) failure('session-closed');
    await this.store.assertNearbySession(this.preferences.epoch, this.sessionId);
    if (this.abort.signal.aborted) failure('session-closed');
    if (source && this.sourceHash !== await this.source!.snapshotHash()) failure('source-changed');
    this.assertOwner?.();
    if (this.abort.signal.aborted) failure('session-closed');
  }
  /** Retain the exact operation generation across an encrypted store transaction. */
  private transactionGuard(): () => void {
    const generation = this.generation;
    return () => { this.assertOwner?.(); if (generation !== this.generation) failure('session-closed'); };
  }
  private async call(operation: NearbyOperation, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await this.guard();
    const result = wireObject(await this.transport!.call(operation, input, this.abort.signal));
    await this.guard(); return result;
  }
  private async initialize(): Promise<void> {
    if (!['idle', 'completed', 'failed', 'cancelled'].includes(this.view.phase)) failure('busy');
    const generation = this.generation;
    const previousSession = this.sessionId, previousStorage = this.preferences?.replicaStorageId;
    this.sessionId = await this.store.passkeySessionId() ?? failure('vault-locked');
    if (generation !== this.generation) failure('session-closed');
    this.preferences = await this.store.nearbySessionPreferences(this.sessionId, this.transactionGuard());
    if (generation !== this.generation) failure('session-closed');
    if (this.transport && (previousSession !== this.sessionId || previousStorage !== this.preferences.replicaStorageId)) {
      this.abort.abort(); this.transport.close(); this.transport = undefined;
      this.replica = this.snapshot = this.transfer = undefined;
    }
    if (!this.transport) { this.abort = new AbortController(); this.transport = this.factory(); }
    this.peer = undefined; this.sourceHash = undefined; this.enrolling = false; this.acknowledged = false; this.consent.reset();
    this.listenerDiscovery = undefined; this.nextListenerDiscovery = 0;
    this.source = this.sourceFactory ? await this.sourceFactory(this.preferences, this.sessionId, this.abort.signal, this.transactionGuard(), () => this.preferences!.epoch) : localNearbySource(this.store, this.sessionId, this.transactionGuard());
    await this.guard();
    this.view = { phase: 'preparing', operationId: crypto.randomUUID(), applied: 0 };
  }
  /** Discovery is only an address hint. Pair identity and the Noise handshake
   * authenticate the target; no advertised name or revision grants trust. */
  async discover(target?: string): Promise<NearbyDiscoveryView> {
    return this.run(async () => {
      if (this.discovery) failure('busy');
      await this.initialize();
      const targets = target ? endpoint({ addresses: [target], port: 1 }).addresses : undefined;
      this.discovery = token((await this.call('discover', targets ? { targets, multicast: false } : {})).handle);
      this.view = { phase: 'idle' };
      return { searching: true, devices: [] };
    });
  }
  async discoveryProgress(): Promise<NearbyDiscoveryView> {
    return this.run(async () => {
      if (!this.discovery) return { searching: false, devices: [] };
      const response = await this.call('discovery_result', { handle: this.discovery });
      if (response.ready === false) return { searching: true, devices: [] };
      this.discovery = undefined;
      const result = wireObject(response.result);
      if (response.ready !== true || !Array.isArray(result.devices) || result.devices.length > 256) failure('invalid-discovery');
      const devices: NearbyDiscoveredPeer[] = [], seen = new Set<string>();
      for (const value of result.devices) {
        try {
          const row = wireObject(value);
          if (row.protocol !== 'monica-lan' || row.version !== 2 || row.trusted !== true) continue;
          const peer = this.preferences!.peers.find(p => p.deviceId === row.device_id && p.pairId === row.session);
          if (!peer || seen.has(peer.deviceId)) continue;
          const address = endpoint({ addresses: row.address ? [row.address] : row.addresses, port: row.port });
          devices.push({ deviceId: peer.deviceId, name: peer.name, endpoint: address }); seen.add(peer.deviceId);
        } catch { /* Ignore malformed unauthenticated UDP announcements. */ }
      }
      return { searching: false, devices };
    });
  }
  async pair(link?: string): Promise<NearbyCoordinatorView> {
    return this.run(async () => {
      await this.initialize(); this.enrolling = true;
      if (this.preferences!.peers.length >= 8) failure('peer-limit');
      const snapshot = await this.call('snapshot_pairing', { device_id: this.preferences!.deviceId });
      this.snapshot = token(snapshot.handle); this.revision = string(snapshot.revision);
      if (this.revision !== 'pairing-only-v1') failure('invalid-pairing-snapshot');
      const device = { ...nearbyDeviceHello(this.preferences!), sync_mode: 'bidirectional' };
      const started = await this.call(link ? 'connect' : 'start', { snapshot: this.snapshot, device,
        ...(link ? { invitation: invitation(link).text } : this.listenAddress ? { listen_address: this.listenAddress } : {}) });
      this.transfer = token(started.handle);
      const invitations = link ? [] : (Array.isArray(started.invitations) ? started.invitations.map(value => invitation(value).text) : failure('invalid-invitation'));
      this.view = { ...this.view, phase: 'pairing', pairing: { code: started.code === undefined ? '' : string(started.code, 64), invitations } };
      return this.status();
    });
  }
  async prepare(peerId: string): Promise<NearbyCoordinatorView> {
    return this.run(async () => {
      await this.initialize(); this.peer = this.preferences!.peers.find(peer => peer.deviceId === peerId) ?? failure('peer-forgotten');
      this.view.peerId = this.peer.deviceId; this.view.peerName = this.peer.name;
      if (!this.replica) this.replica = token((await this.call('replica_open', {
        storage_id: this.preferences!.replicaStorageId, device_id: this.preferences!.deviceId, key: this.preferences!.replicaKey
      })).handle);
      const recovered = await this.source!.recover(); await this.guard();
      if (recovered.length) await this.applyAcknowledgements(recovered);
      if (this.source!.native) await this.refreshNativeBindings();
      let pending = await collectNearbyPending(this.transport!, this.replica, this.abort.signal, this.source!.scope);
      if (pending.length) {
        const saved = await this.source!.saved(pending);
        if (saved.length) { await this.applyAcknowledgements(saved); pending = await collectNearbyPending(this.transport!, this.replica, this.abort.signal, this.source!.scope); }
      }
      await this.guard();
      this.view.recoveryOnly = pending.length > 0;
      if (pending.length || this.preferences!.mode === 'receive_only') {
        this.sourceHash = await this.source!.snapshotHash();
        const empty = await this.call('snapshot_receive_only', { device_id: this.preferences!.deviceId });
        this.snapshot = token(empty.handle); this.revision = string(empty.revision); this.view.phase = 'ready';
      } else {
        const source = await this.source!.capture(); this.sourceHash = source.sourceHash;
        const review = await this.consent.review(source.records.map(row => ({ localId: row.local_id, deleted: row.deleted, data: row.data as NearbyWireData })),
          [peerId], `${this.sessionId}:${this.preferences!.epoch}:${source.sourceHash}:${this.view.operationId}`);
        await this.guard(true);
        await this.scan(source);
        this.view.phase = review ? 'review' : 'ready'; this.view.review = review;
      }
      return this.status();
    });
  }
  private async scanRecords(source: NearbySourceSnapshot): Promise<void> {
    if (this.source!.native) {
      const map = new Map<string, string>();
      for (const records of chunks(source.records)) {
        const result = await this.call('replica_local', { handle: this.replica, local_ids: records.map(r => r.local_id) });
        if (!Array.isArray(result.items)) failure('invalid-binding');
        for (const raw of result.items) {
          const row = wireObject(raw), localId = string(row.local_id, 256), globalId = validId(row.global_id);
          const match = records.find(r => r.local_id === localId); if (!match || map.has(match.global_id)) failure('invalid-binding');
          map.set(match.global_id, globalId);
        }
      }
      source.records = source.records.map(r => ({ ...r, global_id: map.get(r.global_id) ?? r.global_id,
        data: Object.keys(r.data).length ? remapNearbyReferences(r.data as NearbyWireData, id => map.get(id) ?? id) : r.data }));
    }
    await this.call('replica_scan_begin', { handle: this.replica, scopes: [this.source!.scope] });
    for (const entries of chunks(source.records)) await this.call('replica_scan_batch', { handle: this.replica, entries });
    await this.guard(true); await this.call('replica_scan_end', { handle: this.replica });
  }
  private async refreshNativeBindings(): Promise<NearbySourceSnapshot> {
    const source = await this.source!.capture(); this.sourceHash = source.sourceHash;
    await this.scanRecords(source);
    return source;
  }
  private async scan(source: NearbySourceSnapshot): Promise<void> {
    await this.scanRecords(source);
    const exported = await this.call('replica_export', { handle: this.replica });
    if (exported.pending !== false || !Array.isArray(exported.asset_ids)) failure('pending-adoption-required');
    this.snapshot = token(exported.handle); this.revision = string(exported.revision);
    const required = new Set(exported.asset_ids.map(value => string(value, 64)));
    for (const id of required) {
      const bytes = await source.readAsset(id);
      try { await this.guard(); await appendNearbyAsset(this.transport!, this.snapshot, { id, size: bytes.length }, bytes, this.abort.signal); }
      finally { bytes.fill(0); }
    }
    await this.guard(true);
  }
  async confirm(reviewId: string): Promise<NearbyCoordinatorView> {
    return this.run(async () => {
      await this.guard(true);
      if (this.view.phase !== 'review' || !this.consent.confirm(reviewId)) failure('review-stale');
      this.view.phase = 'ready'; delete this.view.review; return this.status();
    });
  }
  async start(address?: NearbyEndpoint): Promise<NearbyCoordinatorView> {
    return this.run(async () => {
      if (this.view.phase !== 'ready' || !this.peer || !this.snapshot) failure('not-ready');
      await this.guard(true);
      const device = nearbyDeviceHello(this.preferences!, this.peer.deviceId);
      if (this.view.recoveryOnly) device.sync_mode = 'receive_only';
      const target = address && endpoint(address);
      const started = await this.call(target ? 'connect' : 'start', { snapshot: this.snapshot, device, expected_device_id: this.peer.deviceId,
        ...(target ? { invitation: `monica-lan:2:${target.addresses.join(',')}:${target.port}:${this.peer.trustedKey}` }
          : { trusted_key: this.peer.trustedKey, ...(this.listenAddress ? { listen_address: this.listenAddress } : {}) }) });
      this.transfer = token(started.handle); this.view.phase = 'transferring';
      if (!target) {
        if (!Array.isArray(started.invitations) || !started.invitations.length) failure('invalid-invitation');
        const link = invitation(started.invitations[0]); if (link.key !== this.peer.trustedKey) failure('peer-key-changed');
        this.view.endpoint = link.address;
      }
      return this.status();
    });
  }
  async poll(): Promise<NearbyCoordinatorView> {
    return this.run(async () => {
      if (!this.transfer) return this.status();
      await this.guard(!this.enrolling && !this.acknowledged);
      const progress = await this.call('progress', { handle: this.transfer });
      if (this.listenerConnect) {
        // cancel() signals the native worker; release() is legal only after it
        // has stopped. Releasing in the same poll races the listening thread.
        if (!['cancelled', 'failed', 'completed'].includes(String(progress.phase))) return this.status();
        const target = this.listenerConnect;
        await this.call('release', { handle: this.transfer }); this.transfer = undefined;
        const device = nearbyDeviceHello(this.preferences!, this.peer!.deviceId);
        if (this.view.recoveryOnly) device.sync_mode = 'receive_only';
        this.transfer = token((await this.call('connect', { snapshot: this.snapshot, device, expected_device_id: this.peer!.deviceId,
          invitation: `monica-lan:2:${target.addresses.join(',')}:${target.port}:${this.peer!.trustedKey}` })).handle);
        this.listenerConnect = undefined; delete this.view.endpoint; return this.status();
      }
      if (progress.phase === 'failed' || progress.phase === 'cancelled') failure('transfer-failed');
      if (progress.phase === 'waiting' && !this.enrolling && this.peer && this.preferences!.deviceId < this.peer.deviceId) {
        // Both devices may start listening at once. One deterministic initiator
        // discovers the other without ever changing or trusting advertised keys.
        if (!this.listenerDiscovery && Date.now() >= this.nextListenerDiscovery) {
          this.listenerDiscovery = token((await this.call('discover')).handle); this.nextListenerDiscovery = Date.now() + 5000;
        } else if (this.listenerDiscovery) {
          const found = await this.call('discovery_result', { handle: this.listenerDiscovery });
          if (found.ready === true) {
            this.listenerDiscovery = undefined;
            const devices = wireObject(found.result).devices;
            if (!Array.isArray(devices) || devices.length > 256) failure('invalid-discovery');
            for (const raw of devices) {
              let target: NearbyEndpoint | undefined;
              try {
                const row = wireObject(raw);
                if (row.protocol === 'monica-lan' && row.version === 2 && row.trusted === true && row.device_id === this.peer.deviceId && row.session === this.peer.pairId)
                  target = endpoint({ addresses: row.address ? [row.address] : row.addresses, port: row.port });
              } catch { /* Unauthenticated UDP hints are optional. */ }
              if (!target) continue;
              await this.guard(true);
              await this.call('cancel', { handle: this.transfer }); this.listenerConnect = target; break;
            }
          }
        }
      }
      if (progress.phase === 'received' && !this.acknowledged) {
        const remote = wireObject(progress.peer), id = validId(remote.device_id);
        if (id === this.preferences!.deviceId || this.peer && this.peer.deviceId !== id || remote.content_type !== 'vault' || remote.vault_content_version !== 2) failure('unexpected-peer');
        if (this.enrolling && remote.revision !== 'pairing-only-v1' || !this.enrolling && remote.revision === 'pairing-only-v1') failure('unexpected-pairing-mode');
        if (typeof remote.receive_content !== 'boolean') failure('invalid-peer');
        this.view.phase = 'saving'; delete this.view.pairing; delete this.view.endpoint;
        if (!this.enrolling && remote.receive_content) await this.adopt();
        await this.remember(remote);
        await this.call('acknowledge', { handle: this.transfer, success: true }); this.acknowledged = true;
      }
      if (progress.phase === 'completed') {
        if (!this.acknowledged) failure('unexpected-completion');
        await this.call('release', { handle: this.transfer }); this.transfer = undefined;
        if (this.snapshot) await this.call('snapshot_release', { handle: this.snapshot }); this.snapshot = undefined;
        this.consent.reset(); this.view.phase = 'completed';
      }
      return this.status();
    });
  }
  private async applyAcknowledgements(acks: NearbyAcknowledgement[]): Promise<void> {
    for (const part of chunks(acks.map(row => ({ record_id: row.recordId, clock: parseLosslessJson(row.clockJson), local_id: row.localId,
      scope: row.scope, guard: row.guard, data: parseLosslessJson(row.dataJson) })))) await this.call('replica_applied_batch', { handle: this.replica, items: part });
  }
  private async adopt(): Promise<void> {
    await this.guard(true); await this.call('replica_merge', { handle: this.replica, session: this.transfer });
    let rounds = 0;
    do {
    if (++rounds > 20_000) failure('pending-adoption-limit');
    const nativeSnapshot = this.source!.native ? await this.refreshNativeBindings() : undefined;
    const pending = await collectNearbyPending(this.transport!, this.replica!, this.abort.signal, this.source!.scope);
    if (!pending.length) break;
    const lookup = new Map(pending.map(row => [row.id, row]));
    const canonicalIds = new Map<string, string>();
    const references: Array<{ id: string; localId: string }> = [];
    const applicationIds = new Set(pending.flatMap(nearbyApplicationReferences));
    const allIds = new Set([...applicationIds, ...(nativeSnapshot ? pending.flatMap(nearbyHierarchyReferences) : [])]);
    for (const ids of chunks([...allIds])) {
      const resolved = await this.call('replica_resolve', { handle: this.replica, ids, scope: this.source!.scope });
      if (!Array.isArray(resolved.items) || resolved.items.length !== ids.length) failure('invalid-reference');
      for (const raw of resolved.items) {
        const entry = wireObject(raw), id = validId(entry.id), global = validId(entry.global_id);
        if (!ids.includes(id) || canonicalIds.has(id)) failure('invalid-reference');
        canonicalIds.set(id, global);
        const staged = lookup.get(global);
        const localId = entry.local_id == null ? staged && (staged.localId ?? (this.source!.native ? undefined : `local:nearby-${global}`)) : string(entry.local_id, 256);
        if (localId) references.push({ id, localId });
      }
    }
    // The revision-bound native scan already contains current project groups;
    // reuse it instead of reading every native payload a second time.
    const nativeByLocal = nativeSnapshot && new Map(nativeSnapshot.records.map(row => [row.local_id, row.data]));
    const localGroups = !pending.some(row => row.deleted) ? undefined : nativeByLocal ? new Map(pending.flatMap(row => {
      const data = row.localId ? nativeByLocal.get(row.localId) : undefined;
      const group = data?.extensions === undefined ? undefined : wireObject(data.extensions).password_group_id;
      return typeof group === 'string' && group ? [[row.id, group] as [string, string]] : [];
    })) : new Map(await this.source!.groups(pending));
    const nativeGroups = nativeSnapshot ? scheduleNearbyNativeGroups(groupNearbyPending(pending, canonicalIds, localGroups, 128, false), nativeSnapshot, canonicalIds) : undefined;
    for (const batch of nativeGroups ? [nativeGroups.flat()] : groupNearbyPending(pending, canonicalIds, localGroups)) {
      const adopt = async (records: NearbyIncomingRecord[]) => {
      const saved = new Set((await this.source!.saved(records)).map(row => row.recordId));
      const assets = new Map<string, { id: string; dataBase64: string }>(); let bytesTotal = 0;
      for (const record of records) if (!saved.has(record.id)) {
        const data = wireObject(parseLosslessJson(record.dataJson));
        for (const raw of (data.assets as unknown[] | undefined) ?? []) {
          const asset = wireObject(raw), id = string(asset.id, 64).toLowerCase(), size = Number(wireInteger(asset.size, 16n * 1024n * 1024n));
          if (assets.has(id)) continue;
          bytesTotal += size; if (bytesTotal > 32 * 1024 * 1024 || assets.size >= 512) failure('asset-batch-limit');
          await this.guard(); const bytes = await readNearbyAsset(this.transport!, this.transfer!, { id, size }, this.abort.signal);
          try { assets.set(id, { id, dataBase64: bytesToBase64(bytes) }); } finally { bytes.fill(0); }
        }
      }
      await this.guard(true);
      const result = await this.source!.adopt({ providerId: this.preferences!.localProviderId, sourceHash: this.sourceHash!, records, references, assets: [...assets.values()] });
      this.sourceHash = result.sourceHash; await this.guard(true); await this.applyAcknowledgements(result.acknowledgements);
      this.view.applied = (this.view.applied ?? 0) + records.length;
      };
      if (nativeGroups) await adoptNearbyNativeGroups(nativeGroups, adopt);
      else await adopt(batch);
    }
    } while (this.source!.native);
    if ((await this.call('replica_revision', { handle: this.replica })).pending !== false) failure('pending-adoption-required');
  }
  private async remember(remote: Record<string, unknown>): Promise<void> {
    await this.guard(!this.enrolling);
    const p = this.preferences!, id = validId(remote.device_id), pairing = wireObject(remote.pairing);
    const peer: NearbySavedPeer = { deviceId: id, name: string(remote.name, 128), pairId: this.peer?.pairId ?? validId(pairing.pair_id),
      trustedKey: this.peer?.trustedKey ?? string(pairing.trusted_key, 43),
      lastSyncedAt: this.enrolling ? 0 : Math.max(Date.now(), this.peer?.lastSyncedAt ?? 0),
      sentRevision: this.enrolling ? '' : this.revision, receivedRevision: this.enrolling ? '' : string(remote.revision),
      receivedRequest: this.enrolling ? '0' : nearbySettingsCounter(remote.sync_request) };
    const view = await this.store.updateNearbyPreferences({ kind: 'remember', peer, enrollment: this.enrolling }, p.epoch, this.sessionId!, this.transactionGuard());
    this.preferences = { ...p, epoch: view.epoch, peers: [...p.peers.filter(entry => entry.deviceId !== id), peer] };
    await this.guard();
    const interval = await this.store.updateNearbyPreferences({ kind: 'remote-interval', peerId: id, pairId: peer.pairId,
      seconds: Number(wireInteger(remote.interval_seconds, 86400n)), version: nearbySettingsCounter(remote.settings_version), writer: string(remote.settings_writer, 64)
    }, this.preferences.epoch, this.sessionId!, this.transactionGuard());
    this.preferences.epoch = interval.epoch;
    await this.guard(); this.view.peerId = id; this.view.peerName = peer.name;
  }
}
