// Revalidate the already reviewed 318 runtime/API difference for test-only builds.
// This never equates the compile APK with the installed APK or installs an app.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function verifyReviewedRuntime(proofPath, repository) {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const git = (...args) => execFileSync('git', args, { cwd: repository, windowsHide: true });
  const bytes = await readFile(proofPath), proof = JSON.parse(bytes);
  assert.equal(proof.status, 'passed');
  assert.equal(proof.productionSourceUnmodified, true);
  assert.equal(proof.compileRevision, '83664b96995d3d4ba7ecc6ad705b6716ac594431');
  assert.equal(proof.runtimeRevision, 'd7702cac415af9ca02318971aa33d61d8ec30ab8');
  assert.equal(git('rev-parse', 'HEAD').toString().trim(), proof.runtimeRevision);
  const buildBytes = await readFile(proof.buildEvidence), build = JSON.parse(buildBytes);
  assert.equal(hash(buildBytes), proof.buildEvidenceSha256);
  assert.equal(build.status, 'passed');
  assert.equal(build.androidSourcesUnchanged, true);
  assert.equal(build.baseline.revision, proof.compileRevision);
  assert.equal(build.builtAppApkSha256, proof.compileApkSha256);
  assert.equal(hash(await readFile(build.builtAppApk)), proof.compileApkSha256);
  assert.equal(hash(await readFile(build.applicationCompileApi.path)), build.applicationCompileApi.sha256);
  assert.equal(proof.runtimeApkSha256, 'b6a3ab4d75234caafe928780be27b69c469fcfee6e950368015108c2defe223f');
  assert.equal(hash(await readFile(proof.runtimeApk)), proof.runtimeApkSha256);
  const deviceBytes = await readFile(proof.runtimeDeviceEvidence), device = JSON.parse(deviceBytes);
  assert.equal(hash(deviceBytes), proof.runtimeDeviceEvidenceSha256);
  assert.equal(device.Main.device.completed, true);
  assert.equal(device.Main.device.appHash.toLowerCase(), proof.runtimeApkSha256);
  const production = ['Monica for Android', ':(exclude)Monica for Android/docs',
    ':(exclude)Monica for Android/app/src/test', ':(exclude)Monica for Android/app/src/androidTest'];
  assert.equal(git('diff', 'HEAD', '--', ...production).length, 0);
  assert.equal(git('ls-files', '--others', '--exclude-standard', '-z', '--',
    'Monica for Android/app/src/main', 'Monica for Android/buildSrc', 'Monica for Android/gradle').length, 0);
  const changed = 'Monica for Android/app/src/main/java/takagi/ru/monica/data/VaultOverviewConfig.kt';
  assert.equal(git('diff', '--name-only', proof.compileRevision, proof.runtimeRevision, '--', ...production).toString().trim(), changed);
  const oldSource = git('show', `${proof.compileRevision}:${changed}`).toString();
  assert.equal(git('show', `${proof.runtimeRevision}:${changed}`).toString(), oldSource.replace('    val scope: String = "local",',
    '    // Older settings omit the default scope. Include synced vaults when it is absent;\n    // an explicitly saved local/database scope still survives decoding and round trips.\n    val scope: String = "all",'));
  assert.equal(hash(git('ls-tree', '-r', proof.runtimeRevision, '--', 'Monica for Android')), proof.applicationTreeSha256);
  return { proofPath: resolve(proofPath), proofSha256: hash(bytes), buildEvidence: resolve(proof.buildEvidence),
    buildEvidenceSha256: hash(buildBytes), compileRevision: proof.compileRevision, compileApkSha256: proof.compileApkSha256,
    runtimeRevision: proof.runtimeRevision, runtimeApkSha256: proof.runtimeApkSha256,
    applicationCompileApi: build.applicationCompileApi, productionSourceUnmodified: true,
    scope: 'Current runtime verified separately; instrumentation compiles against the prior API with only the explicitly reviewed overview-default source difference.' };
}
