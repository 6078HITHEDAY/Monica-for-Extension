import type { ProviderAccount } from '../../core/model';
import { sameProviderBinding } from '../../core/provider';
import { parseLosslessJson } from '../../core/lossless-json';
import type { SecureVaultService } from '../../security/secure-vault-service';
import type { PasswordProjectRemovalProof } from '../../core/password-project-removal-journal';
import { BitwardenClient, type BitwardenSessionConfig } from './bitwarden-client';
import type { BitwardenSymmetricKey } from './bitwarden-crypto';
import { resolveBitwardenOrganizationKeys } from './bitwarden-organization';
import { ciphersOf } from './bitwarden-sync-cache';
import { bitwardenRemovalSnapshotSha256 } from './bitwarden-project-removal-transaction';
import { hasBitwardenPasskeyPreservationMarker, planBitwardenPasskeyPreservation, verifyBitwardenPasskeyPreservationCopy, verifyBitwardenPasskeyPreservationPlan,
  type BitwardenPasskeyPreservationCopy, type BitwardenPasskeyPreservationPlan } from './bitwarden-passkey-preservation';
import { BitwardenPasskeyPreservationTransaction } from './bitwarden-passkey-preservation-transaction';

const fail = () => new Error('无法确认 Passkey 保留副本，原始密码和凭据均已保留。');
const clear = (key: BitwardenSymmetricKey) => { key.encKey.fill(0); key.macKey.fill(0); };
const field = (raw: Record<string, unknown>, name: string): unknown => {
  const upper = name[0].toUpperCase() + name.slice(1);
  if (name in raw && upper in raw && JSON.stringify(raw[name]) !== JSON.stringify(raw[upper])) throw fail();
  return raw[name] ?? raw[upper];
};

/** Internal copy-only preparation. The provider queue must cover this call.
 * No source deletion is enabled by preparing these durable copies alone. */
export class BitwardenPasskeyPreservationPreparation {
  private session: BitwardenSessionConfig;
  private active?: Promise<void>;
  constructor(private readonly client: BitwardenClient, private readonly account: ProviderAccount,
    private readonly vault: SecureVaultService, private readonly operationId: string, private readonly signal?: AbortSignal,
    private readonly proofs?: PasswordProjectRemovalProof[]) {
    if (account.kind !== 'bitwarden' || !account.enabled) throw fail();
    this.account = structuredClone(account);
    this.session = structuredClone(account.config) as BitwardenSessionConfig;
  }

  prepare(): Promise<void> { return this.active ??= this.run().finally(() => { this.active = undefined; }); }

  private async guard(requireJournal = true) {
    this.signal?.throwIfAborted();
    const record = requireJournal ? await this.vault.inspectPasswordProjectBitwardenPasskeyPreservation(this.operationId)
      : (await this.vault.inspectPasswordProjectRemoval(this.operationId)).record;
    const external = record.providerBindings.filter(row => row.kind !== 'local');
    const current = await this.vault.getProvider(this.account.id);
    if (external.length !== 1 || !sameProviderBinding(external[0], this.account) || !current?.enabled || !sameProviderBinding(current, this.account)) throw fail();
    // A restarted worker must use the vault's latest refreshed session.
    this.session = structuredClone(current.config) as BitwardenSessionConfig;
    return record;
  }

  private async acceptSession(session: BitwardenSessionConfig) {
    const current = await this.vault.getProvider(this.account.id);
    const refreshed = { ...this.account, config: session };
    if (!current?.enabled || !sameProviderBinding(current, refreshed) || !sameProviderBinding(this.account, refreshed)) throw fail();
    this.session = session;
    if (JSON.stringify(current.config) !== JSON.stringify(session))
      await this.vault.upsertProvider({ ...current, config: { ...current.config, ...session } }, false, current);
  }

  private async sync(requireJournal = true) {
    await this.guard(requireJournal);
    const result = await this.client.sync(this.session, this.signal); await this.acceptSession(result.session);
    if (!Array.isArray(field(result.payload, 'ciphers')) || field(result.payload, 'continuationToken') != null) throw fail();
    ciphersOf(result.payload); return result.payload;
  }

