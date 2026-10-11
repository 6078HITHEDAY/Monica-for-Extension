// Current 318 MDBX Passkey acceptance. Only replaces/restores the test package.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = resolve(process.env.MONICA_315_APP_FIXTURE || resolve(root, '.tmp/android-passkey-runtime-318'));
const buildRoot = resolve(root, '.tmp/android-passkey-runtime-build-318');
const backupDirectory = resolve(process.env.MONICA_APP_INTEROP_DEVICE_BACKUP || resolve(root, '.tmp/android-passkey-runtime-318'));
const stage = process.argv[2];
const adb = (...args) => execFileSync('D:/AndroidSDK/platform-tools/adb.exe', ['-s', 'emulator-5554', ...args], { windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function packageInfo(name) {
  const path = adb('shell', 'pm', 'path', name).toString().trim().replace(/^package:/, '');
  assert.match(path, /^\/data\/app\/[^\r\n]+\/base\.apk$/);
  const sha256 = adb('shell', 'sha256sum', path).toString().split(/\s+/)[0];
  assert.match(sha256, /^[0-9a-f]{64}$/);
  return { path, sha256 };
}
function idle() {
  assert.match(adb('emu', 'avd', 'name').toString(), /^Monica_Issue136_API_32\r?\r?$/m);
  const state = adb('shell', 'dumpsys', 'activity', 'processes').toString();
  assert.ok(state.includes('ACTIVITY MANAGER RUNNING PROCESSES'));
  assert.ok(!state.includes('FAILED_TRANSACTION') && !state.includes('ActiveInstrumentation{'), 'Shared AVD must be healthy and idle');
}
async function runRunner(name) {
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [resolve(root, 'scripts/interop-315-android-app.mjs'), name], {
      cwd: root, windowsHide: true, stdio: 'inherit', env: { ...process.env,
        MONICA_315_APP_FIXTURE: output, MONICA_APP_INTEROP_BUILD_ROOT: buildRoot,
        MONICA_APP_INTEROP_TEST_SET: process.env.MONICA_APP_INTEROP_TEST_SET || 'passkey-signatures',
        MONICA_APP_INTEROP_REVIEWED_RUNTIME: resolve(root, '.tmp/android-project-fields-318/runtime-evidence.json'),
        MONICA_APP_INTEROP_TEST_MANIFEST: resolve(root, 'tests/interop/android-app/passkey-signatures-AndroidManifest.xml'),
      },
    });
    child.on('error', reject); child.on('exit', code => code === 0 ? accept() : reject(new Error(`Runner exited ${code}`)));
  });
}

await mkdir(output, { recursive: true });
await mkdir(backupDirectory, { recursive: true });
const baselinePath = resolve(backupDirectory, 'device-baseline.json');
if (stage === 'capture') {
  idle();
  // Never overwrite an earlier package snapshot with this task's replacement.
  try { await readFile(baselinePath); throw new Error('Baseline already exists; inspect it rather than replacing it'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const app = packageInfo('takagi.ru.monica'), test = packageInfo('takagi.ru.monica.test');
  const bytes = adb('exec-out', 'cat', test.path);
  assert.equal(hash(bytes), test.sha256);
  const testApk = resolve(backupDirectory, 'original-test.apk');
  await writeFile(testApk, bytes);
  await writeFile(baselinePath, JSON.stringify({ createdAt: new Date().toISOString(), app, test, testApk,
    avd: 'Monica_Issue136_API_32', bootId: adb('shell', 'cat', '/proc/sys/kernel/random/boot_id').toString().trim() }, null, 2));
  console.log(JSON.stringify({ app: app.sha256, test: test.sha256, saved: true }));
} else {
  const baseline = JSON.parse(await readFile(baselinePath));
  idle();
  assert.equal(packageInfo('takagi.ru.monica').sha256, baseline.app.sha256, 'Current app changed; do not install anything');
  const build = JSON.parse(await readFile(resolve(output, 'build-evidence.json')));
  const currentTest = packageInfo('takagi.ru.monica.test').sha256;
  if (stage === 'restore') {
    assert.ok([baseline.test.sha256, build.builtTestApkSha256].includes(currentTest), 'Another task replaced instrumentation; do not overwrite it');
    assert.equal(hash(await readFile(baseline.testApk)), baseline.test.sha256);
    if (currentTest !== baseline.test.sha256) adb('install', '-r', '-t', baseline.testApk);
    assert.equal(packageInfo('takagi.ru.monica.test').sha256, baseline.test.sha256);
    assert.equal(packageInfo('takagi.ru.monica').sha256, baseline.app.sha256);
    await writeFile(resolve(backupDirectory, 'device-restoration.json'), JSON.stringify({ status: 'passed',
      appSha256: baseline.app.sha256, testSha256: baseline.test.sha256, restoredAt: new Date().toISOString(), emulatorStopped: false }, null, 2));
    console.log('Original instrumentation restored; application unchanged.');
  } else {
    assert.ok(['install-test', 'passkey-signatures-export', 'passkey-signatures-import', 'bitwarden-copies'].includes(stage));
    assert.equal(currentTest, stage === 'install-test' ? baseline.test.sha256 : build.builtTestApkSha256);
    await runRunner(stage);
  }
}
