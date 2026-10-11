import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, '.tmp/android-current-system-final-318');
const env = { ...process.env, MONICA_CM_EVIDENCE_DIR: out, MONICA_CM_BACKUP_FLAGS: '1', MONICA_CM_KEY_HASHES: '1' };
const adb = (...args) => execFileSync('D:/AndroidSDK/platform-tools/adb.exe', ['-s', 'emulator-5560', ...args],
  { windowsHide: true, timeout: 30000, maxBuffer: 32e6, encoding: 'utf8' });
function run(script, ...args) {
  return execFileSync(process.execPath, [join(root, 'scripts', script), ...args],
    { cwd: root, env, windowsHide: true, timeout: 60000, maxBuffer: 32e6, encoding: 'utf8' });
}
const device = (...args) => run('interop-317-android-cm-device.mjs', ...args);
const ui = (...args) => run('interop-317-android-cm-ui.mjs', ...args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = [];
async function observed(tag, match) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const name = `${tag}-${attempt}`, rows = JSON.parse(ui('snapshot', name));
    if (rows.some(match)) { log.push({ tag, screenshot: `${name}.png`, xml: `${name}.xml` }); return { rows, name }; }
    await sleep(600);
  }
  throw new Error(`Expected actual UI not observed: ${tag}`);
}
const textIs = text => row => row.text === text || row.description === text;
async function type(value) {
  for (const character of value) { adb('shell', 'input', 'text', character); await sleep(80); }
}
async function start(id, tag) {
  device('request', id, tag);
  await observed(`${tag}-rp`, textIs('REQUEST PASSKEY'));
  ui('tap-text', 'REQUEST PASSKEY');
}
async function password(tag, wrongFirst = false) {
  await observed(`${tag}-picker`, textIs('继续')); ui('tap-text', '继续');
  await observed(`${tag}-auth`, textIs('使用主密码')); ui('tap-text', '使用主密码');
  await observed(`${tag}-dialog`, textIs('显示密码')); ui('tap-edit');
  const subtype = adb('shell', 'settings', 'get', 'secure', 'selected_input_method_subtype').trim();
  if (subtype === '617035939') adb('shell', 'input', 'keyevent', 'KEYCODE_LANGUAGE_SWITCH');
  assert.equal(adb('shell', 'settings', 'get', 'secure', 'selected_input_method_subtype').trim(), '1594443099', 'Use observed English subtype');
  ui('tap-text', '显示密码');
  if (wrongFirst) {
    await type('WrongCMPassword'); await observed('wrong-entered', textIs('WrongCMPassword'));
    ui('tap-text', '确定'); await observed('actual-wrong-password-error', textIs('密码错误'));
    assert.equal(adb('shell', 'run-as', 'com.monica.interop.rp317', 'ls', 'files').includes('result.json'), false);
    device('storage-sqlite-live', 'after-wrong-password');
    ui('tap-edit'); adb('shell', 'input', 'keycombination', '113', '29'); adb('shell', 'input', 'keyevent', 'KEYCODE_DEL');
  }
  await type('SyntheticCM317Password');
  await observed(`${tag}-password-entered`, textIs('SyntheticCM317Password'));
  ui('tap-text', '确定'); await observed(`${tag}-returned`, textIs('Credential returned'));
  device('result', tag); console.log(`Actual system assertion: ${tag}`);
}
const original = 'CTLPKBjcGUvc47F7aY1LKGGsiCm1MwXuYNjipkiKbTw';
try {
  device('ready'); device('storage-sqlite-live', 'before-flags');
  await start('MmNjMzE2NzEtOTNkOC00NTI4LWFjN2QtYWNlODZlOTk5M2Iy', 'flags-be-true-bs-false');
  await password('flags-be-true-bs-false', true);
  await start('YWVmYTIxMGMtOTc3Mi00OWE2LTkxMzktNmNlM2MzOWNhMWYy', 'flags-be-false-bs-false');
  await password('flags-be-false-bs-false');
  await start(original, 'original-edge-rsa'); await password('original-edge-rsa');
  device('storage-sqlite-live', 'after-flags');
  await start(original, 'system-cancel'); await observed('system-cancel-picker', textIs('继续'));
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); await observed('system-cancel-return', textIs('Credential error'));
  device('result', 'system-cancel');
  await start(original, 'monica-cancel'); await observed('monica-cancel-picker', textIs('继续')); ui('tap-text', '继续');
  await observed('monica-cancel-auth', textIs('使用主密码')); ui('tap-text', '取消');
  await observed('monica-cancel-return', textIs('Credential error')); device('result', 'monica-cancel');
  const beforeLog = adb('logcat', '-d', '-v', 'epoch', 'MonicaCredentialProvider:D', '*:S');
  await writeFile(join(out, 'unknown-provider-before.log'), beforeLog);
  await start('AAAAAAAAAAAAAAAAAAAAAA', 'unknown-allow-list');
  const empty = await observed('unknown-empty-sheet', textIs('使用其他登录方式'));
  const ready = JSON.parse(await readFile(join(out, 'ready.json'), 'utf8'));
  for (const record of ready.records) assert.ok(!empty.rows.some(row => row.text === record.userName));
  const afterLog = adb('logcat', '-d', '-v', 'epoch', 'MonicaCredentialProvider:D', '*:S');
  await writeFile(join(out, 'unknown-provider-after.log'), afterLog);
  const added = afterLog.split(/\r?\n/).filter(line => !beforeLog.split(/\r?\n/).includes(line));
  assert.ok(added.some(line => line.includes('Resolved passkeys count=0, rpId=passkey-interop.example.test')));
  ui('tap-text', '忽略'); await observed('unknown-return', textIs('Credential error'));
  device('result', 'unknown-allow-list');
  await writeFile(join(out, 'unknown-empty-proof.json'), JSON.stringify({ ui: empty.name, newProviderLines: added,
    noMatchingMonicaEntries: true, userDismissedPlatformAlternateDevicePrompt: true }, null, 2));
  device('storage-sqlite-live', 'after-unknown-allow-list'); device('storage-sqlite-live', 'final-room');
  console.log('Actual UI batch complete; independently verify responses next.');
} finally {
  await writeFile(join(out, 'ui-observations.json'), JSON.stringify(log, null, 2));
  const settings = adb('shell', 'settings', 'list', 'secure').split(/\r?\n/)
    .filter(line => /^[a-z_]*input_method/.test(line) || /^enabled_input_methods=|^selected_input_method_subtype=/.test(line));
  await writeFile(join(out, 'input-method-after.txt'), settings.join('\n') + '\n');
}
