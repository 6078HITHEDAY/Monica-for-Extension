import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, basename } from 'node:path';
import { test } from 'node:test';
import { zipSync } from 'fflate';
import { preparePreviewAssets, publishPreview } from './publish-preview.mjs';

const sha = 'a'.repeat(40), repository = 'Monica-Pass/Monica-for-Extension';
const env = { GITHUB_REPOSITORY: repository, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'monica-preview-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'native/mdbx2-host'), { recursive: true });
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ version: '1.0.102' }));
  await writeFile(resolve(root, 'native/mdbx2-host/Cargo.toml'), '[package]\nversion = "0.1.0"\n');
  const artifactRoot = resolve(root, '.artifacts/preview');
  const source = { commit: sha, trackedWorktreeClean: true };
  const rows = [
    ['extension', 'monica-extension-1.0.102.zip', { 'manifest.json': { version: '1.0.102', manifest_version: 3 }, 'SECURITY-EVIDENCE.json': { source } }],
    ['host', 'monica-mdbx2-host-windows-x64-0.1.0.zip', { 'HOST-METADATA.json': { version: '0.1.0', platform: 'windows-x64', source } }]
  ];
  for (const [directory, name, json] of rows) {
    await mkdir(resolve(artifactRoot, directory), { recursive: true });
    const bytes = zipSync(Object.fromEntries(Object.entries(json).map(([name, value]) => [name, new TextEncoder().encode(JSON.stringify(value))])));
    await writeFile(resolve(artifactRoot, directory, name), bytes);
    await writeFile(resolve(artifactRoot, directory, `${name}.sha256`), `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);
  }
  return { root, options: { artifactRoot, stagingDir: resolve(artifactRoot, 'publish'), sourceCommit: sha, runId: '123', attempt: '1', extensionVersion: '1.0.102', hostVersion: '0.1.0' } };
}
function mockGh({ existing = true, uploadFailure = false, advanced = false } = {}) {
  const calls = []; let mainChecks = 0;
  const gh = args => {
    calls.push(args);
    if (args[1]?.endsWith('/git/ref/heads/main')) return advanced || ++mainChecks > 99 ? 'b'.repeat(40) : sha;
    if (args.includes('--slurp')) {
      assert.ok(!args.includes('--jq'), 'gh cannot combine --slurp and --jq');
      return JSON.stringify([existing ? [{ tag_name: 'preview', draft: true }] : []]);
    }
    if (args[0] === 'release' && args[1] === 'upload' && uploadFailure) throw Error('Synthetic upload failure');
    if (args[1]?.endsWith('/git/ref/tags/preview')) return existing ? '{}' : null;
    if (args[1]?.endsWith('/releases/tags/preview')) return JSON.stringify({ assets: [{ id: 9, name: 'old-preview.zip' }, { id: 10, name: `monica-extension-1.0.102-preview-${sha.slice(0,12)}-123-1.zip` }] });
    return '';
  };
  return { calls, gh };
}

test('stages both verified ZIPs unchanged and rewrites checksums to their unique names', async t => {
  const f = await fixture(t), result = await preparePreviewAssets(f.options);
  assert.equal(result.files.length, 4);
  for (let i = 0; i < result.files.length; i += 2) {
    const bytes = await readFile(result.files[i]);
    assert.equal(await readFile(result.files[i+1], 'utf8'), `${createHash('sha256').update(bytes).digest('hex')}  ${basename(result.files[i])}\n`);
    const original = i === 0 ? 'extension/monica-extension-1.0.102.zip' : 'host/monica-mdbx2-host-windows-x64-0.1.0.zip';
    assert.deepEqual(bytes, await readFile(resolve(f.options.artifactRoot, original)));
  }
});
test('rejects mismatched commits and corrupted checksums before publication', async t => {
  const f = await fixture(t);
  await assert.rejects(preparePreviewAssets({ ...f.options, sourceCommit: 'b'.repeat(40) }), /different source commit/);
  await writeFile(resolve(f.options.artifactRoot, 'host/monica-mdbx2-host-windows-x64-0.1.0.zip.sha256'), 'bad');
  const m = mockGh();
  await assert.rejects(publishPreview({ env, projectRoot: f.root, gh: m.gh }), /checksum mismatch/);
  assert.ok(m.calls.every(args => args[0] === 'api' && args[1].endsWith('/git/ref/heads/main')));
});
test('uploads before moving tag, publishes before cleaning old assets, and reuses a draft', async t => {
  const f = await fixture(t), m = mockGh();
  await publishPreview({ env, projectRoot: f.root, gh: m.gh });
  const upload = m.calls.findIndex(args => args[1] === 'upload'), edit = m.calls.findIndex(args => args[1] === 'edit');
  assert.ok(upload >= 0 && edit > upload);
  assert.ok(m.calls.findIndex(args => args.includes('PATCH')) > upload);
  assert.ok(m.calls.findIndex(args => args.includes('DELETE')) > edit);
  assert.ok(!m.calls.some(args => args[1] === 'create'));
  assert.deepEqual(m.calls.filter(args => args.includes('DELETE')).map(args => args[1]), [`repos/${repository}/releases/assets/9`]);
  assert.ok(m.calls[edit].includes('--latest=false'));
});
test('a failed upload never moves the tag or removes previous packages', async t => {
  const f = await fixture(t), m = mockGh({ uploadFailure: true });
  await assert.rejects(publishPreview({ env, projectRoot: f.root, gh: m.gh }), /upload failure/);
  assert.ok(!m.calls.some(args => args.includes('PATCH') || args.includes('DELETE') || args[1] === 'edit'));
});
test('first publication creates a draft and tag before making the release public', async t => {
  const f = await fixture(t), m = mockGh({ existing: false });
  await publishPreview({ env, projectRoot: f.root, gh: m.gh });
  assert.ok(m.calls.find(args => args[1] === 'create').includes('--draft'));
  assert.ok(m.calls.findIndex(args => args.includes('POST')) < m.calls.findIndex(args => args[1] === 'edit'));
});
test('forks, pull requests and stale main builds cannot publish', async () => {
  for (const altered of [{ GITHUB_REPOSITORY: 'other/fork' }, { GITHUB_REF: 'refs/pull/1/merge' }, { GITHUB_EVENT_NAME: 'pull_request' }]) {
    await assert.rejects(publishPreview({ env: { ...env, ...altered }, gh: () => { throw Error('must not access GitHub'); } }));
  }
  const m = mockGh({ advanced: true });
  await publishPreview({ env, gh: m.gh });
  assert.equal(m.calls.length, 1);
});
