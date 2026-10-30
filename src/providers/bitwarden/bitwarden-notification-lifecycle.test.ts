import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BitwardenNotifications, bitwardenNotificationSession } from './bitwarden-notifications';
import type { BitwardenClient, BitwardenSessionConfig } from './bitwarden-client';
import { ProviderTransportError } from '../provider-transport';

const hub = vi.hoisted(() => ({ factory: undefined as undefined | (() => Promise<string>), close: undefined as undefined | (() => void),
  start: vi.fn<() => Promise<void>>(), stop: vi.fn<() => Promise<void>>() }));
vi.mock('@microsoft/signalr', async original => ({ ...await original<typeof import('@microsoft/signalr')>(),
  HubConnectionBuilder: class {
    withUrl(_url: string, options: { accessTokenFactory: () => Promise<string> }) { hub.factory = options.accessTokenFactory; return this; }
    withHubProtocol() { return this; } configureLogging() { return this; }
    withKeepAliveInterval() { return this; } withServerTimeout() { return this; }
    build() { return { on() {}, onclose(callback: () => void) { hub.close = callback; }, start: hub.start, stop: hub.stop }; }
  }
}));

const inputs = () => ({ vaultUrl: 'https://vault.bitwarden.com', userId: 'synthetic-user', deviceId: 'synthetic-device',
  accessToken: vi.fn(async (_signal: AbortSignal) => 'synthetic-token'), receive: vi.fn(), connected: vi.fn(), disconnected: vi.fn() });

describe('Bitwarden notification authentication lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0); hub.start.mockReset(); hub.stop.mockReset().mockResolvedValue(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('does not hand a token to the transport after authentication is cancelled by lock', async () => {
    const input = inputs(); let finish!: (token: string) => void; let handedToTransport = false;
    input.accessToken.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    hub.start.mockImplementation(async () => { await hub.factory!(); handedToTransport = true; });
    const channel = new BitwardenNotifications(input); channel.start();
    expect(input.accessToken).toHaveBeenCalledTimes(1);
    const signal = input.accessToken.mock.calls[0][0];
    channel.stop(); expect(signal.aborted).toBe(true);
    finish('synthetic-token'); await vi.advanceTimersByTimeAsync(0);
    expect(handedToTransport).toBe(false); expect(channel.connected).toBe(false);
    expect(input.connected).not.toHaveBeenCalled(); expect(input.disconnected).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('signals polling after initial failure and retries with a newly acquired token', async () => {
    const input = inputs(); let attempts = 0;
    hub.start.mockImplementation(async () => { await hub.factory!(); if (++attempts === 1) throw new Error('Synthetic auth failure'); });
    const channel = new BitwardenNotifications(input); channel.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(input.disconnected).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(input.accessToken).toHaveBeenCalledTimes(2); expect(input.connected).toHaveBeenCalledTimes(1);
    expect(channel.connected).toBe(true);
    hub.close!(); hub.close!();
    expect(input.disconnected).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(1);
    channel.stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it('never starts authentication on a stopped channel', () => {
    const input = inputs(); const channel = new BitwardenNotifications(input);
    channel.stop(); channel.start(); expect(hub.start).not.toHaveBeenCalled(); expect(input.accessToken).not.toHaveBeenCalled();
  });
});

describe('notification preflight compatibility', () => {
  const session = { accessToken: 'synthetic-old' } as BitwardenSessionConfig;
  const refreshed = { accessToken: 'synthetic-fresh' } as BitwardenSessionConfig;
  const signal = new AbortController().signal;
  const failure = (status: number) => new ProviderTransportError(status === 401 ? 'authentication' : 'client', 'Synthetic failure', { status, retryable: false, operation: 'synthetic', attempts: 1 });
  it('uses the session returned by the authenticated revision check', async () => {
    const accountRevision = vi.fn().mockResolvedValue({ session: refreshed, revision: 1 }); const sync = vi.fn();
    expect(await bitwardenNotificationSession({ accountRevision, sync } as unknown as BitwardenClient, session, signal)).toBe(refreshed);
    expect(accountRevision).toHaveBeenCalledWith(session, signal); expect(sync).not.toHaveBeenCalled();
  });
  it.each([404, 405])('supports older self-hosted servers without revision-date (%s)', async status => {
    const accountRevision = vi.fn().mockRejectedValue(failure(status)); const sync = vi.fn().mockResolvedValue({ session: refreshed });
    expect(await bitwardenNotificationSession({ accountRevision, sync } as unknown as BitwardenClient, session, signal)).toBe(refreshed);
    expect(sync).toHaveBeenCalledWith(session, signal);
  });
  it('does not bypass rejected authentication or fetch vault contents on a 401', async () => {
    const error = failure(401); const accountRevision = vi.fn().mockRejectedValue(error); const sync = vi.fn();
    await expect(bitwardenNotificationSession({ accountRevision, sync } as unknown as BitwardenClient, session, signal)).rejects.toBe(error);
    expect(sync).not.toHaveBeenCalled();
  });
});
