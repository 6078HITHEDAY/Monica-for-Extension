import { describe, expect, it, vi } from 'vitest';
import { SecureVaultService } from '../security/secure-vault-service';
import { MemoryVaultStorage } from '../security/vault-storage';
import { MemoryVaultSessionStore } from '../security/vault-session';
import { MemoryVaultDeviceKeyStore } from '../security/vault-device-key';
import { createLoginItem, type PasskeyItem, type VaultItem } from '../core/model';
import { bytesToBase64 } from '../security/encoding';
import { NearbyLocalCoordinator } from './local-coordinator';
import type { NearbyNativeTransport, NearbyOperation } from './native-transport';
import { collectNearbyPending, groupNearbyPending } from './pending';
import { nearbyLocalItemToWire } from './application-codec';
import type { NearbyIncomingRecord } from './local-adoption';

const handle = '11111111-1111-4111-8111-111111111111';
const peer = { deviceId: 'phone', name: 'Synthetic phone', pairId: 'pair-one', trustedKey: Buffer.alloc(32, 9).toString('base64url'),
  lastSyncedAt: 0, sentRevision: '', receivedRevision: '', receivedRequest: '0' };
async function fixture(items: VaultItem[] = [createLoginItem({ title: 'Original', password: 'synthetic password' })]) {
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore(), service = new SecureVaultService(storage, sessions, Date.now, new MemoryVaultDeviceKeyStore());
  await service.setup('', items); const sessionId = (await service.passkeySessionId())!;
  const preferences = await service.nearbySessionPreferences(sessionId);
  await service.updateNearbyPreferences({ kind: 'remember', peer, enrollment: true }, preferences.epoch, sessionId);
  const operations: string[] = [];
  const transport = { close: vi.fn(), call: vi.fn(async (operation: NearbyOperation) => {
    operations.push(operation);
    switch (operation) {
      case 'snapshot_pairing': return { handle, revision: 'pairing-only-v1', asset_ids: [], pending: false };
      case 'snapshot_receive_only': return { handle, revision: 'receive-only-v1', asset_ids: [], pending: false };
      case 'replica_open': return { handle };
      case 'replica_pending': return { items: [], total: 0, next_cursor: null };
      case 'replica_export': return { handle, revision: 'revision', asset_ids: [], pending: false };
      case 'replica_revision': return { revision: 'revision', pending: false };
      case 'start': return { handle, code: '123456', invitations: [`monica-lan:2:127.0.0.1:12345:${peer.trustedKey}`] };
      case 'connect': return { handle };
      default: return {};
    }
  }) };
  const factory = vi.fn(() => transport as unknown as NearbyNativeTransport), coordinator = new NearbyLocalCoordinator(service, factory, '127.0.0.1');
  return { storage, service, sessionId, transport, operations, factory, coordinator };
}

describe('nearby coordinator authorization and cancellation', () => {
  it('pairs without reading/exporting local source items', async () => {
    const f = await fixture(), capture = vi.spyOn(f.service, 'captureNearbyLocalRecords');
    const view = await f.coordinator.pair(); expect(view.phase).toBe('pairing');
    expect(capture).not.toHaveBeenCalled(); expect(f.operations).toEqual(['snapshot_pairing', 'start']);
    f.coordinator.close(); expect(f.transport.close).toHaveBeenCalled();
  });

  it('does not revive a closed coordinator while vault initialization is awaiting', async () => {
    const f = await fixture(), saved = await f.service.nearbySessionPreferences(f.sessionId);
    let resume!: (value: typeof saved) => void;
    const gate = new Promise<typeof saved>(resolve => { resume = resolve; });
    vi.spyOn(f.service, 'nearbySessionPreferences').mockReturnValueOnce(gate);
    const operation = f.coordinator.pair(); await vi.waitFor(() => expect(f.service.nearbySessionPreferences).toHaveBeenCalled());
    f.coordinator.close(); resume(saved);
    await expect(operation).rejects.toThrow('session-closed'); expect(f.factory).not.toHaveBeenCalled();
  });

  it.each(['edit', 'lock', 'forget'] as const)('does not start a prepared snapshot after %s', async action => {
    const f = await fixture(); await f.coordinator.prepare(peer.deviceId);
    if (action === 'edit') await f.service.upsertItem({ ...(await f.service.readState()).items[0], notes: 'edited later' });
    if (action === 'lock') await f.service.lock();
    if (action === 'forget') {
      const p = await f.service.nearbySessionPreferences(f.sessionId);
      await f.service.updateNearbyPreferences({ kind: 'forget', deviceId: peer.deviceId }, p.epoch, f.sessionId);
    }
    await expect(f.coordinator.start()).rejects.toThrow(); expect(f.operations).not.toContain('start'); expect(f.transport.close).toHaveBeenCalled();
  });

  it('requires current per-peer consent for restricted keys before network disclosure', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const key: PasskeyItem = { ...createLoginItem({ title: 'Restricted key' }), kind: 'passkey', rpId: 'example.test', rpName: 'Example',
      userHandle: 'dXNlcg', userName: 'synthetic', userDisplayName: 'Synthetic', credentialId: 'AQID', signCount: 0, algorithm: -7, discoverable: true,
      backupEligible: false, sourceMode: 'browser-local', publicKey: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))),
      privateKeyPkcs8: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))) };
    const f = await fixture([key]), view = await f.coordinator.prepare(peer.deviceId);
    expect(view.phase).toBe('review'); expect(view.review?.peers).toEqual([peer.deviceId]);
    expect(JSON.stringify(view)).not.toContain(key.privateKeyPkcs8);
    await f.coordinator.confirm(view.review!.id);
    const started = await f.coordinator.start(); expect(started.phase).toBe('transferring');
    expect(JSON.stringify(started)).not.toContain(peer.trustedKey); expect(started.endpoint).toEqual({ addresses: ['127.0.0.1'], port: 12345 });
    f.coordinator.close();
    const blocked = await fixture([key]); await blocked.coordinator.prepare(peer.deviceId);
    await expect(blocked.coordinator.start()).rejects.toThrow('not-ready'); expect(blocked.operations).not.toContain('start');
  });

  it('rejects an external endpoint before constructing a trusted network connection', async () => {
    const f = await fixture(); await f.coordinator.prepare(peer.deviceId);
    await expect(f.coordinator.start({ addresses: ['8.8.8.8'], port: 42 })).rejects.toThrow('local-network-only');
    expect(f.operations).not.toContain('connect');
  });

  it('reopens native ownership after completion and a different unlocked vault session', async () => {
    const f = await fixture(); await f.coordinator.prepare(peer.deviceId); await f.coordinator.start();
    const original = f.transport.call.getMockImplementation()!;
    let phase = 'received';
    f.transport.call.mockImplementation(async operation => operation === 'progress' ? ({ phase, peer: {
      device_id: peer.deviceId, name: peer.name, revision: 'remote-revision', content_type: 'vault', vault_content_version: 2,
      receive_content: false, pairing: {}, sync_request: 0, interval_seconds: 60, settings_version: 0, settings_writer: ''
    } } as any) : original(operation));
    await f.coordinator.poll(); phase = 'completed'; await f.coordinator.poll();
    expect(f.coordinator.status().phase).toBe('completed');
    await f.service.lock(); await f.service.unlock('');
    expect(await f.service.passkeySessionId()).not.toBe(f.sessionId);
    await f.coordinator.pair();
    expect(f.transport.close).toHaveBeenCalledOnce(); expect(f.factory).toHaveBeenCalledTimes(2);
  });

  it('does not acknowledge pairing sessions that unexpectedly contain vault content', async () => {
    const f = await fixture(); await f.coordinator.pair();
    f.transport.call.mockImplementationOnce(async () => ({ phase: 'received', peer: { device_id: 'new-phone', content_type: 'vault', vault_content_version: 2,
      revision: 'contains-content', receive_content: true } }) as any);
    const before = await f.storage.read(); await expect(f.coordinator.poll()).rejects.toThrow('unexpected-pairing-mode');
    expect(await f.storage.read()).toEqual(before); expect(f.operations).not.toContain('acknowledge');
  });
});

