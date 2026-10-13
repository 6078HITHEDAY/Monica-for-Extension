import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserSourceInventory, verifyBrowserTempfile } from './mdbx2-browser-provenance.mjs';

const root = resolve(import.meta.dirname, '..');
const crate = resolve(root, 'native/mdbx2-browser');
const target = resolve(process.env.MONICA_MDBX_BROWSER_TARGET || resolve(crate, 'target'));
const output = resolve(crate, 'pkg');
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { cwd: root, windowsHide: true, encoding: 'utf8', ...options });
const rust = run('rustc', ['+1.97.0', '--version']).trim();
if (!rust.startsWith('rustc 1.97.0 ')) throw new Error('The browser engine requires Rust 1.97.0.');
const rustCommit = run('rustc', ['+1.97.0', '--version', '--verbose']).match(/^commit-hash: (.+)$/m)?.[1];
if (rustCommit !== '2d8144b7880597b6e6d3dfd63a9a9efae3f533d3') throw new Error('Unexpected Rust compiler revision.');
// The caller loads the local SDK environment; never activate or install globally.
const emcc = process.platform === 'win32'
  ? run('cmd.exe', ['/d', '/c', 'emcc.bat -dumpversion']).trim()
  : run('emcc', ['-dumpversion']).trim();
if (emcc !== '4.0.18') throw new Error('Load the Emscripten 4.0.18 environment before building MDBX.');
run(process.execPath, ['scripts/verify-mdbx2-host.mjs'], { stdio: 'inherit' });
await verifyBrowserTempfile();
const sources = await browserSourceInventory();
const functions = ['main', 'mdbx_input', 'mdbx_dispatch', 'mdbx_output_ptr', 'mdbx_output_len', 'mdbx_clear_output', 'mdbx_close'].map(name => `_${name}`);
const linkArgs = ['--no-entry', '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=worker', '-sDYNAMIC_EXECUTION=0', '-sALLOW_MEMORY_GROWTH=1', '-sFORCE_FILESYSTEM=1', '-sSTACK_SIZE=2097152', '-sSTACK_OVERFLOW_CHECK=2', '-sEXPORTED_RUNTIME_METHODS=FS,HEAPU8', `-sEXPORTED_FUNCTIONS=${JSON.stringify(functions)}`];
const flags = linkArgs.flatMap(arg => ['-C', `link-arg=${arg}`]);
run('cargo', ['+1.97.0', 'build', '--locked', '--offline', '--release', '--target', 'wasm32-unknown-emscripten', '--manifest-path', resolve(crate, 'Cargo.toml'), '--bin', 'monica-mdbx2-browser'], {
  stdio: 'inherit',
  env: { ...process.env, RUSTFLAGS: '', CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f'), CARGO_TARGET_DIR: target },
});
await mkdir(output, { recursive: true });
const built = resolve(target, 'wasm32-unknown-emscripten/release');
await copyFile(resolve(built, 'monica-mdbx2-browser.js'), resolve(output, 'engine.js'));
await copyFile(resolve(built, 'monica_mdbx2_browser.wasm'), resolve(output, 'monica_mdbx2_browser.wasm'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const artifacts = {};
for (const name of ['engine.js', 'monica_mdbx2_browser.wasm']) {
  const bytes = await readFile(resolve(output, name)); artifacts[name] = { sha256: sha(bytes), bytes: bytes.length };
}
if (JSON.stringify(sources) !== JSON.stringify(await browserSourceInventory())) throw new Error('Browser engine sources changed during compilation.');
await writeFile(resolve(output, 'BROWSER-BUILD.json'), JSON.stringify({ schema: 2, rust, rustCommit, emscripten: emcc, linkArgs, sources,
  engineProvenanceSha256: sha(await readFile(resolve(root, 'native/mdbx2-host/ENGINE-PROVENANCE.json'))), artifacts }, null, 2) + '\n');
console.log(`Built bundled MDBX engine: ${artifacts['monica_mdbx2_browser.wasm'].bytes} WASM bytes.`);
