import { describe, expect, it, vi } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderAccount } from '../../core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../../core/project-credentials';
import { readPasswordProjectRemovalJournal, type PasswordProjectRemovalRecord } from '../../core/password-project-removal-journal';
import { assertBitwardenProjectDeletionTransition } from '../../core/bitwarden-project-removal-journal';
import { bytesToBase64 } from '../../security/encoding';
import { BitwardenClient, type BitwardenSessionConfig } from './bitwarden-client';
import { decodeBitwardenCipher, encodeBitwardenCipher } from './bitwarden-cipher-codec';
import { encryptBitwardenString } from './bitwarden-crypto';
import { BitwardenProjectRemovalConflict } from './bitwarden-project-removal-transaction';
import { BitwardenProjectRemovalVerifier } from './bitwarden-project-removal-verification';

const date = '2026-10-09T00:00:00.000Z';
async function fixture(options: { sourcePasskey?: boolean; targetPasskey?: boolean; legacyPasskey?: boolean } = {}) {
  const key = { encKey: crypto.getRandomValues(new Uint8Array(32)), macKey: crypto.getRandomValues(new Uint8Array(32)) };
  const session: BitwardenSessionConfig = { vaultUrl: 'https://example.invalid', apiUrl: 'https://example.invalid/api', identityUrl: 'https://example.invalid/identity',
    email: 'synthetic@example.invalid', deviceId: crypto.randomUUID(), accessToken: 'synthetic-token', expiresAt: Date.now() + 3600000,
    vaultKeyEnc: bytesToBase64(key.encKey), vaultKeyMac: bytesToBase64(key.macKey), kdf: { type: 0, iterations: 1 } };
  const account: ProviderAccount = { id: 'bw', kind: 'bitwarden', name: 'Synthetic', config: session, enabled: true, isDefaultSaveTarget: false };
  const projectId = crypto.randomUUID(), groupId = crypto.randomUUID();
  const raw = new Map<string, Record<string, unknown>>(), rows: LoginItem[] = [];
  for (let index = 0; index < 2; index++) {
    const id = crypto.randomUUID();
    const draft = { ...createLoginItem({ title: 'Project', username: 'synthetic', password: `password-${index}`, providerRefs: [{ providerId: account.id, remoteId: id }] }),
      passwordGroupId: projectId, totpSecret: index === 0 ? 'otpauth://hotp/Synthetic?secret=JBSWY3DPEHPK3PXP&counter=23&digits=8&algorithm=SHA256' : undefined,
      customFields: [{ name: PROJECT_CREDENTIAL_FIELD, protected: true, value: JSON.stringify({ version: 1, projectId, groupId, passwordId: crypto.randomUUID(), primary: true,
        label: 'Primary', groupOrder: 0, passwordOrder: index }) }] };
    const cipher: Record<string, unknown> = { ...await encodeBitwardenCipher(draft, key), id, revisionDate: date, creationDate: date };
    const login = cipher.login as Record<string, unknown>;
    if (index === 0 && options.sourcePasskey || index === 1 && options.targetPasskey) {
      const fields = { credentialId: crypto.randomUUID(), keyType: 'public-key', keyAlgorithm: 'ECDSA', keyCurve: 'P-256', keyValue: '',
        rpId: 'example.invalid', counter: '0', userHandle: 'c3ludGhldGlj', discoverable: 'true', futureField: 'preserve encrypted extension' };
      login.fido2Credentials = [Object.fromEntries(await Promise.all(Object.entries(fields).map(async ([name, value]) => [name, await encryptBitwardenString(value, key)])))];
    }
    if (index === 0 && options.legacyPasskey) cipher.name = await encryptBitwardenString('Synthetic [Passkey]', key);
    raw.set(id, cipher);
    rows.push((await decodeBitwardenCipher(cipher, account.id, key)).items.find((row): row is LoginItem => row.kind === 'login')!);
  }
  const client = new BitwardenClient();
  const sync = vi.spyOn(client, 'sync').mockImplementation(async () => ({ session, payload: { ciphers: structuredClone([...raw.values()]) } }));
  const details = vi.spyOn(client, 'getCipherDetails').mockImplementation(async (_session, id) => ({ session, payload: structuredClone(raw.get(id) || null) }));
  const record: PasswordProjectRemovalRecord = { version: 1, id: crypto.randomUUID(), requestHash: 'a'.repeat(64), createdAt: date, updatedAt: date,
    status: 'preparing', retained: [rows[1]], removed: [rows[0]], providerBindings: [account], proofs: [] };
  const verifier = new BitwardenProjectRemovalVerifier(client, account);
  const prepared = async () => ({ ...record, status: 'deleting' as const, bitwardenDeletion: await verifier.prepare(record) });
  return { raw, rows, key, session, client, account, record, verifier, prepared, sync, details,
    sourceId: rows[0].providerRefs[0].remoteId!, targetId: rows[1].providerRefs[0].remoteId! };
}

