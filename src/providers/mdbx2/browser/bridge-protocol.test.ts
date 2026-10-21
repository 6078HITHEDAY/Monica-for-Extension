import { describe, expect, it } from 'vitest';
import { boundedBridgeJson, browserRequest, trustedMdbxBackground, trustedFirefoxEngineDocument } from './bridge-protocol';

const runtime = { id: 'monica', getURL: (path: string) => `chrome-extension://monica/${path}` };
const sender = { id: 'monica', url: runtime.getURL('background.js') };
const request = { protocol: 2, requestId: 'request-1', method: 'host.hello', params: {} };
describe('browser MDBX private bridge', () => {
  const firefox = { id:'monica@monica-pass.github.io', getURL:(p:string)=>`moz-extension://12345678-1234-1234-1234-123456789abc/${p}` };
  const background = {id:firefox.id,url:firefox.getURL('_generated_background_page.html'),frameId:0,documentId:'12345678-1234-1234-1234-123456789abc'};
  const ownedURL = firefox.getURL('mdbx-offscreen.html#12345678-1234-1234-1234-123456789abc');
  const engine = {...background,url:ownedURL,frameId:4294967297};
  it('accepts the Firefox event page with native document identity, rejecting visible or child impersonators', () => {
    expect(trustedMdbxBackground(background,firefox)).toBe(true);
    for(const value of [{...background,tab:{id:1}},{...background,frameId:4294967297},{...background,url:firefox.getURL('index.html')},{...background,id:'other'},{...background,url:background.url+'#fake'}])
      expect(trustedMdbxBackground(value as chrome.runtime.MessageSender,firefox)).toBe(false);
  });
  it('requires the connected Firefox-owned private frame URL and native document ID', () => {
    expect(trustedFirefoxEngineDocument(engine,firefox,ownedURL,true)).toBe(true);
    expect(trustedFirefoxEngineDocument(engine,firefox,ownedURL,false)).toBe(false);
    expect(trustedFirefoxEngineDocument(engine,firefox,undefined,true)).toBe(false);
    for(const value of [{...engine,tab:{id:1}},{...engine,url:firefox.getURL('mdbx-offscreen.html')},{...engine,url:ownedURL+'fake'},{...engine,documentId:undefined},{...engine,documentId:'invalid'},{...engine,id:'other'}])
      expect(trustedFirefoxEngineDocument(value as chrome.runtime.MessageSender,firefox,ownedURL,true)).toBe(false);
  });
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
