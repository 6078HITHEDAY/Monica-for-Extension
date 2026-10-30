// Separate runtime provenance: keep the successful instrumentation compile baseline intact.
// This audit accepts only the reviewed overview-default change, not arbitrary app drift.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(root, '../Monica-main');
const fixture = resolve(process.env.MONICA_315_APP_FIXTURE || resolve(root, '.tmp/android-project-fields-318'));
const git = (...args) => execFileSync('git', args, { cwd: repository, windowsHide: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const buildPath = resolve(fixture, 'build-evidence.json');
const buildBytes = await readFile(buildPath), build = JSON.parse(buildBytes);
assert.equal(build.status, 'passed');
assert.equal(build.androidSourcesUnchanged, true);
assert.equal(build.testSourcesUnchanged, true);
assert.equal(build.baseline.revision, '83664b96995d3d4ba7ecc6ad705b6716ac594431');
assert.equal(hash(await readFile(build.builtAppApk)), build.builtAppApkSha256);
assert.equal(hash(await readFile(build.builtTestApk)), build.builtTestApkSha256);
for (const source of build.targetedAndroidTestSources) assert.equal(hash(await readFile(source.source)), source.sha256);
for (const source of build.testSourceHashes) assert.equal(hash(await readFile(resolve(root, source.path))), source.sha256);
const revision = git('rev-parse', 'HEAD').toString().trim();
assert.equal(revision, 'd7702cac415af9ca02318971aa33d61d8ec30ab8');
const changed = 'Monica for Android/app/src/main/java/takagi/ru/monica/data/VaultOverviewConfig.kt';
const projectPath = 'Monica for Android';
const production = [projectPath, ':(exclude)Monica for Android/docs', ':(exclude)Monica for Android/app/src/test', ':(exclude)Monica for Android/app/src/androidTest'];
assert.equal(git('diff', '--name-only', build.baseline.revision, revision, '--', ...production).toString().trim(), changed);
assert.equal(git('diff', 'HEAD', '--', ...production).length, 0);
const untracked = git('ls-files', '--others', '--exclude-standard', '-z', '--', `${projectPath}/app/src/main`, `${projectPath}/buildSrc`, `${projectPath}/gradle`).toString();
assert.equal(untracked, '');
const oldSource = git('show', `${build.baseline.revision}:${changed}`).toString();
const newSource = git('show', `${revision}:${changed}`).toString();
assert.equal(newSource, oldSource.replace('    val scope: String = "local",',
  '    // Older settings omit the default scope. Include synced vaults when it is absent;\n    // an explicitly saved local/database scope still survives decoding and round trips.\n    val scope: String = "all",'));
const auditPath = resolve(repository, 'Monica for Android/docs/verification/vaultwarden-visibility-20261009/results.json');
const auditBytes = await readFile(auditPath), audit = JSON.parse(auditBytes);
assert.equal(audit.Main.device.completed, true);
assert.equal(audit.Main.device.tests, 7);
assert.ok(audit.Main.unit.every(suite => suite.failures === 0));
const runtimeApk = resolve(repository, 'Monica for Android/app/build/outputs/apk/debug/Monica-Android-x86_64-1.0.318-26100912-03.APK');
const runtimeApkSha256 = hash(await readFile(runtimeApk));
assert.equal(runtimeApkSha256, audit.Main.device.appHash.toLowerCase());
assert.equal(runtimeApkSha256, 'b6a3ab4d75234caafe928780be27b69c469fcfee6e950368015108c2defe223f');
const report = {
  status: 'passed', createdAt: new Date().toISOString(),
  scope: 'Run existing instrumentation against the independently tested current app. Compile APK and runtime APK are explicitly different; only the reviewed default overview scope changed. No application install or source change.',
  buildEvidence: buildPath, buildEvidenceSha256: hash(buildBytes),
  compileRevision: build.baseline.revision, compileApkSha256: build.builtAppApkSha256,
  testApkSha256: build.builtTestApkSha256, runtimeRevision: revision, runtimeApk, runtimeApkSha256,
  runtimeDeviceEvidence: auditPath, runtimeDeviceEvidenceSha256: hash(auditBytes),
  reviewedProductionDiff: git('diff', build.baseline.revision, revision, '--', ...production).toString(),
  productionSourceUnmodified: true,
  applicationTreeSha256: hash(git('ls-tree', '-r', revision, '--', projectPath)),
};
await writeFile(resolve(fixture, 'runtime-evidence.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, runtimeRevision: revision, runtimeApkSha256, compileRevision: report.compileRevision }));