describe('uncached Bitwarden project-removal verification', () => {
  it('uses one refreshed session across verification, deletion and authoritative readback', async () => {
    const f = await fixture();
    const rotated = { ...f.session, accessToken: 'rotated-verification-token', refreshToken: 'rotated-refresh-token' };
    f.sync.mockResolvedValue({ session: rotated, payload: { ciphers: structuredClone([...f.raw.values()]) } });
    f.details.mockImplementation(async (session, id) => ({ session, payload: structuredClone(f.raw.get(id) || null) }));
    await f.prepared();
    const afterDelete = { ...rotated, accessToken: 'rotated-delete-token' };
    const remove = vi.spyOn(f.client, 'softDeleteCipher').mockResolvedValue(afterDelete);
    const remote = f.verifier.remote();
    await remote.deleteCipher(f.sourceId);
    expect(remove).toHaveBeenCalledWith(rotated, f.sourceId, undefined);
    await remote.readCipher(f.sourceId);
    expect(f.details).toHaveBeenLastCalledWith(afterDelete, f.sourceId, undefined);
  });

  it('freezes source HOTP and retained Passkey bytes without changing keys, IDs or zero counters', async () => {
    const f = await fixture({ targetPasskey: true });
    const before = structuredClone([...f.raw]);
    const record = await f.prepared();
    expect(record.bitwardenDeletion.retainedSnapshots).toHaveLength(1);
    expect(record.bitwardenDeletion.retainedSnapshots![0].cipherId).toBe(f.targetId);
    await f.verifier.verify(record);
    expect([...f.raw]).toEqual(before);
    expect(f.sync.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(f.details.mock.calls.length).toBeGreaterThanOrEqual(10);
  });

  it.each([{ sourcePasskey: true }, { legacyPasskey: true }])('gates removal of embedded or legacy Passkey carriers: %j', async options => {
    const f = await fixture(options);
    const before = structuredClone([...f.raw]);
    await expect(f.prepared()).rejects.toThrow('包含 Passkey');
    expect([...f.raw]).toEqual(before);
  });

  it('rejects a newly added project member even when it has never been synced locally', async () => {
    const f = await fixture(), record = await f.prepared();
    const id = crypto.randomUUID(); f.raw.set(id, { ...structuredClone(f.raw.get(f.sourceId)!), id });
    await expect(f.verifier.verify(record)).rejects.toMatchObject({ reason: 'retained-changed' });
  });

  it('does not confuse an independent same-title login or unrelated trash with project membership', async () => {
    const f = await fixture(), record = await f.prepared();
    const id = crypto.randomUUID();
    f.raw.set(id, { ...await encodeBitwardenCipher(createLoginItem({ title: 'Project', password: 'unrelated' }), f.key), id, revisionDate: date });
    const trash = crypto.randomUUID(); f.raw.set(trash, { ...structuredClone(f.raw.get(f.sourceId)!), id: trash, deletedDate: date });
    await expect(f.verifier.verify(record)).resolves.toBeUndefined();
  });

  it.each(['retained-note', 'unknown-field', 'passkey-counter', 'retained-trash', 'source-totp'])('detects %s changes before deletion acknowledgement', async mode => {
    const f = await fixture({ targetPasskey: true }), record = await f.prepared();
    const target = f.raw.get(f.targetId)!, source = f.raw.get(f.sourceId)!;
    if (mode === 'retained-note') target.notes = await encryptBitwardenString('concurrent notes', f.key);
    if (mode === 'unknown-field') target.futureServerField = { keep: true };
    if (mode === 'retained-trash') target.deletedDate = date;
    if (mode === 'passkey-counter') ((target.login as Record<string, unknown>).fido2Credentials as Record<string, unknown>[])[0].counter = await encryptBitwardenString('5', f.key);
    if (mode === 'source-totp') (source.login as Record<string, unknown>).totp = await encryptBitwardenString('JBSWY3DPEHPK3PAA', f.key);
    await expect(f.verifier.verify(record)).rejects.toMatchObject({ reason: mode === 'source-totp' ? 'source-changed' : 'retained-changed' });
  });

  it('detects a details-read race even when the first complete sync still had the old value', async () => {
    const f = await fixture(), record = await f.prepared();
    const original = f.details.getMockImplementation()!;
    f.details.mockImplementationOnce(async (...args) => {
      f.raw.get(f.targetId)!.notes = await encryptBitwardenString('changed in details window', f.key);
      return original(...args);
    });
    await expect(f.verifier.verify(record)).rejects.toMatchObject({ reason: 'retained-changed' });
  });

  it('rechecks membership after verification work', async () => {
    const f = await fixture(), record = await f.prepared();
    const previousCalls = f.sync.mock.calls.length, original = f.sync.getMockImplementation()!;
    f.sync.mockImplementation(async (...args) => {
      if (f.sync.mock.calls.length === previousCalls + 2) {
        const id = crypto.randomUUID(); f.raw.set(id, { ...structuredClone(f.raw.get(f.sourceId)!), id });
      }
      return original(...args);
    });
    await expect(f.verifier.verify(record)).rejects.toMatchObject({ reason: 'retained-changed' });
  });

  it.each(['missing-source', 'network', 'unreadable-login', 'malformed-fido', 'conflicting-alias', 'unreadable-field', 'future-project', 'linked-project', 'duplicate-project'])('keeps %s uncertainty distinct from a semantic conflict', async mode => {
    const f = await fixture(), record = await f.prepared();
    if (mode === 'missing-source') f.raw.delete(f.sourceId);
    if (mode === 'network') f.sync.mockRejectedValueOnce(new Error('synthetic network loss'));
    if (mode === 'unreadable-login') {
      const id = crypto.randomUUID(); f.raw.set(id, { ...structuredClone(f.raw.get(f.sourceId)!), id, name: 'invalid ciphertext' });
    }
    if (mode === 'malformed-fido') (f.raw.get(f.sourceId)!.login as Record<string, unknown>).fido2Credentials = { unrecognized: true };
    if (mode === 'conflicting-alias') f.raw.get(f.sourceId)!.Type = 2;
    if (['unreadable-field', 'future-project', 'linked-project', 'duplicate-project'].includes(mode)) {
      const id = crypto.randomUUID(), cipher: Record<string, unknown> = { ...structuredClone(f.raw.get(f.sourceId)!), id };
      const fields = cipher.fields as Record<string, unknown>[];
      if (mode === 'unreadable-field') fields[0].name = 'invalid ciphertext';
      if (mode === 'future-project') fields[0].value = await encryptBitwardenString(f.rows[0].customFields[0].value.replace('"version":1', '"version":2'), f.key);
      if (mode === 'linked-project') { fields[0].type = 3; fields[0].linkedId = 100; }
      if (mode === 'duplicate-project') fields.push(structuredClone(fields[0]));
      f.raw.set(id, cipher);
    }
    const error = await f.verifier.verify(record).then(() => undefined, cause => cause);
    expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(BitwardenProjectRemovalConflict);
  });

  it('rejects stale source drafts without hashing them as an accepted baseline', async () => {
    const f = await fixture(); f.record.removed[0].password = 'unsynced local edit';
    await expect(f.prepared()).rejects.toMatchObject({ reason: 'source-changed' });
  });

  it('accepts server revision/tombstone changes after an attempted source deletion', async () => {
    const f = await fixture(), record = await f.prepared();
    record.bitwardenDeletion.members[0].stage = 'delete-attempted';
    Object.assign(f.raw.get(f.sourceId)!, { deletedDate: date, revisionDate: '2026-10-09T00:01:00.000Z' });
    await expect(f.verifier.verify(record)).resolves.toBeUndefined();
  });

  it('rejects missing, duplicated or rewritten retained baselines and wrong account bindings', async () => {
    const f = await fixture(), record = await f.prepared();
    const journal = record.bitwardenDeletion;
    expect(() => readPasswordProjectRemovalJournal([{ ...record, bitwardenDeletion: { ...journal, retainedSnapshots: [] } }])).toThrow();
    expect(() => assertBitwardenProjectDeletionTransition(journal, { ...journal, revision: journal.revision + 1,
      members: journal.members.map(row => ({ ...row, stage: 'delete-attempted' })), retainedSnapshots: journal.retainedSnapshots!.map(row => ({ ...row, snapshotSha256: 'b'.repeat(64) })) })).toThrow();
    const missing = structuredClone(record); delete missing.bitwardenDeletion.retainedSnapshots;
    await expect(f.verifier.verify(missing)).rejects.toThrow('无法完整核实');
    const rebound = new BitwardenProjectRemovalVerifier(f.client, { ...f.account, config: { ...f.session, email: 'different@example.invalid' } });
    await expect(rebound.verify(record)).rejects.toThrow('无法完整核实');
  });
});
