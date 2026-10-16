import { afterEach, describe, expect, it, vi } from 'vitest';
import { NearbyManagerOwner } from './nearby-owner';
import { NEARBY_MANAGER_PORT, readNearbyManagerRequest } from '../nearby/manager-contract';
import { SecureVaultService } from '../security/secure-vault-service';
import { MemoryVaultStorage } from '../security/vault-storage';
import { MemoryVaultSessionStore } from '../security/vault-session';
import { MemoryVaultDeviceKeyStore } from '../security/vault-device-key';
import { NearbyLocalCoordinator } from '../nearby/local-coordinator';
import type { NearbyNativeTransport } from '../nearby/native-transport';
import { createLoginItem } from '../core/model';
import { nearbyLocalItemToWire } from '../nearby/application-codec';

const root = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';
const sender = { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', url: `${root}index.html`, origin: root.slice(0, -1),
  frameId: 0, documentId: '11111111-1111-4111-8111-111111111111', documentLifecycle: 'active', tab: { id: 1 } };
function event() {
  const listeners = new Set<(value?: any) => void>();
  return { addListener: (f: (v?: any) => void) => listeners.add(f), removeListener: (f: (v?: any) => void) => listeners.delete(f),
    emit: (value?: unknown) => [...listeners].forEach(f => f(value)), listeners };
}
function port(overrides = {}) {
  const p = { name: NEARBY_MANAGER_PORT, sender: { ...sender, ...overrides }, onMessage: event(), onDisconnect: event(),
    postMessage: vi.fn(), disconnect: vi.fn() };
  return Object.assign(p, { native: p as unknown as chrome.runtime.Port });
}
const owners: NearbyManagerOwner[] = [];
function fixture() {
  const session = { id: 'session', expiresAt: Date.now() + 60_000 };
  const coordinator = { close: vi.fn(), status: vi.fn(() => ({ phase: 'idle' as const })), pair: vi.fn(async () => ({ phase: 'pairing' as const })),
    discover: vi.fn(), discoveryProgress: vi.fn(), prepare: vi.fn(), confirm: vi.fn(), start: vi.fn(), poll: vi.fn(), recover: vi.fn(), reviewRecovery: vi.fn(), confirmRecovery: vi.fn() };
  const options = { runtimeId: sender.id, extensionRoot: root, readSession: vi.fn(async () => session),
    createCoordinator: vi.fn(() => coordinator), changed: vi.fn(),
    store: { readState: vi.fn(), nearbySessionPreferences: vi.fn(), updateNearbyPreferences: vi.fn(), readNearbyNativeJournal: vi.fn() } };
  const owner = new NearbyManagerOwner(options); owners.push(owner);
  return { owner, options, coordinator, session };
}
async function ready(f: ReturnType<typeof fixture>, p = port()) {
  f.owner.attach(p.native); await vi.waitFor(() => expect(p.postMessage).toHaveBeenCalledWith({ type: 'ready' })); return p;
}
async function response(p: ReturnType<typeof port>, id: number) {
  await vi.waitFor(() => expect(p.postMessage.mock.calls.some(([v]) => v.id === id)).toBe(true));
  return p.postMessage.mock.calls.find(([v]) => v.id === id)![0];
}
afterEach(() => { owners.splice(0).forEach(owner => owner.close()); vi.useRealTimers(); });

