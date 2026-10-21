import { describe, expect, it } from 'vitest';
import { backgroundPageURL, isFirefoxExtension, nativeInstallerBrowser } from './browser-platform';
describe('platform capabilities come from the owned extension URL',()=>{
  const firefox={getURL:(p:string)=>`moz-extension://uuid/${p}`};
  const chromium={getURL:(p:string)=>`chrome-extension://id/${p}`};
  it('selects Firefox despite a spoofed page UA and preserves Chromium choices',()=>{
    expect(isFirefoxExtension(firefox as typeof chrome.runtime)).toBe(true);
    expect(nativeInstallerBrowser(firefox as typeof chrome.runtime,'Edg/1')).toBe('Firefox');
    expect(nativeInstallerBrowser(chromium as typeof chrome.runtime,'Edg/1')).toBe('Edge');
    expect(nativeInstallerBrowser(chromium as typeof chrome.runtime,'Firefox/155')).toBe('Chrome');
    expect(backgroundPageURL(firefox)).toBe('moz-extension://uuid/_generated_background_page.html');
    expect(backgroundPageURL(chromium)).toBe('chrome-extension://id/background.js');
  });
});
