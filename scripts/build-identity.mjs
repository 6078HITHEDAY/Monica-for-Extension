import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
const root = resolve(import.meta.dirname, '..');
// A browser version, bundled runtime version and future release tag must agree.
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(root, 'public/manifest.json'), 'utf8'));
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version)
  || pkg.version.split('.').some(part => Number(part) > 65535)
  || pkg.version === '0.0.0'
  || [manifest.version, lock.version, lock.packages?.['']?.version].some(version => version !== pkg.version)) {
  throw new Error('Use matching numeric X.Y.Z versions in package.json, package-lock.json and public/manifest.json.');
}
const target = 'src/runtime/build-id.json';
const names = [];
for (const directory of ['src', 'public']) {
  for (const name of await readdir(resolve(root, directory), {recursive: true, withFileTypes: true})) {
    if (!name.isFile()) continue;
    const file = relative(root, resolve(name.parentPath, name.name)).replaceAll('\\', '/');
    if (file !== target && !/\.(test|spec)\./.test(file)) names.push(file);
  }
}
names.push('package.json', 'package-lock.json', 'vite.config.ts', 'scripts/build-workers.mjs');
const hash = createHash('sha256');
for (const name of names.sort()) {
  const bytes = await readFile(resolve(root, name));
  // Git checkouts may use CRLF or LF. Hash the same text on either platform,
  // while preserving every byte of binary resources such as icons and fonts.
  const canonical = /\.(?:ts|vue|json|css|html|js|mjs|svg|txt)$/.test(name)
    ? bytes.toString('utf8').replace(/\r\n/g, '\n') : bytes;
  hash.update(name); hash.update('\0'); hash.update(canonical); hash.update('\0');
}
const buildId = hash.digest('hex').slice(0, 20);
await writeFile(resolve(root, target), JSON.stringify({buildId}, null, 2) + '\n');
console.log(`Source build identity: ${buildId}`);
