import { describe, expect, it } from 'vitest';
import { boundedBridgeJson, browserRequest, trustedMdbxBackground } from './bridge-protocol';

const runtime = { id: 'monica', getURL: (path: string) => `chrome-extension://monica/${path}` };
const sender = { id: 'monica', url: runtime.getURL('background.js') };
const request = { protocol: 2, requestId: 'request-1', method: 'host.hello', params: {} };
describe('browser MDBX private bridge', () => {
  it('accepts the exact background script with no document/tab identity', () => {
    expect(trustedMdbxBackground(sender, runtime)).toBe(true);
  });
  it.each([
    undefined, {}, { ...sender, id: 'another' }, { ...sender, url: runtime.getURL('index.html') },
    { ...sender, url: `${sender.url}?fake=1` }, { ...sender, url: 'https://monica/background.js' },
    { ...sender, tab: { id: 1 } }, { ...sender, documentId: 'visible-document' }, { ...sender, frameId: 2 }
  ])('rejects non-background sender %#', input => {
    expect(trustedMdbxBackground(input as chrome.runtime.MessageSender | undefined, runtime)).toBe(false);
  });
  it('bounds encoded bytes including multibyte text', () => {
    expect(boundedBridgeJson('é', 2)).toBe(true); expect(boundedBridgeJson('é', 1)).toBe(false);
    expect(boundedBridgeJson('', 2)).toBe(false); expect(boundedBridgeJson({}, 10)).toBe(false);
  });
  it('preserves valid protocol requests', () => {
    expect(browserRequest(JSON.stringify(request))).toEqual(request);
  });
  it.each([
    null, 'malformed', { ...request, protocol: 1 }, { ...request, params: [] },
    { ...request, params: null }, { ...request, method: '../path' }, { ...request, requestId: '' },
    { ...request, additional: 'not allowed' }
  ])('rejects malformed or extra envelope fields %#', input => {
    expect(() => browserRequest(typeof input === 'string' ? input : JSON.stringify(input))).toThrow();
  });
});
