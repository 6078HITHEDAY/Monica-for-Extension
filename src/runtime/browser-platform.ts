/** Capabilities are selected from our own extension URL, never a web page UA. */
export function isFirefoxExtension(runtime = chrome.runtime): boolean {
  return runtime.getURL('').startsWith('moz-extension://');
}

export const FIREFOX_ADDON_ID = 'monica@monica-pass.github.io';
// Firefox identity.getRedirectURL derives this stable host from SHA-1(add-on ID).
export const FIREFOX_IDENTITY_HOST = 'f8bbc9f1d8ddc2cfc3d3e3082d3d44219d7d3b9b.extensions.allizom.org';

export function nativeInstallerBrowser(runtime = chrome.runtime, userAgent = navigator.userAgent): 'Firefox' | 'Edge' | 'Chrome' {
  return isFirefoxExtension(runtime) ? 'Firefox' : /Edg\//.test(userAgent) ? 'Edge' : 'Chrome';
}

export function backgroundPageURL(runtime: Pick<typeof chrome.runtime, 'getURL'>): string {
  return runtime.getURL('').startsWith('moz-extension://')
    ? runtime.getURL('_generated_background_page.html') : runtime.getURL('background.js');
}

interface FirefoxSidebar { open(): Promise<void> }
export function firefoxSidebar(): FirefoxSidebar | undefined {
  return (globalThis as typeof globalThis & { browser?: { sidebarAction?: FirefoxSidebar } }).browser?.sidebarAction;
}
