import { boundedBridgeJson, bridgeObject, MDBX_BROWSER_CLOSE_MS, MDBX_BROWSER_DOCUMENT_AUTH, MDBX_BROWSER_DOCUMENT_READY, MDBX_BROWSER_LEASE_MS, MDBX_BROWSER_PORT, MDBX_BROWSER_REQUEST_BYTES, MDBX_BROWSER_RESPONSE_BYTES, trustedMdbxBackground } from './bridge-protocol';

let owner: chrome.runtime.Port | undefined;
let retirement: Promise<void> = Promise.resolve();
// A normal tab loading this HTML must not become another database receiver.
// The background checks the sender against the real offscreen context.
const nonce = crypto.randomUUID();
const authorized = chrome.runtime.sendMessage({ type: MDBX_BROWSER_DOCUMENT_AUTH, nonce })
  .then(reply => reply?.authorized === true && reply?.nonce === nonce, () => false);

void authorized.then(allowed => {
  if (!allowed) return;
  chrome.runtime.onMessage.addListener((input, sender, respond) => {
    const message = bridgeObject(input);
    if (message?.type !== MDBX_BROWSER_DOCUMENT_READY || !trustedMdbxBackground(sender, chrome.runtime)) return false;
    respond({ ready: true, nonce: message.nonce }); return false;
  });
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== MDBX_BROWSER_PORT || !trustedMdbxBackground(port.sender, chrome.runtime) || owner) { port.disconnect(); return; }
    accept(port);
  });
});

function accept(port: chrome.runtime.Port): void {
  owner = port;
  let worker: Worker | undefined, stopped = false, ready = false, lastPulse = Date.now();
  let finished!: () => void;
  const done = new Promise<void>(resolve => { finished = resolve; });
  const previous = retirement;
  retirement = previous.then(() => done);
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => { clearTimeout(closeTimer); worker?.terminate(); worker = undefined; finished(); };
  const stop = () => {
    if (stopped) return;
    stopped = true; clearInterval(watchdog);
    if (owner === port) owner = undefined;
    port.onMessage.removeListener(receive); port.onDisconnect.removeListener(stop);
    try { port.disconnect(); } catch { /* Already disconnected. */ }
    if (!worker) { finished(); return; }
    try { worker.postMessage({ kind: 'close' }); } catch { terminate(); return; }
    closeTimer = setTimeout(terminate, MDBX_BROWSER_CLOSE_MS);
  };
  const send = (message: unknown) => { if (!stopped) try { port.postMessage(message); } catch { stop(); } };
  const receive = (input: unknown) => {
    const message = bridgeObject(input);
    if (message?.kind === 'pulse' && Object.keys(message).length === 1) { lastPulse = Date.now(); return; }
    if (!ready || message?.kind !== 'request' || Object.keys(message).length !== 2 || !boundedBridgeJson(message.json, MDBX_BROWSER_REQUEST_BYTES)) { stop(); return; }
    lastPulse = Date.now(); worker!.postMessage(message);
  };
  const watchdog = setInterval(() => { if (Date.now() - lastPulse > MDBX_BROWSER_LEASE_MS) stop(); }, 5_000);
  port.onMessage.addListener(receive); port.onDisconnect.addListener(stop);
  void previous.then(() => {
    if (stopped) return;
    worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module', name: 'Monica encrypted MDBX engine' });
    worker.onerror = () => { send({ kind: 'fatal', code: 'browser-worker-failed' }); stop(); terminate(); };
    worker.onmessage = ({ data }) => {
      const message = bridgeObject(data);
      if (message?.kind === 'closed') { stop(); terminate(); return; }
      if (stopped) return;
      if (message?.kind === 'ready' && !ready) { ready = true; send({ kind: 'ready' }); return; }
      if (message?.kind === 'response' && ready && boundedBridgeJson(message.json, MDBX_BROWSER_RESPONSE_BYTES)) { send(message); return; }
      send({ kind: 'fatal', code: 'browser-worker-failed' }); stop();
    };
  }).catch(() => { send({ kind: 'fatal', code: 'browser-worker-start-failed' }); stop(); terminate(); });
}
