import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, basename } from 'node:path';

const root = resolve(import.meta.dirname, '..'), host = resolve(root, 'native/mdbx2-host');
const hash = text => createHash('sha256').update(text).digest('hex');
const normalize = text => text.replace(/\r\n/g, '\n');
const provenancePath = resolve(host, 'ENGINE-PROVENANCE.json');
const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
const previous = provenance.extension_overlays.filter(row => row.id !== 'retained-sync-disclosure');
const effective = Object.assign({}, provenance.files, ...previous.map(row => row.files));
const files = {}, base_files = {}; let patch = '';
for (const relative of ['crates/mdbx-storage/src/object_disclosure.rs', 'crates/mdbx-ffi/src/object_facade.rs']) {
  const baseline = resolve(root, '.codex-tasks/android-interop-315/raw/retained-sync-baseline', basename(relative));
  const current = resolve(host, 'vendor/mdbx', relative);
  const before = normalize(await readFile(baseline, 'utf8')), after = normalize(await readFile(current, 'utf8'));
  if (hash(before) !== effective[relative]) throw Error(`Unrecognized baseline: ${relative}`);
  const diff = spawnSync('git', ['diff', '--no-index', '--text', '--', baseline, current], {encoding:'utf8'});
  if (diff.status !== 1) throw Error('Expected an actual source overlay');
  const lines = normalize(diff.stdout).split('\n'), hunk = lines.findIndex(line=>line.startsWith('@@'));
  if (hunk < 0) throw Error('Missing diff hunk');
  patch += `diff --git a/${relative} b/${relative}\n--- a/${relative}\n+++ b/${relative}\n` + lines.slice(hunk).join('\n');
  base_files[relative] = hash(before); files[relative] = hash(after);
}
const patchPath = 'runtime-patches/extension-retained-sync-disclosure.patch';
await writeFile(resolve(host, patchPath), patch);
provenance.extension_overlays = [...previous, {id:'retained-sync-disclosure',patch:patchPath,patch_sha256:hash(patch),
  description:'Explicit synchronization disclosure of retained trashed objects with unchanged Tiga entry authorization, audit and payload limits. Ordinary reveal still rejects deleted content; no storage format or Android change.',base_files,files}];
await writeFile(provenancePath, JSON.stringify(provenance,null,2)+'\n');
