import { jsonNumber, jsonScalarText } from '../core/lossless-json';
import type { ProviderAccount } from '../core/model';
import { bytesToBase64 } from '../security/encoding';

export type NearbySyncMode = 'bidirectional' | 'send_only' | 'receive_only';
export interface NearbySavedPeer {
  deviceId: string; name: string; pairId: string; trustedKey: string;
  lastSyncedAt: number; sentRevision: string; receivedRevision: string; receivedRequest: string;
}
export interface NearbyPreferences {
  version: 1;
  /** Compare-and-set token. Any local change invalidates outstanding sessions. */
  epoch: string;
  deviceId: string; name: string; replicaStorageId: string; replicaKey: string;
  /** Automatic networking is opt-in; construction never starts a listener. */
  enabled: boolean; mode: NearbySyncMode; intervalSeconds: number;
  settingsVersion: string; settingsWriter: string; syncRequest: string;
  /** Selected sync source. Field name retained for existing encrypted settings. */
  localProviderId: string;
  peers: NearbySavedPeer[];
}
export interface NearbyPreferencesView {
  epoch: string; name: string; enabled: boolean; mode: NearbySyncMode; intervalSeconds: number; localProviderId: string;
  peers: Array<Pick<NearbySavedPeer, 'deviceId' | 'name' | 'lastSyncedAt'>>;
}
export type NearbyPreferencesChange =
  | { kind: 'preferences'; name?: string; enabled?: boolean; mode?: NearbySyncMode; intervalSeconds?: number }
  | { kind: 'source'; providerId: string }
  | { kind: 'forget'; deviceId: string }
  | { kind: 'request-sync' }
  /** Internal coordinator only: obtained from authenticated native progress after application adoption. */
  | { kind: 'remember'; peer: NearbySavedPeer; enrollment: boolean }
  | { kind: 'remote-interval'; peerId: string; pairId: string; seconds: number; version: string; writer: string };

