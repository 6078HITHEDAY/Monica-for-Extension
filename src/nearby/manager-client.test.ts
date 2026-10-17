import { describe, expect, it, vi } from 'vitest';
import { NearbyManagerClient } from './manager-client';

function fakePort() {
  const message: Array<(value: unknown) => void> = [], disconnect: Array<() => void> = [];
  const port = {
    sent: [] as any[],
    postMessage: vi.fn((value: unknown) => { port.sent.push(value); }),
    disconnect: vi.fn(),
    onMessage: { addListener: (listener: (value: unknown) => void) => message.push(listener) },
    onDisconnect: { addListener: (listener: () => void) => disconnect.push(listener) },
    deliver: (value: unknown) => message.forEach(listener => listener(value)),
    drop: () => disconnect.forEach(listener => listener())
  };
  return port;
}

describe('nearby manager client', () => {
  it('correlates strictly increasing request IDs with responses and reports readiness', async () => {
    const port = fakePort(), ready = vi.fn(), closed = vi.fn();
    const client = new NearbyManagerClient({ ready, closed }, () => port as any); client.open();
    port.deliver({ type: 'ready' }); expect(ready).toHaveBeenCalledOnce();
    const first = client.request({ type: 'preferences' }), second = client.request({ type: 'status' });
    expect(port.sent.map(value => value.id)).toEqual([1, 2]);
    port.deliver({ id: 2, ok: false, error: 'busy' }); port.deliver({ id: 1, ok: true, data: { name: 'Browser' } });
    await expect(first).resolves.toEqual({ name: 'Browser' });
    await expect(second).rejects.toMatchObject({ code: 'busy' });
  });

  it('rejects pending work with the background close reason', async () => {
    const port = fakePort(), closed = vi.fn();
    const client = new NearbyManagerClient({ ready: vi.fn(), closed }, () => port as any); client.open();
    const pending = client.request({ type: 'progress' });
    port.deliver({ type: 'closed', reason: 'vault-locked' }); port.drop();
    await expect(pending).rejects.toMatchObject({ code: 'vault-locked' });
    expect(closed).toHaveBeenCalledWith('vault-locked'); expect(client.connected).toBe(false);
    await expect(client.request({ type: 'status' })).rejects.toMatchObject({ code: 'vault-locked' });
  });

  it('cancels through the lease and reports a failed connection attempt', () => {
    const port = fakePort(), client = new NearbyManagerClient({ ready: vi.fn(), closed: vi.fn() }, () => port as any);
    client.open(); client.cancel(); expect(port.sent).toEqual([{ id: 1, type: 'cancel' }]);
    const closed = vi.fn();
    new NearbyManagerClient({ ready: vi.fn(), closed }, () => { throw new Error('no runtime'); }).open();
    expect(closed).toHaveBeenCalledWith('manager-closed');
  });
});