describe('nearby manager boundary and lifecycle', () => {
  it('routes review and one-use confirmation through the owning coordinator only', async () => {
    const f = fixture(), p = await ready(f), reviewId = '22222222-2222-4222-8222-222222222222';
    f.coordinator.reviewRecovery.mockResolvedValue({ reviewId, editedEntries: 1, interveningCommits: 2, remainingSteps: 3 });
    p.onMessage.emit({ id: 1, type: 'recovery-review', operationId: sender.documentId });
    expect((await response(p, 1)).data).toEqual({ reviewId, editedEntries: 1, interveningCommits: 2, remainingSteps: 3 });
    expect(f.options.changed).not.toHaveBeenCalled();
    f.coordinator.confirmRecovery.mockResolvedValue({ applied: 1 });
    p.onMessage.emit({ id: 2, type: 'recovery-confirm', reviewId });
    expect((await response(p, 2)).data).toEqual({ applied: 1 });
    expect(f.coordinator.confirmRecovery).toHaveBeenCalledWith(reviewId); expect(f.options.changed).toHaveBeenCalledOnce();
  });
  it('returns only recovery counters and an opaque operation, never journal contents', async () => {
    const f = fixture(), p = await ready(f);
    f.options.store.readNearbyNativeJournal.mockResolvedValue({ intent: { operationId: sender.documentId,
      write: { assets: ['synthetic secret'] }, acknowledgements: ['synthetic private clock'],
      sequence: { completedSteps: 1, completed: [{}], remaining: [{}, {}], conflict: true } } });
    p.onMessage.emit({ id: 1, type: 'recovery-status' });
    expect((await response(p, 1)).data).toEqual({ operationId: sender.documentId, completedSteps: 1, remainingSteps: 3, completeInputsRetained: true, conflict: true });
    expect(f.options.createCoordinator).not.toHaveBeenCalled();
    f.coordinator.recover.mockResolvedValue({ applied: 1 });
    p.onMessage.emit({ id: 2, type: 'recover', operationId: sender.documentId });
    expect((await response(p, 2)).data).toEqual({ applied: 1 });
    expect(f.coordinator.recover).toHaveBeenCalledWith(sender.documentId); expect(f.options.changed).toHaveBeenCalledOnce();
  });
  it.each([
    { id: 'other' }, { url: `${root}popup.html` }, { url: 'https://example.test/index.html' }, { frameId: 1 },
    { origin: 'https://example.test' }, { documentId: undefined }, { tab: undefined }, { documentLifecycle: 'prerender' }
  ])('rejects a non-owning manager document: %j', async badSender => {
    const f = fixture(), p = port(badSender); f.owner.attach(p.native);
    expect(p.disconnect).toHaveBeenCalledOnce(); expect(f.options.readSession).not.toHaveBeenCalled();
    expect(p.onMessage.listeners.size).toBe(0);
  });
  it('does not let another manager steal an active connection', async () => {
    const f = fixture(), a = await ready(f), b = port(); f.owner.attach(b.native);
    expect(b.postMessage).toHaveBeenCalledWith({ type: 'closed', reason: 'manager-busy' });
    a.onMessage.emit({ id: 1, type: 'status' }); expect((await response(a, 1)).data).toEqual({ phase: 'idle' });
    expect(f.options.createCoordinator).not.toHaveBeenCalled();
  });
  it('does not initialize after a manager closes during its session read', async () => {
    const f = fixture(); let resolve!: (s: typeof f.session) => void;
    f.options.readSession.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const p = port(); f.owner.attach(p.native); p.onDisconnect.emit(); resolve(f.session);
    await Promise.resolve(); expect(p.postMessage).not.toHaveBeenCalledWith({ type: 'ready' });
    expect(f.options.createCoordinator).not.toHaveBeenCalled();
  });
  it.each(['manager', 'lock', 'cancel', 'replacement'] as const)('synchronously cancels %s and drops its awaited result', async why => {
    const f = fixture(), p = await ready(f); let resolve!: (value: any) => void;
    f.coordinator.pair.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    p.onMessage.emit({ id: 1, type: 'pair' }); expect(f.coordinator.pair).toHaveBeenCalledOnce();
    if (why === 'manager') p.onDisconnect.emit();
    if (why === 'lock') f.owner.close('vault-locked');
    if (why === 'cancel') p.onMessage.emit({ id: 2, type: 'cancel' });
    if (why === 'replacement') f.owner.sessionChanged({ ...f.session, id: 'another-session' });
    expect(f.coordinator.close).toHaveBeenCalledOnce();
    resolve({ phase: 'pairing', pairing: { code: 'temporary code' } }); await Promise.resolve(); await Promise.resolve();
    expect(p.postMessage.mock.calls.some(([v]) => v.id === 1)).toBe(false);
    const q = await ready(f); expect(q.onMessage.listeners.size).toBe(1);
  });
  it('expires during an awaited operation and honors user activity without polling extending it', async () => {
    const f = fixture(), p = await ready(f); vi.useFakeTimers();
    f.coordinator.pair.mockReturnValueOnce(new Promise(() => {}));
    f.owner.sessionChanged({ ...f.session, expiresAt: Date.now() + 500 });
    p.onMessage.emit({ id: 1, type: 'pair' }); await vi.advanceTimersByTimeAsync(300);
    f.owner.sessionChanged({ ...f.session, expiresAt: Date.now() + 500 });
    await vi.advanceTimersByTimeAsync(300); expect(f.coordinator.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(201); expect(f.coordinator.close).toHaveBeenCalledOnce();
    expect(p.postMessage).toHaveBeenCalledWith({ type: 'closed', reason: 'session-expired' });
  });
  it('bounds concurrent requests and lets cancellation bypass the busy operation', async () => {
    const f = fixture(), p = await ready(f);
    f.coordinator.pair.mockReturnValueOnce(new Promise(() => {}));
    p.onMessage.emit({ id: 1, type: 'pair' });
    p.onMessage.emit({ id: 2, type: 'pair' });
    expect(await response(p, 2)).toEqual({ id: 2, ok: false, error: 'busy' });
    expect(f.coordinator.pair).toHaveBeenCalledOnce();
    p.onMessage.emit({ id: 3, type: 'cancel' }); expect(f.coordinator.close).toHaveBeenCalledOnce();
  });
  it('closes native ownership before a preference write, without cancelling the new setting', async () => {
    const f = fixture(), p = await ready(f);
    p.onMessage.emit({ id: 1, type: 'pair' }); await response(p, 1);
    f.options.store.updateNearbyPreferences.mockImplementation(async () => { expect(f.coordinator.close).toHaveBeenCalledOnce(); return { epoch: 'updated' }; });
    p.onMessage.emit({ id: 2, type: 'update', epoch: sender.documentId, change: { kind: 'forget', deviceId: 'phone' } });
    expect((await response(p, 2)).data).toEqual({ epoch: 'updated' }); expect(f.options.changed).toHaveBeenCalledOnce();
  });
  it('does not return raw storage/native errors', async () => {
    const f = fixture(), p = await ready(f); f.coordinator.pair.mockRejectedValueOnce(Error('private key and native path'));
    p.onMessage.emit({ id: 1, type: 'pair' }); expect(await response(p, 1)).toEqual({ id: 1, ok: false, error: 'operation-failed' });
  });
  it('rejects duplicate ids without rerunning a mutation', async () => {
    const f = fixture(), p = await ready(f); p.onMessage.emit({ id: 1, type: 'pair' }); await response(p, 1);
    p.onMessage.emit({ id: 1, type: 'pair' }); expect(f.coordinator.pair).toHaveBeenCalledOnce(); expect(p.disconnect).toHaveBeenCalledOnce();
  });
});

describe('nearby high-level request validation', () => {
  it.each([
    { type: 'replica_open', key: 'caller key' }, { type: 'status', handle: 'caller handle' },
    { type: 'recovery-status', key: 'caller key' }, { type: 'recover', operationId: sender.documentId, writeRevision: {} },
    { type: 'recover', operationId: 'arbitrary' }, { type: 'recover', operationId: sender.documentId, plan: {} },
    { type: 'recovery-review', operationId: sender.documentId, proof: {} },
    { type: 'recovery-confirm', reviewId: sender.documentId, writeRevision: {} }, { type: 'recovery-confirm', reviewId: 'arbitrary' },
    { type: 'update', epoch: sender.documentId, change: { kind: 'remember', peer: {} } },
    { type: 'update', epoch: sender.documentId, change: { kind: 'remote-interval' } },
    { type: 'update', epoch: sender.documentId, change: { kind: 'preferences', name: 'a'.repeat(65) } },
    { type: 'update', epoch: sender.documentId, change: { kind: 'preferences', enabled: 'true' } },
    { type: 'pair', invitation: 'a'.repeat(513) }, { type: 'start', endpoint: { addresses: Array(17).fill('127.0.0.1'), port: 1 } },
    { type: 'prepare', peerId: '../other' }, { type: 'confirm', reviewId: 'arbitrary' }
  ])('rejects unsupported secrets, operations and oversized fields: %j', request => {
    expect(() => readNearbyManagerRequest({ id: 1, ...request })).toThrow();
  });
});

describe('nearby cancellation at the encrypted commit boundary', () => {
  it('cancels a queued identity initialization before storage write or native startup', async () => {
    const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore();
    const service = new SecureVaultService(storage, sessions, Date.now, new MemoryVaultDeviceKeyStore());
    await service.setup('');
    const originalRead = storage.read.bind(storage); let resume!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { entered = r; });
    vi.spyOn(storage, 'read').mockImplementationOnce(async () => { entered(); await new Promise<void>(r => { resume = r; }); return originalRead(); });
    const transport = { close: vi.fn(), call: vi.fn() }, factory = vi.fn(() => transport as unknown as NearbyNativeTransport);
    const coordinator = new NearbyLocalCoordinator(service, factory);
    const pending = coordinator.pair(); const rejected = expect(pending).rejects.toThrow('session-closed');
    await gate; coordinator.close(); resume(); await rejected;
    expect((await service.readState()).nearbyPreferences).toBeUndefined(); expect(factory).not.toHaveBeenCalled();
  });
  it('checks cancellation again after encryption, before saving changed preferences', async () => {
    const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore();
    const service = new SecureVaultService(storage, sessions, Date.now, new MemoryVaultDeviceKeyStore());
    await service.setup(''); const session = (await service.passkeySessionId())!, p = await service.nearbySessionPreferences(session);
    const write = vi.spyOn(storage, 'write'); let checks = 0;
    await expect(service.updateNearbyPreferences({ kind: 'preferences', name: 'Must not save' }, p.epoch, session,
      () => { if (++checks > 2) throw Error('cancelled before commit'); })).rejects.toThrow('cancelled before commit');
    expect(write).not.toHaveBeenCalled(); expect((await service.nearbySessionPreferences(session)).name).toBe(p.name);
  });
  it('does not commit incoming records or receipts after cancellation during encryption', async () => {
    const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore();
    const service = new SecureVaultService(storage, sessions, Date.now, new MemoryVaultDeviceKeyStore());
    await service.setup(''); const session = (await service.passkeySessionId())!, state = await service.readState();
    const sourceHash = await service.nearbyLocalSnapshotHash();
    const data = await nearbyLocalItemToWire(createLoginItem({ title: 'Cancelled incoming item', password: 'synthetic secret' }), {});
    const write = vi.spyOn(storage, 'write'); let checks = 0;
    await expect(service.adoptNearbyLocalTransaction({ providerId: state.providers[0].id, sourceHash,
      records: [{ id: 'incoming-record', dataJson: JSON.stringify(data), clockJson: '{"phone":1}', deleted: false }], assets: [] }, session,
      () => { if (++checks > 2) throw Error('cancelled before commit'); })).rejects.toThrow('cancelled before commit');
    expect(write).not.toHaveBeenCalled(); expect(await service.nearbyLocalSnapshotHash()).toBe(sourceHash);
    expect((await service.readState()).items).toEqual([]);
  });
});
