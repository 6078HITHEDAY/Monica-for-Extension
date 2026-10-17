import type { NearbyEndpoint } from './local-coordinator';
import type { NearbyPreferencesChange } from './preferences';

export const NEARBY_MANAGER_PORT = 'monica-nearby-manager-v1';
export type NearbyManagerChange = Extract<NearbyPreferencesChange, { kind: 'preferences' | 'forget' | 'request-sync' }>;
export type NearbyManagerRequest = { id: number } & (
  | { type: 'status' | 'preferences' | 'progress' | 'cancel' }
  | { type: 'update'; epoch: string; change: NearbyManagerChange }
  | { type: 'pair'; invitation?: string }
  | { type: 'prepare'; peerId: string }
  | { type: 'confirm'; reviewId: string }
  | { type: 'start'; endpoint?: NearbyEndpoint }
);

const identifier = /^[A-Za-z0-9_-]{1,64}$/;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
function invalid(): never { throw new Error('Invalid nearby manager request'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).some(key => !names.includes(key))) invalid();
}
function text(value: unknown, pattern: RegExp): void { if (typeof value !== 'string' || !pattern.test(value)) invalid(); }

/** A bounded, high-level API. Native operations, trust keys and records are never accepted. */
export function readNearbyManagerRequest(value: unknown): NearbyManagerRequest {
  const p = object(value);
  if (typeof p.id !== 'number' || !Number.isSafeInteger(p.id) || p.id < 1) invalid();
  switch (p.type) {
    case 'status': case 'preferences': case 'progress': case 'cancel': fields(p, ['id', 'type']); break;
    case 'pair':
      fields(p, ['id', 'type', 'invitation']);
      if (p.invitation !== undefined && (typeof p.invitation !== 'string' || p.invitation.length > 512)) invalid();
      break;
    case 'prepare': fields(p, ['id', 'type', 'peerId']); text(p.peerId, identifier); break;
    case 'confirm': fields(p, ['id', 'type', 'reviewId']); text(p.reviewId, uuid); break;
    case 'start': {
      fields(p, ['id', 'type', 'endpoint']);
      if (p.endpoint !== undefined) {
        const e = object(p.endpoint); fields(e, ['addresses', 'port']);
        if (!Array.isArray(e.addresses) || !e.addresses.length || e.addresses.length > 8
          || e.addresses.some(a => typeof a !== 'string' || a.length > 15)
          || typeof e.port !== 'number' || !Number.isInteger(e.port) || e.port < 1 || e.port > 65535) invalid();
      }
      break;
    }
    case 'update': {
      fields(p, ['id', 'type', 'epoch', 'change']); text(p.epoch, uuid);
      const c = object(p.change);
      switch (c.kind) {
        case 'preferences':
          fields(c, ['kind', 'name', 'enabled', 'mode', 'intervalSeconds']);
          if (c.name !== undefined && (typeof c.name !== 'string' || !c.name.trim() || [...c.name].length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(c.name))) invalid();
          if (c.enabled !== undefined && typeof c.enabled !== 'boolean') invalid();
          if (c.mode !== undefined && !['bidirectional', 'send_only', 'receive_only'].includes(c.mode as string)) invalid();
          if (c.intervalSeconds !== undefined && (typeof c.intervalSeconds !== 'number' || !Number.isInteger(c.intervalSeconds)
            || c.intervalSeconds !== 0 && (c.intervalSeconds < 60 || c.intervalSeconds > 86400))) invalid();
          break;
        case 'forget': fields(c, ['kind', 'deviceId']); text(c.deviceId, identifier); break;
        case 'request-sync': fields(c, ['kind']); break;
        default: invalid();
      }
      break;
    }
    default: invalid();
  }
  return structuredClone(p) as NearbyManagerRequest;
}
