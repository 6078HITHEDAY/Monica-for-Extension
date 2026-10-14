import { describe, expect, it, vi } from 'vitest';
import { createEmptyVaultState, createLoginItem, type ProviderSourceRecord } from '../core/model';
import { applyNearbyLocalBatch, captureNearbyLocalSnapshot } from '../nearby/local-adoption';
import { mergeNearbyOrigins, nearbyLocalOrigins, withNearbyOrigins } from '../nearby/local-origins';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';
import { MemoryVaultDeviceKeyStore } from './vault-device-key';
import { applyLocalTransferBatch, prepareLocalTransferBatch } from '../core/local-transfer';
import { createSourceRecord } from '../core/source-records';

const label = 'monica:extension-local-origins:v1';
const now = '2026-10-14T01:00:00.000Z';
const archive: ProviderSourceRecord = { providerId: 'former-provider', itemId: 'former-item', remoteId: 'former-remote',
  revision: 'old-revision', format: 'future-source-format', encoding: 'json', contentHash: 'original-hash',
  payload: '{ "opaque":9007199254740993,"decimal":1.00000000000000001,"password":"synthetic archived secret" }' };
function fixture() {
  const state = createEmptyVaultState(); state.items = [createLoginItem({ title: 'Imported project', password: 'synthetic current secret' })];
  return state;
}
function archives(data: Record<string, any>): ProviderSourceRecord[] {
  const value = data.labels?.find((row: any) => row.name === label);
  return value ? JSON.parse(value.payload).records : [];
}
async function source() {
  const state = fixture(); state.localItemOrigins = [{ itemId: state.items[0].id, records: [archive] }];
  const snapshot = await captureNearbyLocalSnapshot(state), row = snapshot.records[0];
  return { state, snapshot, row, record: { id: row.global_id, dataJson: JSON.stringify(row.data), deleted: false, clockJson: '{"peer":1}' } };
}
async function encrypted() {
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore(), keys = new MemoryVaultDeviceKeyStore();
  const service = new SecureVaultService(storage, sessions, Date.now, keys); await service.setup('', []);
  const providerId = (await service.readState()).providers[0].id, sessionId = (await service.passkeySessionId())!;
  return { storage, sessions, keys, service, providerId, sessionId };
}
describe('nearby local archival source preservation', () => {
  it('exports an existing source archive before any nearby receipt exists', async () => {
    const state = fixture(); state.localItemOrigins = [{ itemId: state.items[0].id, records: [archive] }];
    const snapshot = await captureNearbyLocalSnapshot(state);
    expect(archives(snapshot.records[0].data)).toEqual([archive]);
  });
  it('does not let an existing receipt silently omit a later source archive', async () => {
    let state = fixture(); const snapshot = await captureNearbyLocalSnapshot(state), record = snapshot.records[0];
    state = (await applyNearbyLocalBatch(state, { providerId: state.providers[0].id, sourceHash: snapshot.sourceHash, assets: [], records: [{
      id: record.global_id, localId: record.local_id, scope: record.scope, expectedGuard: record.guard,
      deleted: false, dataJson: JSON.stringify(record.data), clockJson: '{"peer":1}' }] }, now)).state;
    state.localItemOrigins = [{ itemId: state.items[0].id, records: [archive] }];
    expect(archives((await captureNearbyLocalSnapshot(state)).records[0].data)).toEqual([archive]);
  });
  it('atomically saves encrypted archives without creating provider bindings, then preserves them through restart, edits and portable backup', async () => {
    const s = await source(), f = await encrypted();
    await f.service.adoptNearbyLocalRecords({ providerId: f.providerId, sourceHash: await f.service.nearbyLocalSnapshotHash(), records: [s.record], assets: [] }, f.sessionId);
    const restored = new SecureVaultService(f.storage, f.sessions, Date.now, f.keys), state = await restored.readState();
    expect(state.providers).toHaveLength(1); expect(state.sourceRecords).toEqual([]); expect(state.items).toHaveLength(1);
    expect(state.items[0].providerRefs).toEqual([{ providerId: f.providerId }]);
    expect(state.localItemOrigins).toEqual([{ itemId: state.items[0].id, records: [archive] }]);
    expect(JSON.stringify(await f.storage.read())).not.toContain('synthetic archived secret');
    await restored.upsertItem({ ...state.items[0], notes: 'edited after restart' });
    const snapshot = await restored.captureNearbyLocalRecords(); expect(archives(snapshot.records[0].data)).toEqual([archive]);
    expect(snapshot.records[0].data.notes).toBe('edited after restart');
    const backup = await restored.exportEncryptedBackup('Synthetic archive backup');
    const fresh = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore(), Date.now, new MemoryVaultDeviceKeyStore());
    await fresh.restoreEncryptedBackup(backup, 'Synthetic archive backup');
    expect((await fresh.readState()).localItemOrigins).toEqual(state.localItemOrigins);
    expect(archives((await fresh.captureNearbyLocalRecords()).records[0].data)).toEqual([archive]);
  });
  it('recovers lost encrypted commit replies without duplicating archives or overwriting later edits', async () => {
    const s = await source(), f = await encrypted(), original = f.storage.write.bind(f.storage);
    vi.spyOn(f.storage, 'write').mockImplementationOnce(async value => { await original(value); throw Error('synthetic lost reply'); });
    const input = { providerId: f.providerId, sourceHash: await f.service.nearbyLocalSnapshotHash(), records: [s.record], assets: [] };
    await expect(f.service.adoptNearbyLocalRecords(input, f.sessionId)).rejects.toThrow('synthetic lost reply');
    const service = new SecureVaultService(f.storage, f.sessions, Date.now, f.keys), state = await service.readState();
    await service.upsertItem({ ...state.items[0], notes: 'later local change' });
    const before = await f.storage.read();
    const acknowledgements = await service.adoptNearbyLocalRecords(input, f.sessionId);
    expect(archives(JSON.parse(acknowledgements[0].dataJson))).toEqual([archive]);
    expect(await f.storage.read()).toEqual(before);
    expect((await service.readState()).localItemOrigins).toHaveLength(1);
  });
  it('rejects an old item guard if only the archive changed, including when its provider hash and revision did not', async () => {
    const s = await source(); s.state.localItemOrigins![0].records[0].payload += ' ';
    const before = structuredClone(s.state), updated = await captureNearbyLocalSnapshot(s.state);
    expect(updated.records[0].guard).not.toBe(s.row.guard);
    await expect(applyNearbyLocalBatch(s.state, { providerId: s.state.providers[0].id, sourceHash: updated.sourceHash, assets: [],
      records: [{ ...s.record, localId: s.row.local_id, scope: s.row.scope, expectedGuard: s.row.guard }] }, now)).rejects.toThrow('local-binding-changed');
    expect(s.state).toEqual(before);
  });
  it('merges immutable versions without trusting reused provider hashes and acknowledges the complete union', async () => {
    const s = await source(), other = { ...archive, payload: '{"password":"another archived version"}' };
    s.state.localItemOrigins![0].records.push(other);
    const current = await captureNearbyLocalSnapshot(s.state);
    const result = await applyNearbyLocalBatch(s.state, { providerId: s.state.providers[0].id, sourceHash: current.sourceHash, assets: [],
      records: [{ ...s.record, localId: s.row.local_id, scope: s.row.scope, expectedGuard: current.records[0].guard }] }, now);
    const expected = mergeNearbyOrigins([archive, other]);
    expect(nearbyLocalOrigins(result.state, s.state.items[0].id)).toEqual(expected);
    expect(archives(JSON.parse(result.acknowledgements[0].dataJson))).toEqual(expected);
    expect(mergeNearbyOrigins([other, archive, archive])).toEqual(expected);
    const next = await captureNearbyLocalSnapshot(result.state);
    const withoutLabel = { ...next.records[0].data, labels: [] };
    const absent = await applyNearbyLocalBatch(result.state, { providerId: s.state.providers[0].id, sourceHash: next.sourceHash, assets: [],
      records: [{ ...s.record, clockJson: '{"peer":2}', localId: s.row.local_id, scope: s.row.scope, expectedGuard: next.records[0].guard, dataJson: JSON.stringify(withoutLabel) }] }, now);
    expect(archives(JSON.parse(absent.acknowledgements[0].dataJson))).toEqual(expected);
  });
  it('recovers archives retained only in an older client receipt when the next peer omits the label', async () => {
    const s = await source(), receiver = createEmptyVaultState();
    const adopted = await applyNearbyLocalBatch(receiver, { providerId: receiver.providers[0].id, sourceHash: (await captureNearbyLocalSnapshot(receiver)).sourceHash,
      assets: [], records: [s.record] }, now);
    delete adopted.state.localItemOrigins;
    const snapshot = await captureNearbyLocalSnapshot(adopted.state), row = snapshot.records[0];
    const result = await applyNearbyLocalBatch(adopted.state, { providerId: receiver.providers[0].id, sourceHash: snapshot.sourceHash, assets: [],
      records: [{ ...s.record, clockJson: '{"peer":2}', localId: row.local_id, scope: row.scope, expectedGuard: row.guard,
        dataJson: JSON.stringify({ ...row.data, labels: [], notes: 'older client edit' }) }] }, now);
    expect(result.state.localItemOrigins).toEqual([{ itemId: adopted.state.items[0].id, records: [archive] }]);
    expect(archives(JSON.parse(result.acknowledgements[0].dataJson))).toEqual([archive]);
  });
  it('retains archives for empty tombstones without creating a fake visible file or losing restore data', async () => {
    const s = await source();
    const result = await applyNearbyLocalBatch(s.state, { providerId: s.state.providers[0].id, sourceHash: s.snapshot.sourceHash, assets: [],
      records: [{ ...s.record, localId: s.row.local_id, scope: s.row.scope, expectedGuard: s.row.guard, dataJson: '{}', deleted: true }] }, now);
    expect(result.state.items).toHaveLength(1); expect(result.state.items[0].deletedAt).toBeDefined(); expect(result.state.localItemAttachments).toEqual([]);
    expect(result.state.localItemOrigins).toEqual(s.state.localItemOrigins);
    expect(archives((await captureNearbyLocalSnapshot(result.state)).records[0].data)).toEqual([archive]);
  });
  it('preserves binary and unknown source formats as exact inert strings, independent of ordinary labels', async () => {
    const s = await source(), binary = { ...archive, remoteId: 'binary', encoding: 'base64', format: 'future-binary', payload: 'AP/+AAE=' };
    const data = withNearbyOrigins({ ...s.row.data, labels: [...s.row.data.labels as any[], { name: 'unrelated', payload: '{"wide":9007199254740993}', version: 1 }] }, [binary]);
    expect(archives(data)).toEqual(mergeNearbyOrigins([archive, binary]));
    expect((data.labels as any[]).find(row => row.name === 'unrelated').payload).toBe('{"wide":9007199254740993}');
  });
  it.each(['bitwarden', 'keepass', 'mdbx2'] as const)('retains %s source envelopes through the real local-copy transaction, nearby adoption and another local copy', async kind => {
    const state = fixture(), external = { id: 'external', kind, name: 'Synthetic source', enabled: true, isDefaultSaveTarget: false, config: {} };
    state.providers.push(external);
    const original = { ...state.items[0], providerRefs: [{ providerId: external.id, remoteId: 'original-remote' }] }; state.items = [original];
    state.sourceRecords = [await createSourceRecord({ providerId: external.id, remoteId: 'original-remote', format: `${kind}-source`, encoding: 'json', payload: archive.payload })];
    const request = { operationId: crypto.randomUUID(), createdAt: now, itemIds: [original.id], targetProviderId: state.providers[0].id, action: 'copy' as const, preserveCategories: false };
    const copy = await prepareLocalTransferBatch(state, request, [{ expected: original, account: external, attachments: [] }]);
    await applyLocalTransferBatch(state, copy);
    const snapshot = await captureNearbyLocalSnapshot(state); expect(snapshot.records).toHaveLength(1);
    expect(archives(snapshot.records[0].data)).toEqual(state.sourceRecords);
    const receiver = createEmptyVaultState(), row = snapshot.records[0];
    const result = await applyNearbyLocalBatch(receiver, { providerId: receiver.providers[0].id, sourceHash: (await captureNearbyLocalSnapshot(receiver)).sourceHash, assets: [],
      records: [{ id: row.global_id, clockJson: '{"peer":1}', dataJson: JSON.stringify(row.data), deleted: false }] }, now);
    const again = await prepareLocalTransferBatch(result.state, { ...request, operationId: crypto.randomUUID(), targetProviderId: receiver.providers[0].id, itemIds: [result.state.items[0].id] });
    expect(again.origins[0].records).toEqual(state.sourceRecords); expect(again.origins[0].records[0].payload).toBe(archive.payload);
  });
  it.each(['duplicate', 'version', 'json', 'record', 'descriptor', 'utf8-limit'] as const)('rejects malformed %s archives without partially writing another item', async fault => {
    const s = await source(), f = await encrypted(), data = JSON.parse(s.record.dataJson), entry = data.labels[0];
    if (fault === 'duplicate') data.labels.push(entry);
    if (fault === 'version') entry.version = 2;
    if (fault === 'json') entry.payload = '{invalid synthetic';
    if (fault === 'record' || fault === 'descriptor' || fault === 'utf8-limit') {
      const value = JSON.parse(entry.payload);
      if (fault === 'record') value.records[0].remoteId = 7;
      if (fault === 'descriptor') value.records[0].futureProperty = 7;
      if (fault === 'utf8-limit') value.records[0].payload = '界'.repeat(360000);
      entry.payload = JSON.stringify(value);
    }
    const before = await f.storage.read();
    await expect(f.service.adoptNearbyLocalRecords({ providerId: f.providerId, sourceHash: await f.service.nearbyLocalSnapshotHash(), assets: [],
      records: [s.record, { ...s.record, id: 'other-record', dataJson: JSON.stringify(data) }] }, f.sessionId)).rejects.toThrow();
    expect(await f.storage.read()).toEqual(before); expect((await f.service.readState()).items).toEqual([]);
  });
});
