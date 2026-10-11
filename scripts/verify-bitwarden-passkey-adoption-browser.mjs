import { build } from 'vite';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const profile = process.env.MONICA_PASSKEY_ADOPTION_PROFILE || await mkdtemp(resolve('.tmp/bw-passkey-adoption-edge-'));
if (!resolve(profile).startsWith(resolve('.tmp/bw-passkey-adoption-edge-'))) throw new Error('Acceptance requires a dedicated task profile');
const bundleDirectory = await mkdtemp(resolve('.tmp/bw-passkey-adoption-bundle-'));
const executablePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
await build({ configFile: false, root: process.cwd(), logLevel: 'error', build: { outDir: bundleDirectory, emptyOutDir: false, sourcemap: false,
  lib: { entry: resolve('tests/interop/bitwarden-passkey-adoption-browser.ts'), formats: ['es'], fileName: () => 'harness.js' } } });
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://127.0.0.1:5193').pathname;
    if (path === '/__passkey-adoption') {
      response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Monica synthetic acceptance</title><script type="module" src="/harness.js"></script>'); return;
    }
    const file = resolve(bundleDirectory, `.${decodeURIComponent(path)}`);
    if (!file.startsWith(`${bundleDirectory}${sep}`)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'application/javascript'); response.end(await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
const results = []; let context; let browserVersion; const pending = new Set(); const browserErrors = [];
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(5193, '127.0.0.1', resolve); });
  for (const phase of ['stage', 'commit-loss', 'recover']) {
    context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, args: ['--no-first-run'] });
    const page = await context.newPage();
    browserVersion = await page.evaluate(() => navigator.userAgent);
    page.on('pageerror', error => { browserErrors.push(error.message); process.stderr.write(`${error.message}\n`); });
    page.on('request', request => pending.add(new URL(request.url()).pathname));
    page.on('requestfinished', request => pending.delete(new URL(request.url()).pathname));
    page.on('requestfailed', request => { pending.delete(new URL(request.url()).pathname); browserErrors.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`); });
    await page.goto('http://127.0.0.1:5193/__passkey-adoption', { waitUntil: 'commit' });
    await page.waitForFunction(() => typeof globalThis.runPasskeyAdoption === 'function');
    const result = await page.evaluate(phase => globalThis.runPasskeyAdoption(phase), phase);
    results.push(result); console.log(JSON.stringify(result));
    await context.close(); context = undefined;
  }
  await writeFile('.artifacts/bw-passkey-adoption-edge.json', JSON.stringify({ status: 'passed', executablePath, browserVersion, profile, bundleDirectory,
    actualBrowserRestarts: 2, scope: 'Real Edge IndexedDB and production client/coordinator with injected synthetic HTTP, not live Bitwarden/Android or MV3 UI', results }, null, 2));
} catch (error) {
  await writeFile('.artifacts/bw-passkey-adoption-edge.json', JSON.stringify({ status: 'failed', executablePath, browserVersion, profile, results, pending: [...pending], browserErrors, error: error.message }, null, 2));
  throw error;
} finally { await context?.close(); await new Promise(resolve => server.close(resolve)); }