  private async details(id: string, requireJournal = true) {
    await this.guard(requireJournal);
    const result = await this.client.getCipherDetails(this.session, id, this.signal); await this.acceptSession(result.session);
    if (!result.payload || field(result.payload, 'id') !== id) throw fail();
    return result.payload;
  }

  private async withKey<T>(payload: Record<string, unknown>, raw: Record<string, unknown>, callback: (key: BitwardenSymmetricKey) => Promise<T>): Promise<T> {
    const vaultKey = this.client.vaultKey(this.session);
    let organizations: Awaited<ReturnType<typeof resolveBitwardenOrganizationKeys>> | undefined;
    try {
      const organization = field(raw, 'organizationId');
      if (organization == null || organization === '') return await callback(vaultKey);
      if (typeof organization !== 'string') throw fail();
      organizations = await resolveBitwardenOrganizationKeys(payload, vaultKey);
      const key = organizations.keys.get(organization); if (!key) throw fail();
      return await callback(key);
    } finally { organizations?.keys.forEach(clear); clear(vaultKey); }
  }

  private async findCopies(copy: BitwardenPasskeyPreservationCopy) {
    const payload = await this.sync(), expected = parseLosslessJson(copy.payloadJson) as Record<string, unknown>;
    const matches: Record<string, unknown>[] = [];
    for (const raw of ciphersOf(payload)) {
      this.signal?.throwIfAborted();
      if ((field(raw, 'organizationId') ?? null) !== (expected.organizationId ?? null)) continue;
      if (await this.withKey(payload, raw, key => hasBitwardenPasskeyPreservationMarker(copy, raw, key))) matches.push(raw);
    }
    return matches;
  }

  private async run() {
    let record = await this.guard(false);
    if (!record.bitwardenPasskeyPreservation) {
      const payload = await this.sync(false), ciphers = ciphersOf(payload), plans: BitwardenPasskeyPreservationPlan[] = [];
      for (const row of record.removed) {
        const id = row.providerRefs.find(ref => ref.providerId === this.account.id)?.remoteId;
        if (!id || /[:#]/.test(id)) throw fail();
        const source = await this.details(id, false), synced = ciphers.find(raw => field(raw, 'id') === id);
        if (!synced || field(source, 'deletedDate') || await bitwardenRemovalSnapshotSha256(source) !== await bitwardenRemovalSnapshotSha256(synced)) throw fail();
        plans.push(await this.withKey(payload, source, key => planBitwardenPasskeyPreservation(this.operationId, source, key)));
      }
      record = await this.vault.initializePasswordProjectBitwardenPasskeyPreservation(this.operationId, plans, this.proofs);
    }
    for (const source of record.bitwardenPasskeyPreservation!.sources) {
      const plan = source.plan;
      const payload = await this.sync(), original = await this.details(plan.sourceCipherId);
      await this.withKey(payload, original, key => verifyBitwardenPasskeyPreservationPlan(plan, original, key));
      const transaction = new BitwardenPasskeyPreservationTransaction({
        read: async () => (await this.guard()).bitwardenPasskeyPreservation!.sources.find(row => row.plan.sourceCipherId === plan.sourceCipherId)!,
        update: (revision, journal) => this.vault.updatePasswordProjectBitwardenPasskeyPreservation(this.operationId, plan.sourceCipherId, revision, journal)
      }, {
        readSource: () => this.details(plan.sourceCipherId),
        findCopies: copy => this.findCopies(copy),
        createCopy: async copy => {
          await this.guard();
          const result = await this.client.createCipherOnce(this.session, parseLosslessJson(copy.payloadJson) as Record<string, unknown>, this.signal);
          await this.acceptSession(result.session); return result.payload;
        },
        verifyCopy: async (copy, raw) => {
          const id = field(raw, 'id'); if (typeof id !== 'string' || !id || /[:#]/.test(id)) throw fail();
          const payload = await this.sync(), observed = await this.details(id);
          return this.withKey(payload, observed, key => verifyBitwardenPasskeyPreservationCopy(plan, copy, observed, key));
        }
      });
      await transaction.resume();
    }
    await this.guard();
  }
}
