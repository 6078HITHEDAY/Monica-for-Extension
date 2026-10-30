import { MdbxBrowserSession } from './session';
import { bridgeObject, browserRequest } from './bridge-protocol';
// The build copies the verified Emscripten module next to this entry point.
// @ts-expect-error Generated module; bounded interface is checked by session.ts.
import create from './engine.js';

let closing = false;
let closePromise: Promise<void> | undefined;
const opened = MdbxBrowserSession.open(create);
const finish = () => closePromise ||= (async () => {
  closing = true;
  try { await (await opened).close(); } catch { /* Restore only the last committed generation next time. */ }
  postMessage({ kind: 'closed' });
})();
void opened.then(() => { if (!closing) postMessage({ kind: 'ready' }); }, () => {
  postMessage({ kind: 'fatal', code: 'browser-engine-start-failed' }); void finish();
});
onmessage = ({ data }) => {
  const message = bridgeObject(data);
  if (message?.kind === 'close') { void finish(); return; }
  if (closing) return;
  let request;
  try { if (message?.kind !== 'request') throw Error(); request = browserRequest(message.json); }
  catch { postMessage({ kind: 'fatal', code: 'browser-request-invalid' }); void finish(); return; }
  void opened.then(session => session.request(request)).then(response => {
    if (!closing) postMessage({ kind: 'response', json: JSON.stringify(response) });
  }, () => {
    if (!closing) postMessage({ kind: 'fatal', code: 'browser-session-failed' });
    void finish();
  });
};
