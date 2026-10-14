import { afterEach, expect, it, vi } from 'vitest';
import { MDBX_BROWSER_PORT } from './bridge-protocol';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it('ignores unrelated runtime ports while rejecting an unauthorized MDBX port', async () => {
  let connect!: (port: chrome.runtime.Port) => void;
  vi.stubGlobal('chrome', { runtime: { id: 'a'.repeat(32), getURL: (p: string) => `chrome-extension://${'a'.repeat(32)}/${p}`,
    sendMessage: async (message: { nonce: string }) => ({ authorized: true, nonce: message.nonce }),
    onMessage: { addListener: vi.fn() }, onConnect: { addListener: (listener: typeof connect) => { connect = listener; } } } });
  await import('./offscreen'); await vi.waitFor(() => expect(connect).toBeTypeOf('function'));
  for (const name of ['monica-nearby-manager-v1', 'monica-vault-live-v1']) {
    const port = { name, disconnect: vi.fn() }; connect(port as unknown as chrome.runtime.Port); expect(port.disconnect).not.toHaveBeenCalled();
  }
  const bad = { name: MDBX_BROWSER_PORT, sender: { url: 'https://example.test/' }, disconnect: vi.fn() };
  connect(bad as unknown as chrome.runtime.Port); expect(bad.disconnect).toHaveBeenCalledOnce();
});
