import { parseLosslessJson } from '../../../core/lossless-json';
import { MDBX2_NATIVE_HOST_NAME } from '../native-contract';
import type { Mdbx2NativePort, Mdbx2NativeRuntime } from '../native-client';
import { boundedBridgeJson, bridgeObject, browserRequest, MDBX_BROWSER_DOCUMENT, MDBX_BROWSER_DOCUMENT_AUTH, MDBX_BROWSER_DOCUMENT_READY, MDBX_BROWSER_HEARTBEAT_MS, MDBX_BROWSER_PORT, MDBX_BROWSER_RESPONSE_BYTES, MDBX_BROWSER_START_MS } from './bridge-protocol';

let creating: Promise<void> | undefined;
let authorizationInstalled = false;
export function isBrowserMdbxControlMessage(input: unknown): boolean { const type = bridgeObject(input)?.type; return type === MDBX_BROWSER_DOCUMENT_AUTH || type === MDBX_BROWSER_DOCUMENT_READY; }
function installDocumentAuthorization(): void {
  if (authorizationInstalled) return;
  authorizationInstalled = true;
  chrome.runtime.onMessage.addListener((input, sender, respond) => {
    if (bridgeObject(input)?.type !== MDBX_BROWSER_DOCUMENT_AUTH) return false;
    const message = bridgeObject(input)!;
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL(MDBX_BROWSER_DOCUMENT)
      || sender.tab !== undefined || (sender.frameId !== undefined && sender.frameId !== 0) || typeof message.nonce !== 'string'
      || !/^[a-f0-9-]{36}$/.test(message.nonce) || Object.keys(message).length !== 2) { respond({ authorized: false }); return false; }
    // Edge does not attach documentId to offscreen senders. When supplied,
    // bind it too; otherwise require the exact URL, no tab and a live official
    // offscreen context. A normal tab with the same HTML is always rejected.
    void chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], ...(sender.documentId ? { documentIds: [sender.documentId] } : {}), documentUrls: [sender.url] })
      .then(contexts => respond({ authorized: contexts.length === 1, nonce: message.nonce }), () => respond({ authorized: false }));
    return true;
  });
}
async function ensureDocument(): Promise<void> {
  if (creating) return creating;
  creating = (async () => {
    const url = chrome.runtime.getURL(MDBX_BROWSER_DOCUMENT);
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!contexts.some(context => context.documentUrl === url)) {
      if (contexts.length) throw Error('browser-offscreen-in-use');
      await chrome.offscreen.createDocument({ url: MDBX_BROWSER_DOCUMENT, reasons: [chrome.offscreen.Reason.WORKERS], justification: 'Run the encrypted MDBX engine in a dedicated worker.' });
    }
    // Only replay this secret-free readiness probe. Never enqueue credentials
    // until the authenticated offscreen page has installed its port listener.
    const nonce = crypto.randomUUID(), deadline = Date.now() + MDBX_BROWSER_START_MS;
    do {
      const reply = await chrome.runtime.sendMessage({ type: MDBX_BROWSER_DOCUMENT_READY, nonce }).catch(() => undefined);
      if (reply?.ready === true && reply.nonce === nonce) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw Error('browser-offscreen-not-ready');
  })();
  try { await creating; } finally { creating = undefined; }
}
function listeners<T extends (...args: never[]) => void>() {
  const all = new Set<T>();
  return { addListener: (listener: T) => { all.add(listener); }, removeListener: (listener: T) => { all.delete(listener); }, emit: (...args: Parameters<T>) => { for (const listener of [...all]) listener(...args); } };
}

/** One logical client owns one worker lease. It must be shared by the vault
 * coordinators; a status probe must not close or replace the live client. */
export function createBrowserMdbx2Runtime(): Mdbx2NativeRuntime {
  installDocumentAuthorization();
  let error: string | undefined;
  return {
    disconnectErrorMessage: () => error,
    connectNative(hostName): Mdbx2NativePort {
      if (hostName !== MDBX2_NATIVE_HOST_NAME) throw Error('browser-native-capability-unavailable');
      error = undefined;
      const onMessage = listeners<(message: never) => void>(), onDisconnect = listeners<() => void>();
      let port: chrome.runtime.Port | undefined, stopped = false, ready = false;
      let queue: string[] = [];
      let pulse: ReturnType<typeof setInterval> | undefined;
      const startup = setTimeout(() => stop('browser-engine-start-timeout'), MDBX_BROWSER_START_MS);
      const stop = (code?: string) => {
        if (stopped) return;
        stopped = true; clearTimeout(startup); clearInterval(pulse); queue = [];
        if (port) { port.onMessage.removeListener(receive); port.onDisconnect.removeListener(disconnected); try { port.disconnect(); } catch { /* Already disconnected. */ } }
        error = code; onDisconnect.emit();
      };
      const disconnected = () => { void chrome.runtime.lastError; stop('browser-engine-disconnected'); };
      const send = (json: string) => { try { port!.postMessage({ kind: 'request', json }); } catch { stop('browser-engine-disconnected'); } };
      const receive = (input: unknown) => {
        const message = bridgeObject(input);
        if (message?.kind === 'ready' && !ready) {
          ready = true; clearTimeout(startup);
          pulse = setInterval(() => { try { port!.postMessage({ kind: 'pulse' }); } catch { stop('browser-engine-disconnected'); } }, MDBX_BROWSER_HEARTBEAT_MS);
          for (const json of queue) { if (stopped) break; send(json); } queue = []; return;
        }
        if (message?.kind === 'response' && ready && boundedBridgeJson(message.json, MDBX_BROWSER_RESPONSE_BYTES)) {
          try { onMessage.emit(parseLosslessJson(message.json) as never); } catch { stop('browser-engine-response-invalid'); }
          return;
        }
        stop('browser-engine-failed');
      };
      void ensureDocument().then(() => {
        if (stopped) return;
        port = chrome.runtime.connect({ name: MDBX_BROWSER_PORT });
        port.onMessage.addListener(receive); port.onDisconnect.addListener(disconnected);
      }).catch(() => stop('browser-engine-start-failed'));
      return {
        onMessage, onDisconnect,
        disconnect: () => stop(),
        postMessage(message) {
          if (stopped) throw Error('browser-engine-closed');
          const json = JSON.stringify(message); browserRequest(json);
          if (ready) { send(json); return; }
          if (queue.length >= 32) throw Error('browser-request-queue-limit');
          queue.push(json);
        }
      };
    }
  };
}
