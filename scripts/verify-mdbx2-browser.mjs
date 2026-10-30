import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, browserSourceInventory, sha256, verifyBrowserTempfile } from './mdbx2-browser-provenance.mjs';

execFileSync(process.execPath, ['scripts/verify-mdbx2-host.mjs'], { cwd: root, stdio: 'inherit', windowsHide: true });
await verifyBrowserTempfile();
const pkg = resolve(root, 'native/mdbx2-browser/pkg');
const record = JSON.parse(await readFile(resolve(pkg, 'BROWSER-BUILD.json'), 'utf8'));
if (record.schema !== 2 || record.rustCommit !== '2d8144b7880597b6e6d3dfd63a9a9efae3f533d3' || record.emscripten !== '4.0.18') throw Error('Unexpected browser toolchain.');
if (JSON.stringify(record.sources) !== JSON.stringify(await browserSourceInventory())) throw Error('Browser engine artifact is stale; rebuild from the current sources.');
for (const [name, expected] of Object.entries(record.artifacts)) {
  if (!['engine.js', 'monica_mdbx2_browser.wasm'].includes(name)) throw Error('Unexpected browser artifact.');
  const bytes = await readFile(resolve(pkg, name));
  if (sha256(bytes) !== expected.sha256 || bytes.length !== expected.bytes) throw Error(`Browser artifact integrity failed: ${name}`);
}
if (Object.keys(record.artifacts).length !== 2) throw Error('Missing browser engine artifacts.');
console.log('Bundled MDBX source inventory, toolchain and artifacts verified.');
