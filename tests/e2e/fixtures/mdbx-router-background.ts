import { Mdbx2BackendRouter } from '../../../src/providers/mdbx2/backend-router';
import { Mdbx2NativeClient, createChromeMdbx2NativeRuntime } from '../../../src/providers/mdbx2/native-client';
import { IndexedDbMdbx2OriginStore } from '../../../src/providers/mdbx2/backend-origin-store';
import { createBrowserMdbx2Runtime, isBrowserMdbxControlMessage } from '../../../src/providers/mdbx2/browser/runtime';
import { originStoreSuite } from './mdbx-origin-suite';

const browser = createBrowserMdbx2Runtime();
const origins = new IndexedDbMdbx2OriginStore();
let client = new Mdbx2BackendRouter(createChromeMdbx2NativeRuntime(), browser, origins);
const seed = new Mdbx2NativeClient(createChromeMdbx2NativeRuntime());
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (isBrowserMdbxControlMessage(message) || message?.type !== 'TEST_ROUTER') return false;
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('index.html')) { respond({ ok: false, code: 'test-driver-denied' }); return false; }
  const run = async () => {
    switch (message.op) {
      case 'rpc': return client.request(message.method, message.params, 60000, message.owner);
      case 'seed': return seed.request(message.method, message.params, 60000);
      case 'close-seed': seed.close(); return true;
      case 'origin': return client.backendForVault(message.params.handle);
      case 'lookup': return [...await origins.read(message.params.handles)];
      case 'origin-suite': return originStoreSuite();
      case 'hello': return client.hello(60000, message.params.handle);
      case 'status': return client.status(60000, message.params.handle);
      case 'revision': return client.readWriteRevision(message.params.handle);
      case 'create': return client.createVault(message.params.password);
      case 'backup': return client.prepareCompleteBackup(message.params.handle);
      case 'inbound': return client.beginInboundTransferForVault(message.params.handle, message.params.size, undefined, 'sync-segment');
      case 'reset': client.close(); seed.close(); client = new Mdbx2BackendRouter(createChromeMdbx2NativeRuntime(), browser, origins); return true;
      case 'close': client.close(); seed.close(); return true;
      default: throw Error('test-op-invalid');
    }
  };
  void run().then(value => respond({ ok: true, value }), error => respond({ ok: false, code: error.code || error.message })); return true;
});
