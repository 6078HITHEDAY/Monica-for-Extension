import { normalizeCredentialId } from '../passkey/source-policy';
import { jsonScalarText } from '../core/lossless-json';
import { nearbySha256 } from './native-transport';
import { verifyNearbyPasskey } from './passkey-material';
import { invalidNearby, validateNearbyWireData, wireInteger, wireObject, wireText, type NearbyWireData } from './wire-shape';

export interface NearbyReviewRecord { localId: string; deleted: boolean; data: NearbyWireData }
export type NearbyPasskeyRestriction = 'device-only' | 'backup-restricted' | 'counter-history' | 'algorithm-restricted';
export interface NearbyPasskeyIssue {
  id: string;
  account: string;
  relyingParty: string;
  restriction: NearbyPasskeyRestriction;
  skipForCounter: boolean;
}
export interface NearbyPasskeyReview { id: string; peers: string[]; issues: NearbyPasskeyIssue[] }
const text = new TextEncoder();
const display = (value: unknown) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 256) : '';

/** Like Android, a positive counter in another copy of this credential prevents
 * sending a stale zero-count copy. Verification is from current export material,
 * never the UI capability cache. Only display metadata leaves this function. */
export async function inspectNearbyPasskeyIssues(records: readonly NearbyReviewRecord[]): Promise<NearbyPasskeyIssue[]> {
  if (records.length > 100_000) invalidNearby('record-count');
  const keys: Array<{ record: NearbyReviewRecord; payload: Record<string, unknown>; identity: string }> = [];
  const maximum = new Map<string, bigint>();
  const localIds = new Set<string>();
  for (const record of records) {
    if (localIds.has(record.localId) || !record.localId || record.localId.length > 512) invalidNearby('review-identity');
    localIds.add(record.localId);
    if (record.deleted || record.data.entry_type !== 'passkey') continue;
    validateNearbyWireData(record.data);
    const payload = wireObject(record.data.payload);
    await verifyNearbyPasskey(payload);
    const credential = normalizeCredentialId(wireText(payload.credential_id));
    if (!credential) invalidNearby('passkey-identity-missing');
    const identity = JSON.stringify([wireText(payload.rp_id).toLowerCase(), credential]);
    const count = wireInteger(payload.sign_count ?? 0);
    if (count > (maximum.get(identity) ?? 0n)) maximum.set(identity, count);
    keys.push({ record, payload, identity });
  }
  const issues: NearbyPasskeyIssue[] = [];
  for (const { record, payload, identity } of keys) {
    const count = maximum.get(identity) ?? 0n;
    const restriction: NearbyPasskeyRestriction | undefined = payload.key_status === 'reference' ? 'device-only'
      : payload.backup_eligible === false ? 'backup-restricted' : count > 0n ? 'counter-history'
        : payload.public_key_algorithm !== -7 ? 'algorithm-restricted' : undefined;
    if (!restriction) continue;
    // Bind consent to both key material and policy. Neither the original key nor
    // a reusable key hash is exposed in the review sent to the manager.
    const id = await nearbySha256(text.encode(JSON.stringify([record.localId, identity, payload.public_key_algorithm,
      payload.public_key, payload.private_key_alias, payload.key_status, payload.backup_eligible ?? null,
      payload.backup_state ?? null, count.toString(), jsonScalarText(payload.sign_count ?? 0)])));
    issues.push({ id, account: display(payload.user_display_name) || display(payload.user_name) || display(record.data.title),
      relyingParty: display(payload.rp_id), restriction, skipForCounter: count > 0n });
  }
  return issues.sort((left, right) => left.id.localeCompare(right.id));
}

/** Session-only, owned by one coordinator. Clear on lock/source changes or
 * disconnect. A confirmation belongs to the exact pending review and peers;
 * it never grants permission to send a positive-counter key. */
export class NearbyPasskeyConsent {
  private accepted = new Map<string, Set<string>>();
  private pending?: NearbyPasskeyReview;
  private binding?: string;
  private generation = 0;

  async review(records: readonly NearbyReviewRecord[], peers: readonly string[], binding: string): Promise<NearbyPasskeyReview | undefined> {
    if (!binding || !peers.length || peers.length > 100 || peers.some(peer => !/^[A-Za-z0-9_-]{1,128}$/.test(peer))) invalidNearby('review-peers');
    if (binding !== this.binding) { this.reset(); this.binding = binding; }
    const generation = ++this.generation;
    this.pending = undefined;
    const issues = await inspectNearbyPasskeyIssues(records);
    if (generation !== this.generation) invalidNearby('review-stale');
    const targets = [...new Set(peers)].sort();
    const unseen = issues.filter(issue => targets.some(peer => !this.accepted.get(peer)?.has(issue.id)));
    if (!unseen.length) return undefined;
    this.pending = { id: crypto.randomUUID(), peers: targets, issues: unseen };
    return structuredClone(this.pending);
  }

  confirm(id: string): boolean {
    if (!this.pending || id !== this.pending.id) return false;
    for (const peer of this.pending.peers) {
      const accepted = this.accepted.get(peer) ?? new Set<string>();
      for (const issue of this.pending.issues) accepted.add(issue.id);
      this.accepted.set(peer, accepted);
    }
    this.pending = undefined;
    return true;
  }

  clearPending(): void { this.generation++; this.pending = undefined; }
  forget(peer: string): void { this.accepted.delete(peer); this.clearPending(); }
  reset(): void { this.accepted.clear(); this.clearPending(); this.binding = undefined; }
}
