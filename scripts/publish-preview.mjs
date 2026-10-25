import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';

const repository = 'Monica-Pass/Monica-for-Extension';
const root = resolve(import.meta.dirname, '..');

export async function preparePreviewAssets({ artifactRoot, stagingDir, sourceCommit, runId, attempt, extensionVersion, hostVersion }) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(runId, /^\d+$/);
  assert.match(attempt, /^\d+$/);
  for (const version of [extensionVersion, hostVersion]) assert.match(version, /^\d+\.\d+\.\d+$/);
  const suffix = `${sourceCommit.slice(0, 12)}-${runId}-${attempt}`;
  const packages = [
    { directory: 'extension', base: `monica-extension-${extensionVersion}`, metadata: 'SECURITY-EVIDENCE.json' },
    { directory: 'host', base: `monica-mdbx2-host-windows-x64-${hostVersion}`, metadata: 'HOST-METADATA.json' }
  ];
  // Validate both packages before writing anything or modifying the public release.
  const verified = await Promise.all(packages.map(async item => {
    const name = `${item.base}.zip`;
    const bytes = await readFile(resolve(artifactRoot, item.directory, name));
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal(await readFile(resolve(artifactRoot, item.directory, `${name}.sha256`), 'utf8'), `${digest}  ${name}\n`, `${name}: checksum mismatch`);
    const entries = unzipSync(bytes);
    assert.ok(entries[item.metadata], `${name}: missing source evidence`);
    const metadata = JSON.parse(new TextDecoder().decode(entries[item.metadata]));
    assert.equal(metadata.source?.commit, sourceCommit, `${name}: different source commit`);
    assert.equal(metadata.source?.trackedWorktreeClean, true, `${name}: dirty build`);
    if (item.directory === 'extension') {
      const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
      assert.equal(manifest.version, extensionVersion);
      assert.equal(manifest.manifest_version, 3);
    } else {
      assert.equal(metadata.version, hostVersion);
      assert.equal(metadata.platform, 'windows-x64');
    }
    return { bytes, digest, name: `${item.base}-preview-${suffix}.zip` };
  }));
  await mkdir(stagingDir, { recursive: true });
  const files = [];
  for (const item of verified) {
    const archive = resolve(stagingDir, item.name), checksum = `${archive}.sha256`;
    await writeFile(archive, item.bytes);
    await writeFile(checksum, `${item.digest}  ${item.name}\n`);
    files.push(archive, checksum);
  }
  return { files, suffix };
}

function runGh(args, { allowMissing = false } = {}) {
  const result = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    if (allowMissing && /HTTP 404/.test(result.stderr || '')) return null;
    throw new Error(result.stderr || result.error?.message || `gh exited ${result.status}`);
  }
  return result.stdout.trim();
}

export async function publishPreview({ env = process.env, projectRoot = root, gh = runGh } = {}) {
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.ok(['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME), 'Only main pushes/manual runs may publish');
  const sourceCommit = env.GITHUB_SHA;
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  const currentMain = () => gh(['api', `repos/${repository}/git/ref/heads/main`, '--jq', '.object.sha']);
  if (currentMain() !== sourceCommit) {
    console.log('Main has advanced; keeping Preview for the newer build.');
    return;
  }
  const { version: extensionVersion } = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
  const cargo = await readFile(resolve(projectRoot, 'native/mdbx2-host/Cargo.toml'), 'utf8');
  const hostVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
  const stagingDir = resolve(projectRoot, '.artifacts/preview/publish');
  const { files, suffix } = await preparePreviewAssets({
    artifactRoot: resolve(projectRoot, '.artifacts/preview'), stagingDir, sourceCommit,
    runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, extensionVersion, hostVersion
  });
  const notesPath = resolve(stagingDir, 'release-notes.md');
  const title = `Development Preview (${extensionVersion} / ${suffix})`;
  const runUrl = `https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}`;
  await writeFile(notesPath, `## 中文\n\n自动更新的开发预览版，可能含有尚未稳定的改动。\n\n- 扩展版本：${extensionVersion}；源提交：\`${sourceCommit}\`。\n- [验证与构建记录](${runUrl})：Linux 发布门禁和 Windows Edge / MDBX Host 验证通过。\n- Chrome / Edge 使用扩展 ZIP；Windows MDBX Host 为可选本机助手。解压扩展后在开发者模式加载，更新时替换解压目录并重新加载。\n- 每个 ZIP 附带 SHA-256；内含的源码提交和清单保持原构建内容。此预览版不替代正式版更新通道。\n\n## English\n\nRolling development preview; changes may be unstable.\n\n- Extension version: ${extensionVersion}; source commit: \`${sourceCommit}\`.\n- [Validation and build](${runUrl}): Linux release gates and Windows Edge / MDBX Host checks passed.\n- Use the extension ZIP for Chrome / Edge; the Windows MDBX Host is optional. Extract and load in developer mode; replace the extracted directory and reload to update.\n- Each ZIP includes a SHA-256 sidecar. Embedded source evidence and manifests retain the original build contents. Stable update checks continue to use stable releases.\n`);
  const releasePath = `repos/${repository}/releases/tags/preview`;
  // Listing also finds a draft left by an interrupted first upload.
  const previews = JSON.parse(gh(['api', `repos/${repository}/releases`, '--paginate', '--slurp', '--jq', 'map(.[]) | map(select(.tag_name == "preview"))']));
  assert.ok(previews.length <= 1, 'Multiple preview releases require cleanup before publication');
  const previous = previews[0];
  if (!previous) {
    // The first release stays a draft until both ZIP/checksum pairs are uploaded.
    gh(['release', 'create', 'preview', '--repo', repository, '--target', sourceCommit, '--draft', '--prerelease', '--latest=false', '--title', title, '--notes-file', notesPath]);
  }
  // Unique names keep the previous complete package available if an upload fails.
  gh(['release', 'upload', 'preview', ...files, '--repo', repository, '--clobber']);
  if (currentMain() !== sourceCommit) {
    console.log('Main advanced during upload; Preview metadata was retained for the newer build.');
    return;
  }
  const tag = gh(['api', `repos/${repository}/git/ref/tags/preview`], { allowMissing: true });
  if (tag === null) gh(['api', `repos/${repository}/git/refs`, '--method', 'POST', '-f', 'ref=refs/tags/preview', '-f', `sha=${sourceCommit}`]);
  else gh(['api', `repos/${repository}/git/refs/tags/preview`, '--method', 'PATCH', '-f', `sha=${sourceCommit}`, '-F', 'force=true']);
  gh(['release', 'edit', 'preview', '--repo', repository, '--draft=false', '--prerelease', '--latest=false', '--title', title, '--notes-file', notesPath]);
  // Remove only assets of this rolling release, after publication succeeds.
  const current = JSON.parse(gh(['api', releasePath]));
  const keep = new Set(files.map(file => file.split(/[\\/]/).at(-1)));
  for (const asset of current.assets) {
    if (!keep.has(asset.name)) gh(['api', `repos/${repository}/releases/assets/${asset.id}`, '--method', 'DELETE']);
  }
  console.log(`Updated https://github.com/${repository}/releases/tag/preview with ${files.length} assets from ${sourceCommit}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await publishPreview();
