import { parseLosslessJson } from '../core/lossless-json';
import { base64ToBytes, bytesToBase64 } from '../security/encoding';
import type { SecureVaultService } from '../security/secure-vault-service';
import { NearbyNativeTransport, appendNearbyAsset, readNearbyAsset, type NearbyOperation } from './native-transport';
import { NearbyPasskeyConsent, type NearbyPasskeyReview } from './passkey-consent';
import { nearbyDeviceHello, nearbySettingsCounter, type NearbyPreferences, type NearbySavedPeer } from './preferences';
import { collectNearbyPending, groupNearbyPending, nearbyApplicationReferences } from './pending';
import type { NearbyIncomingRecord, NearbyLocalAcknowledgement, NearbyLocalSnapshot } from './local-adoption';
import { NearbyDataError, wireInteger, wireObject, wireText } from './wire-shape';

type Store = Pick<SecureVaultService, 'passkeySessionId' | 'nearbySessionPreferences' | 'assertNearbySession' | 'updateNearbyPreferences'
  | 'captureNearbyLocalRecords' | 'nearbyLocalSnapshotHash' | 'nearbySavedAcknowledgements' | 'nearbyPendingPasswordGroups' | 'adoptNearbyLocalTransaction'>;
export interface NearbyEndpoint { addresses: string[]; port: number }
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

  constructor(private readonly store: Store, private readonly factory: () => NearbyNativeTransport, private readonly listenAddress?: string,
    private readonly assertOwner?: () => void) {}
  status(): NearbyCoordinatorView { return structuredClone(this.view); }
  close(): void {
    this.generation++;
    this.abort.abort(); this.transport?.close(); this.transport = undefined;
    this.consent.reset(); this.preferences = undefined; this.peer = undefined; this.sessionId = undefined;
    this.replica = this.snapshot = this.transfer = this.sourceHash = undefined;
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
        const code = error instanceof NearbyCoordinatorError || error instanceof NearbyDataError ? error.code : 'operation-failed';
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
    if (source && this.sourceHash !== await this.store.nearbyLocalSnapshotHash()) failure('source-changed');
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
    this.view = { phase: 'preparing', operationId: crypto.randomUUID(), applied: 0 };
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
      let pending = await collectNearbyPending(this.transport!, this.replica, this.abort.signal);
      if (pending.length) {
        const saved = await this.store.nearbySavedAcknowledgements(pending, this.sessionId!);
        if (saved.length) { await this.applyAcknowledgements(saved); pending = await collectNearbyPending(this.transport!, this.replica, this.abort.signal); }
      }
      await this.guard();
      this.view.recoveryOnly = pending.length > 0;
      if (pending.length || this.preferences!.mode === 'receive_only') {
        this.sourceHash = await this.store.nearbyLocalSnapshotHash();
        const empty = await this.call('snapshot_receive_only', { device_id: this.preferences!.deviceId });
        this.snapshot = token(empty.handle); this.revision = string(empty.revision); this.view.phase = 'ready';
      } else {
        const source = await this.store.captureNearbyLocalRecords(); this.sourceHash = source.sourceHash;
        const review = await this.consent.review(source.records.map(row => ({ localId: row.local_id, deleted: row.deleted, data: row.data })),
          [peerId], `${this.sessionId}:${this.preferences!.epoch}:${source.sourceHash}:${this.view.operationId}`);
        await this.guard(true);
        await this.scan(source);
        this.view.phase = review ? 'review' : 'ready'; this.view.review = review;
      }
      return this.status();
    });
  }
  private async scan(source: NearbyLocalSnapshot): Promise<void> {
    await this.call('replica_scan_begin', { handle: this.replica, scopes: ['local'] });
    for (const entries of chunks(source.records)) await this.call('replica_scan_batch', { handle: this.replica, entries });
    await this.guard(true); await this.call('replica_scan_end', { handle: this.replica });
    const exported = await this.call('replica_export', { handle: this.replica });
    if (exported.pending !== false || !Array.isArray(exported.asset_ids)) failure('pending-adoption-required');
    this.snapshot = token(exported.handle); this.revision = string(exported.revision);
    const required = new Set(exported.asset_ids.map(value => string(value, 64)));
    const available = new Map(source.assets.map(asset => [asset.id, asset]));
    for (const id of required) {
      const asset = available.get(id) ?? failure('source-asset-missing'), bytes = base64ToBytes(asset.dataBase64);
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
      if (progress.phase === 'failed' || progress.phase === 'cancelled') failure('transfer-failed');
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
  private async applyAcknowledgements(acks: NearbyLocalAcknowledgement[]): Promise<void> {
    for (const part of chunks(acks.map(row => ({ record_id: row.recordId, clock: parseLosslessJson(row.clockJson), local_id: row.localId,
      scope: row.scope, guard: row.guard, data: parseLosslessJson(row.dataJson) })))) await this.call('replica_applied_batch', { handle: this.replica, items: part });
  }
  private async adopt(): Promise<void> {
    await this.guard(true); await this.call('replica_merge', { handle: this.replica, session: this.transfer });
    const pending = await collectNearbyPending(this.transport!, this.replica!, this.abort.signal);
    const lookup = new Map(pending.map(row => [row.id, row]));
    const canonicalIds = new Map<string, string>();
    const references: Array<{ id: string; localId: string }> = [];
    for (const ids of chunks([...new Set(pending.flatMap(nearbyApplicationReferences))])) {
      const resolved = await this.call('replica_resolve', { handle: this.replica, ids, scope: 'local' });
      if (!Array.isArray(resolved.items) || resolved.items.length !== ids.length) failure('invalid-reference');
      for (const raw of resolved.items) {
        const entry = wireObject(raw), id = validId(entry.id), global = validId(entry.global_id);
        if (!ids.includes(id) || canonicalIds.has(id)) failure('invalid-reference');
        canonicalIds.set(id, global);
        const staged = lookup.get(global);
        const localId = entry.local_id == null ? staged && (staged.localId ?? `local:nearby-${global}`) : string(entry.local_id, 256);
        if (localId) references.push({ id, localId });
      }
    }
    const localGroups = pending.some(row => row.deleted) ? new Map(await this.store.nearbyPendingPasswordGroups(pending, this.sessionId!)) : undefined;
    for (const records of groupNearbyPending(pending, canonicalIds, localGroups)) {
      const saved = new Set((await this.store.nearbySavedAcknowledgements(records, this.sessionId!)).map(row => row.recordId));
      const assets = new Map<string, { id: string; dataBase64: string }>(); let bytesTotal = 0;
      for (const record of records) if (!record.deleted && !saved.has(record.id)) {
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
      const result = await this.store.adoptNearbyLocalTransaction({ providerId: this.preferences!.localProviderId, sourceHash: this.sourceHash!, records, references, assets: [...assets.values()] }, this.sessionId!, this.transactionGuard());
      this.sourceHash = result.sourceHash; await this.guard(true); await this.applyAcknowledgements(result.acknowledgements);
      this.view.applied = (this.view.applied ?? 0) + records.length;
    }
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
