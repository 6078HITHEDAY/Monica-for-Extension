import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandHandler, createCommandDispatcher, createCommandExecutor, type CommandHandlers } from './command-router';
import { ProviderOperationQueue } from './provider-operation-queue';
import type { ExtensionRequest } from '../runtime/messages';

const root = 'chrome-extension://synthetic/';
const manager = { id: 'synthetic', url: `${root}index.html`, origin: root.slice(0, -1) };
beforeEach(() => vi.stubGlobal('chrome', { runtime: { id: 'synthetic', getURL: (path: string) => root + path } }));
afterEach(() => vi.unstubAllGlobals());

function fixture(kind = 'mdbx2') {
  const events: string[] = [];
  const service = {
    getProvider: vi.fn(async () => ({ id: 'mdbx', name: 'Synthetic', kind: kind as 'mdbx2' | 'monica-webdav', enabled: true, isDefaultSaveTarget: false, config: {} })),
    assertNoBitwardenMdbxMove: vi.fn(async () => { events.push('move'); }),
    assertNoNearbyNativeSequence: vi.fn(async () => { events.push('nearby'); })
  };
  const queue = new ProviderOperationQueue();
  const run = vi.spyOn(queue, 'run');
  const execute = createCommandExecutor(service as Parameters<typeof createCommandExecutor>[0], queue);
  const handler = vi.fn(async () => { events.push('handler'); return 'saved'; });
  const request = { type: 'PROVIDER_ATTACHMENT_UPLOAD_FINISH', providerId: 'mdbx', itemId: 'item', transferId: 'upload', operationId: 'operation' } as const;
  return { events, service, queue, run, execute, handler, request };
}

describe('actual command execution authorization and native exclusivity', () => {
  it.each([
    { url: 'https://example.test/', id: 'synthetic' },
    { ...manager, id: 'other' },
    { ...manager, url: `${root}popup.html` }
  ])('rejects an untrusted or non-manager sender before a native write', async sender => {
    const f = fixture();
    await expect(f.execute(f.request, sender, f.handler)).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.handler).not.toHaveBeenCalled();
    expect(f.service.assertNoBitwardenMdbxMove).not.toHaveBeenCalled();
  });

  it('invokes the native handler once inside the queue after both recovery guards', async () => {
    const f = fixture();
    expect(await f.execute(f.request, manager, f.handler)).toBe('saved');
    expect(f.events).toEqual(['move', 'nearby', 'handler']);
    expect(f.run).toHaveBeenCalledExactlyOnceWith('mdbx', expect.any(Function));
    expect(f.handler).toHaveBeenCalledExactlyOnceWith(f.request, manager, true);
  });

  it.each(['assertNoBitwardenMdbxMove', 'assertNoNearbyNativeSequence'] as const)('does not write when %s rejects', async guard => {
    const f = fixture();
    f.service[guard].mockRejectedValueOnce(new Error('recovery pending'));
    await expect(f.execute(f.request, manager, f.handler)).rejects.toThrow('recovery pending');
    expect(f.handler).not.toHaveBeenCalled();
  });

  it('serializes an internal attachment write behind an existing provider operation', async () => {
    const f = fixture();
    let release!: () => void;
    const prior = f.queue.run('mdbx', () => new Promise<void>(resolve => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const next = f.execute(f.request, manager, f.handler);
    await Promise.resolve();
    expect(f.handler).not.toHaveBeenCalled();
    release(); await prior; await next;
    expect(f.handler).toHaveBeenCalledTimes(1);
  });

  it('leaves non-native work out of the native queue', async () => {
    const f = fixture('monica-webdav');
    await f.execute(f.request, manager, f.handler);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.handler).toHaveBeenCalledExactlyOnceWith(f.request, manager, false);
  });

  it('rejects unknown and prototype properties during handler lookup', () => {
    const handlers: CommandHandlers<Extract<ExtensionRequest, { type: 'VAULT_STATUS' }>> = { VAULT_STATUS: vi.fn() };
    for (const type of ['__proto__', 'toString', 'UNKNOWN']) {
      expect(commandHandler(handlers, { type } as ExtensionRequest)).toBeUndefined();
    }
  });

  it('preserves native ownership through the actual dispatcher after authorization and recovery checks', async () => {
    const f = fixture();
    const dispatch = createCommandDispatcher({ PROVIDER_ATTACHMENT_UPLOAD_FINISH: f.handler } as unknown as CommandHandlers<ExtensionRequest>);
    expect(await f.execute(f.request, manager, dispatch)).toBe('saved');
    expect(f.events).toEqual(['move', 'nearby', 'handler']);
    expect(f.handler).toHaveBeenCalledExactlyOnceWith(f.request, manager, true);
  });

  it('rejects unknown and prototype commands in the dispatcher without invoking an inherited function', () => {
    const inherited = vi.fn();
    const dispatch = createCommandDispatcher(Object.create({ UNKNOWN: inherited, toString: inherited }));
    for (const type of ['UNKNOWN', 'toString', '__proto__']) expect(() => dispatch({ type } as ExtensionRequest, manager, false)).toThrow();
    expect(inherited).not.toHaveBeenCalled();
  });
});
