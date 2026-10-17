import { afterEach, describe, expect, it, vi } from 'vitest';
import { NearbyManagerClient } from './manager-client';

afterEach(() => vi.unstubAllGlobals());
function fakePort() {
  vi.stubGlobal('chrome', { runtime: { lastError: undefined } });
  const message: Array<(value: unknown) => void> = [], disconnect: Array<() => void> = [];
  const port = {
    sent: [] as any[],
    postMessage: vi.fn((value: unknown) => { port.sent.push(value); }),
    disconnect: vi.fn(),
    onMessage: { addListener: (listener: (value: unknown) => void) => message.push(listener), removeListener: (listener: (value: unknown) => void) => { const i=message.indexOf(listener); if(i>=0) message.splice(i,1); } },
    onDisconnect: { addListener: (listener: () => void) => disconnect.push(listener), removeListener: (listener: () => void) => { const i=disconnect.indexOf(listener); if(i>=0) disconnect.splice(i,1); } },
    deliver: (value: unknown) => message.forEach(listener => listener(value)),
    drop: () => disconnect.forEach(listener => listener())
  };
  return port;
}

describe('nearby manager client', () => {
  it('correlates strictly increasing request IDs with responses and reports readiness', async () => {
    const port = fakePort(), ready = vi.fn(), closed = vi.fn();
    const client = new NearbyManagerClient(closed, { connect: () => port as any });
    void client.ready.then(ready);
    port.deliver({ type: 'ready' }); await client.ready; expect(ready).toHaveBeenCalledOnce();
    const first = client.request({ type: 'preferences' }), second = client.request({ type: 'status' });
    await Promise.resolve();
    expect(port.sent.map(value => value.id)).toEqual([1, 2]);
    port.deliver({ id: 2, ok: false, error: 'busy' }); port.deliver({ id: 1, ok: true, data: { name: 'Browser' } });
    await expect(first).resolves.toEqual({ name: 'Browser' });
    await expect(second).rejects.toMatchObject({ code: 'busy' }); client.close();
  });

  it('rejects pending work with the background close reason', async () => {
    const port = fakePort(), closed = vi.fn();
    const client = new NearbyManagerClient(closed, { connect: () => port as any });
    port.deliver({ type: 'ready' }); await client.ready;
    const pending = client.request({ type: 'progress' });
    port.deliver({ type: 'closed', reason: 'vault-locked' }); port.drop();
    await expect(pending).rejects.toMatchObject({ code: 'vault-locked' });
    expect(closed).toHaveBeenCalledWith('vault-locked'); expect(port.disconnect).toHaveBeenCalled();
    await expect(client.request({ type: 'status' })).rejects.toMatchObject({ code: 'vault-locked' });
  });

  it('closes pending requests and reports connection failure without silent replay', async () => {
    const port = fakePort(), closed = vi.fn();
    const client = new NearbyManagerClient(closed, { connect: () => port as any });
    port.deliver({ type: 'ready' }); await client.ready;
    const pending = client.request({ type: 'status' }); await Promise.resolve(); client.close();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(closed).toHaveBeenCalledOnce(); expect(port.disconnect).toHaveBeenCalledOnce();
    const failed = vi.fn();
    const unavailable = new NearbyManagerClient(failed, { connect: () => { throw new Error('no runtime'); } });
    await expect(unavailable.ready).rejects.toMatchObject({ code: 'connection-failed' });
    expect(failed).toHaveBeenCalledWith('connection-failed');
  });
});