const identifier = /^[A-Za-z0-9_-]{1,64}$/;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const limit = 9223372036854775807n;
export class NearbyPreferencesError extends Error {
  constructor(readonly code: string) { super(`Nearby settings: ${code}.`); this.name = 'NearbyPreferencesError'; }
}
function fail(code: string): never { throw new NearbyPreferencesError(code); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-state');
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('unsupported-fields');
}
function id(value: unknown, empty = false): asserts value is string {
  if (typeof value !== 'string' || !(empty && value === '') && !identifier.test(value)) fail('invalid-identity');
}
function name(value: unknown, required = true): asserts value is string {
  if (typeof value !== 'string' || required && !value.trim() || [...value].length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) fail('invalid-name');
}
function long(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > limit) fail('invalid-counter');
  return BigInt(value);
}
function increment(value: string): string { const n = long(value); if (n === limit) fail('counter-exhausted'); return String(n + 1n); }
function interval(value: unknown): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value !== 0 && (value < 60 || value > 86400)) fail('invalid-interval');
}
function secret(value: unknown): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) fail('invalid-key');
  // Canonical URL-safe encoding of exactly 32 bytes, with no ambiguous pad bits.
  const decoded = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='), c => c.charCodeAt(0));
  try { if (decoded.length !== 32 || base64url(decoded) !== value) fail('invalid-key'); } finally { decoded.fill(0); }
}
function base64url(bytes: Uint8Array): string { return bytesToBase64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function peer(value: unknown): NearbySavedPeer {
  const p = object(value);
  fields(p, ['deviceId', 'name', 'pairId', 'trustedKey', 'lastSyncedAt', 'sentRevision', 'receivedRevision', 'receivedRequest']);
  id(p.deviceId); id(p.pairId); name(p.name, false); secret(p.trustedKey); long(p.receivedRequest);
  if (typeof p.lastSyncedAt !== 'number' || !Number.isSafeInteger(p.lastSyncedAt) || p.lastSyncedAt < 0 || p.lastSyncedAt > 253402300799999) fail('invalid-time');
  for (const value of [p.sentRevision, p.receivedRevision]) if (typeof value !== 'string' || value.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) fail('invalid-revision');
  return structuredClone(p) as unknown as NearbySavedPeer;
}

/** Invalid saved trust must never silently reset into a new device or pairing. */
export function readNearbyPreferences(value: unknown): NearbyPreferences | undefined {
  if (value === undefined) return undefined;
  const p = object(value);
  fields(p, ['version', 'epoch', 'deviceId', 'name', 'replicaStorageId', 'replicaKey', 'enabled', 'mode', 'intervalSeconds',
    'settingsVersion', 'settingsWriter', 'syncRequest', 'localProviderId', 'peers']);
  if (p.version !== 1 || typeof p.epoch !== 'string' || !uuid.test(p.epoch) || typeof p.replicaStorageId !== 'string' || !uuid.test(p.replicaStorageId)) fail('unsupported-state');
  id(p.deviceId); name(p.name); secret(p.replicaKey); id(p.settingsWriter, true); interval(p.intervalSeconds);
  long(p.settingsVersion); long(p.syncRequest);
  if (typeof p.enabled !== 'boolean' || !['bidirectional', 'send_only', 'receive_only'].includes(p.mode as string)
    || typeof p.localProviderId !== 'string' || !p.localProviderId || p.localProviderId.length > 256 || !Array.isArray(p.peers) || p.peers.length > 8) fail('invalid-state');
  const peers = p.peers.map(peer), ids = new Set<string>(), pairs = new Set<string>();
  for (const entry of peers) {
    if (entry.deviceId === p.deviceId || ids.has(entry.deviceId) || pairs.has(entry.pairId)) fail('duplicate-peer');
    ids.add(entry.deviceId); pairs.add(entry.pairId);
  }
  return { ...structuredClone(p), peers } as unknown as NearbyPreferences;
}

export function createNearbyPreferences(provider: ProviderAccount): NearbyPreferences {
  if (!provider.enabled || !['local', 'mdbx2'].includes(provider.kind)) fail('local-provider-required');
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  try {
    return readNearbyPreferences({ version: 1, epoch: crypto.randomUUID(), deviceId: crypto.randomUUID().replace(/-/g, ''), name: 'Monica Browser',
      replicaStorageId: crypto.randomUUID(), replicaKey: base64url(bytes), enabled: false, mode: 'bidirectional', intervalSeconds: 0,
      settingsVersion: '0', settingsWriter: '', syncRequest: '0', localProviderId: provider.id, peers: [] })!;
  } finally { bytes.fill(0); }
}

/** Deliberate allow-list: never return a replica secret, pair secret or storage handle to UI. */
export function nearbyPreferencesView(p: NearbyPreferences): NearbyPreferencesView {
  const value = readNearbyPreferences(p)!;
  return { epoch: value.epoch, name: value.name, enabled: value.enabled, mode: value.mode, intervalSeconds: value.intervalSeconds,
    localProviderId: value.localProviderId, peers: value.peers.map(({ deviceId, name, lastSyncedAt }) => ({ deviceId, name, lastSyncedAt })) };
}

export function changeNearbyPreferences(saved: NearbyPreferences, change: NearbyPreferencesChange, expectedEpoch: string): NearbyPreferences {
  const p = readNearbyPreferences(saved)!;
  if (p.epoch !== expectedEpoch) fail('stale-session');
  const input = object(change);
  switch (change.kind) {
    case 'preferences':
      fields(input, ['kind', 'name', 'enabled', 'mode', 'intervalSeconds']);
      if (change.name !== undefined) p.name = change.name;
      if (change.enabled !== undefined) p.enabled = change.enabled;
      if (change.mode !== undefined && change.mode !== p.mode) { p.mode = change.mode; p.syncRequest = increment(p.syncRequest); }
      if (change.intervalSeconds !== undefined && change.intervalSeconds !== p.intervalSeconds) {
        p.intervalSeconds = change.intervalSeconds; p.settingsVersion = increment(p.settingsVersion); p.settingsWriter = p.deviceId;
      }
      break;
    case 'source':
      fields(input, ['kind', 'providerId']);
      if (p.peers.length) fail('source-paired');
      if (typeof change.providerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(change.providerId)) fail('invalid-identity');
      if (p.localProviderId !== change.providerId) {
        p.localProviderId = change.providerId; p.replicaStorageId = crypto.randomUUID();
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        try { p.replicaKey = base64url(bytes); } finally { bytes.fill(0); }
      }
      break;
    case 'forget': fields(input, ['kind', 'deviceId']); id(change.deviceId); p.peers = p.peers.filter(peer => peer.deviceId !== change.deviceId); break;
    case 'request-sync': fields(input, ['kind']); p.syncRequest = increment(p.syncRequest); break;
    case 'remember': {
      fields(input, ['kind', 'peer', 'enrollment']);
      if (typeof change.enrollment !== 'boolean') fail('invalid-enrollment');
      const incoming = peer(change.peer), old = p.peers.find(peer => peer.deviceId === incoming.deviceId);
      if (old && (old.pairId !== incoming.pairId || old.trustedKey !== incoming.trustedKey)) fail('peer-key-changed');
      if (!old && !change.enrollment) fail('peer-forgotten');
      if (old && (incoming.lastSyncedAt < old.lastSyncedAt || long(incoming.receivedRequest) < long(old.receivedRequest))) fail('peer-history-regression');
      p.peers = [...p.peers.filter(peer => peer.deviceId !== incoming.deviceId), incoming];
      break;
    }
    case 'remote-interval': {
      fields(input, ['kind', 'peerId', 'pairId', 'seconds', 'version', 'writer']);
      id(change.peerId); id(change.pairId); id(change.writer, true); interval(change.seconds);
      if (!p.peers.some(peer => peer.deviceId === change.peerId && peer.pairId === change.pairId)) fail('peer-forgotten');
      const version = long(change.version), current = long(p.settingsVersion);
      if (version > current || version === current && change.writer > p.settingsWriter) {
        p.intervalSeconds = change.seconds; p.settingsVersion = change.version; p.settingsWriter = change.writer;
      }
      break;
    }
    default: fail('unsupported-change');
  }
  // Even a no-op forget invalidates in-flight enrollment results for that peer.
  p.epoch = crypto.randomUUID();
  return readNearbyPreferences(p)!;
}

/** Raw numeric values stay exact through the transport's lossless JSON path. */
export function nearbyDeviceHello(p: NearbyPreferences, peerId?: string): Record<string, unknown> {
  const value = readNearbyPreferences(p)!, peer = peerId === undefined ? undefined : value.peers.find(peer => peer.deviceId === peerId);
  if (peerId !== undefined && !peer) fail('peer-forgotten');
  return { device_id: value.deviceId, name: value.name, pair_id: peer?.pairId ?? '', interval_seconds: value.intervalSeconds,
    settings_version: jsonNumber(value.settingsVersion), settings_writer: value.settingsWriter,
    sync_request: jsonNumber(value.syncRequest), sync_mode: value.mode };
}

/** Convert a native integer to the encrypted string representation without rounding. */
export function nearbySettingsCounter(value: unknown): string {
  const result = jsonScalarText(value); long(result);
  if (typeof value === 'string' || typeof value === 'number' && !Number.isSafeInteger(value)) fail('invalid-counter');
  return result;
}
