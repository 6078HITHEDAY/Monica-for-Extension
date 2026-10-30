import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

export const root = resolve(import.meta.dirname, '..');
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const textHash = bytes => sha256(Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n')));
async function files(directory) {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name === 'target' || item.name === 'pkg' || item.name === '.cargo-ok') continue;
    const path = resolve(directory, item.name);
    if (item.isDirectory()) result.push(...await files(path));
    else if (item.isFile()) result.push(path);
    else throw Error('Browser source inventory contains an unsupported file node.');
  }
  return result;
}
export async function browserSourceInventory() {
  const paths = [
    ...await files(resolve(root, 'native/mdbx2-browser')),
    ...await files(resolve(root, 'native/mdbx2-host/src')),
    resolve(root, 'native/mdbx2-host/ENGINE-PROVENANCE.json'),
    resolve(root, 'scripts/build-mdbx2-browser.mjs'),
    resolve(root, 'scripts/mdbx2-browser-provenance.mjs'),
  ];
  const inventory = {};
  for (const path of paths.sort()) inventory[relative(root, path).replaceAll('\\', '/')] = textHash(await readFile(path));
  return inventory;
}
export async function verifyBrowserTempfile() {
  const crate = resolve(root, 'native/mdbx2-browser');
  const provenance = JSON.parse(await readFile(resolve(crate, 'TEMPFILE-PROVENANCE.json'), 'utf8'));
  if (provenance.version !== '3.27.0' || provenance.archiveSha256 !== '32497e9a4c7b38532efcdebeef879707aa9f794296a4f0244f6f69e9bc8574bd') throw Error('Unexpected tempfile source.');
  const expected = { ...provenance.files, ...provenance.overlay };
  const actual = {};
  for (const path of (await files(resolve(crate, 'vendor/tempfile'))).sort()) actual[relative(resolve(crate, 'vendor/tempfile'), path).replaceAll('\\', '/')] = textHash(await readFile(path));
  if (Object.keys(actual).length !== Object.keys(expected).length || Object.entries(expected).some(([path, hash]) => actual[path] !== hash)) throw Error('Browser tempfile source differs from its reviewed inventory.');
}
