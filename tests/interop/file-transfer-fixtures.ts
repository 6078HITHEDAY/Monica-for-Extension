import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createTransferExport, previewImport } from '../../src/manager/file-transfer';
import { createLoginItem, type TotpItem, type SecureNoteItem } from '../../src/core/model';
const root = path.resolve('.tmp/file-transfer-interop');
const now = '2026-10-23T00:00:00.000Z';
const login = { ...createLoginItem({ title: '迁移登录', username: '  用户@example.invalid  ', password: '  pass,"word\r\n🔑  ', notes: '第一行\nsecond line', uris: ['https://example.invalid/login'] }),
  id: 'synthetic-file-login', username: '  用户@example.invalid  ', categoryName: '工作' };
const totp: TotpItem = { id: 'synthetic-totp', kind: 'totp', title: '测试验证码', secret: 'JBSWY3DPEHPK3PXP', issuer: '测试服务', accountName: 'alice', algorithm: 'SHA256', digits: 8, period: 60, otpType: 'TOTP', notes: '备注', favorite: false, providerRefs: [], createdAt: now, updatedAt: now };
const note: SecureNoteItem = { id: 'synthetic-note', kind: 'secure-note', title: '笔记', notes: '', content: '  # 内容\n🔑  ', favorite: false, providerRefs: [], createdAt: now, updatedAt: now };
async function main() {
await mkdir(root, { recursive: true });
if (process.argv.includes('--verify')) {
  const report = [];
  for (const name of ['android-return.zip', 'android-return.kdbx', 'android-kdbx-return.kdbx']) {
    const result = await previewImport({ name, bytes: new Uint8Array(await readFile(path.join(root, name))), password: 'synthetic-file-password' });
    const account = result.items.find(item => item.kind === 'login');
    assert.ok(account?.kind === 'login');
    assert.equal(account.username, login.username); assert.equal(account.password, login.password);
    const importedNote = result.items.find(item => item.kind === 'secure-note');
    if (importedNote?.kind !== 'secure-note') throw new Error('Android output is missing the note');
    assert.equal(importedNote.content, note.content);
    const otp = result.items.find(item => item.kind === 'totp'); assert.ok(otp?.kind === 'totp');
    assert.equal(otp.secret, totp.secret); assert.equal(otp.algorithm, totp.algorithm); assert.equal(otp.digits, 8); assert.equal(otp.period, 60);
    assert.equal(result.items.length, 3);
    report.push({ file: name, count: result.items.length, passwordsAndNotesExact: true, otpParametersExact: true });
  }
  await writeFile(path.join(root, 'extension-readback.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} else {
  for (const [format, name, items] of [
    ['zip', 'extension.zip', [login, note, totp]], ['kdbx', 'extension.kdbx', [login, note, totp]], ['csv', 'extension.csv', [login]],
    ['aegis', 'extension-aegis.json', [totp]], ['stratum', 'extension-stratum.json', [totp]], ['otp', 'extension-otp.txt', [totp]]
  ] as const) {
    const output = await createTransferExport([...items], format, 'synthetic-file-password');
    await writeFile(path.join(root, name), output.bytes);
  }
  const steam = await previewImport({ name: 'synthetic.maFile', bytes: new TextEncoder().encode(JSON.stringify({ account_name: 'synthetic-steam', shared_secret: 'SGVsbG8h3q2+7w==', serial_number: '1234567890', identity_secret: 'synthetic-identity', steamid: '76561198000000000' })) });
  await writeFile(path.join(root, 'extension.maFile'), (await createTransferExport(steam.items, 'steam')).bytes);
  console.log('Synthetic fixtures ready: ZIP, KDBX, CSV, Aegis, Stratum, OTP URI, Steam maFile.');
}
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