describe('nearby pagination and complete dependency grouping', () => {
  async function records(count: number): Promise<NearbyIncomingRecord[]> {
    const data = await nearbyLocalItemToWire(createLoginItem({ title: 'Synthetic' }), {});
    return Array.from({ length: count }, (_, index) => ({ id: `record-${String(index).padStart(4, '0')}`, deleted: false, clockJson: '{"peer":1}', dataJson: JSON.stringify(data) }));
  }
  const nativeRow = (row: NearbyIncomingRecord) => ({ record: { id: row.id, deleted: row.deleted, clock: JSON.parse(row.clockJson), data: JSON.parse(row.dataJson) }, local_id: null, scope: null, expected_guard: null });
  it('collects all pages before grouping dependencies that cross page boundaries', async () => {
    const rows = await records(301), data = JSON.parse(rows[0].dataJson); data.extensions.bound_note_entry_id = rows[300].id; rows[0].dataJson = JSON.stringify(data);
    const call = vi.fn(async (_operation: string, params: any) => params.after === undefined
      ? { total: 301, items: rows.slice(0, 256).map(nativeRow), next_cursor: rows[255].id }
      : { total: 301, items: rows.slice(256).map(nativeRow), next_cursor: null });
    const collected = await collectNearbyPending({ call } as any, handle); expect(collected).toEqual(rows);
    const groups = groupNearbyPending(collected); expect(groups.flat()).toHaveLength(301);
    expect(groups.every(group => group.length <= 200)).toBe(true);
    expect(groups.find(group => group.some(row => row.id === rows[0].id))!.some(row => row.id === rows[300].id)).toBe(true);
    expect(call.mock.calls[1][1].after).toBe(rows[255].id);
  });
  it('rejects oversized connected projects before any partial adoption', async () => {
    const rows = await records(201);
    for (const row of rows) { const data = JSON.parse(row.dataJson); data.extensions.password_group_id = 'same-project'; row.dataJson = JSON.stringify(data); }
    expect(() => groupNearbyPending(rows)).toThrow('project-batch-limit');
  });
  it('groups authenticated canonical aliases with dependencies before splitting batches', async () => {
    const rows = await records(201), data = JSON.parse(rows[0].dataJson);
    data.extensions.bound_note_entry_id = 'original-note-alias'; rows[0].dataJson = JSON.stringify(data);
    const groups = groupNearbyPending(rows, new Map([['original-note-alias', rows[200].id]]));
    expect(groups[0].some(row => row.id === rows[200].id)).toBe(true);
    expect(groups.flat()).toHaveLength(201);
  });
  it.each(['cursor', 'total', 'duplicate'] as const)('rejects inconsistent native %s pages', async fault => {
    const rows = await records(2);
    const call = vi.fn().mockResolvedValueOnce({ total: 2, items: [nativeRow(rows[0])], next_cursor: fault === 'cursor' ? 'missing' : rows[0].id })
      .mockResolvedValueOnce({ total: fault === 'total' ? 3 : 2, items: [nativeRow(fault === 'duplicate' ? rows[0] : rows[1])], next_cursor: null });
    await expect(collectNearbyPending({ call } as any, handle)).rejects.toThrow();
  });
});
