import { readFile, writeFile, readdir } from 'node:fs/promises';
const english = {
  '导入与导出': 'Import and export',
  '加密备份与恢复': 'Encrypted backup and restore',
  'Android 备份、KeePass、JSON、CSV 与验证器': 'Android backups, KeePass, JSON, CSV and authenticators',
  '导入文件': 'Import a file',
  '先读取预览，再导入到 Monica 本地库。已有项目保持不变。': 'Preview the file, then import independent copies into your local Monica vault.',
  '支持文件密码；KDBX 可使用密钥文件': 'File passwords supported; KDBX also supports key files',
  'Monica、Bitwarden、KeePass、Chrome、Proton Pass': 'Monica, Bitwarden, KeePass, Chrome and Proton Pass',
  '加密或明文验证器备份、OTP URI、明文 maFile': 'Encrypted or plaintext authenticator backups, OTP URIs and plaintext maFiles',
  '选择导入文件': 'Choose a file to import', '导入格式': 'Import format', '自动识别': 'Detect automatically',
  '文件密码（如有）': 'File password (if any)', '选择密钥文件（可选）': 'Choose a key file (optional)',
  '读取并预览': 'Read and preview', '可导入 {0} 个项目': '{0} items ready to import',
  '导入到 Monica 本地库，新增独立副本。': 'Import independent copies into the local Monica vault.',
  '跳过 {0} 个不支持、已归档或已删除的项目。': 'Skipped {0} unsupported, archived or deleted items.',
  '导入 {0} 个项目': 'Import {0} items', '导出文件': 'Export a file',
  '选择适合接收应用的格式。每次导出都需要验证身份。': 'Choose a format for the receiving app. Authenticate for each export.',
  '导出格式': 'Export format', '密码 CSV': 'Password CSV',
  'Android 项目备份，可设置文件密码。': 'Android item backup with an optional file password.',
  '加密数据库，需要设置文件密码。': 'Encrypted database requiring a file password.',
  '全部项目，保留插件字段。': 'All items, including extension fields.',
  '仅登录项：标题、网址、账号、密码、备注、OTP 与分类。': 'Logins only: title, URLs, account, password, notes, OTP and category.',
  '仅 TOTP / HOTP 验证器，明文文件。': 'TOTP and HOTP authenticators only, in a plaintext file.',
  '验证器 URI 列表，包含密钥与 OTP 参数。': 'Authenticator URI list including secrets and OTP parameters.',
  '仅 Steam 账户；多个账户打包为 ZIP。': 'Steam accounts only; multiple accounts are packaged as a ZIP.',
  '此格式将导出 {0} / {1} 个项目。': 'This format exports {0} of {1} items.',
  '不含回收站、附件文件与连接配置。': 'Excludes trash, attachment files and connection settings.',
  '文件密码（留空导出明文 ZIP）': 'File password (leave empty for plaintext ZIP)',
  'KDBX 文件密码': 'KDBX file password', '确认文件密码': 'Confirm file password',
  'CSV 保留原始字段值，请勿在电子表格中执行公式。': 'CSV preserves original field values. Do not execute formulas in a spreadsheet.',
  '验证身份并导出': 'Authenticate and export',
  '已导出 {0} 个项目，请妥善保管文件。': 'Exported {0} items. Store the file securely.',
  '完整备份插件，包括附件文件与连接配置。': 'Back up the extension, including attachment files and connection settings.',
  '文件为空或超过 64 MB。': 'The file is empty or exceeds 64 MB.',
  '密钥文件超过 1 MB。': 'The key file exceeds 1 MB.',
  '读取失败，请检查文件格式和密码。': 'Could not read the file. Check its format and password.',
  '导入失败，当前密码库未完成写入，请重新解锁后重试。': 'Import failed. Unlock the vault again and retry.',
  '两次输入的文件密码不一致。': 'The file passwords do not match.',
  '请设置 KDBX 文件密码。': 'Set a KDBX file password.',
  '请输入文件密码。': 'Enter the file password.',
  '此导入仅迁移项目，ZIP 中的附件与图片文件不会导入。': 'Imports items only. Attachment and image files in the ZIP are excluded.',
  '此导入仅迁移项目，KDBX 中的附件文件不会导入。': 'Imports items only. Attachment files in the KDBX are excluded.',
  'Steam ZIP 中的其他文件已跳过。': 'Other files in the Steam ZIP were skipped.',
  '这是插件加密整库备份，请在“加密备份与恢复”中恢复。': 'Restore this encrypted extension backup in Backup and restore.',
  '请先从 Bitwarden 导出未加密 JSON。': 'Export unencrypted JSON from Bitwarden first.',
  '文件中没有可导入的项目，请检查文件格式。': 'No importable items were found. Check the file format.',
  '项目数量超过安全上限。': 'The item count exceeds the safety limit.',
  '部分项目以只读原始记录保留，当前版本无法编辑。': 'Some items are preserved as read-only records that this version cannot edit.',
  '当前没有可按此格式导出的项目。': 'No items can be exported in this format.',
  '验证器参数无效。': 'Invalid authenticator parameters.',
  'Aegis 密码槽无效或过多。': 'Invalid or excessive Aegis password slots.',
  'Aegis 密钥派生参数超出安全范围。': 'Aegis key derivation parameters exceed the safety limits.',
  '文件密码不正确或文件已损坏。': 'Incorrect file password or damaged file.',
  'Stratum 文件不完整。': 'The Stratum file is incomplete.',
  '验证器文件格式无效。': 'Invalid authenticator file format.',
  '加密文件参数无效。': 'Invalid encrypted file parameters.',
  '无法识别 CSV 列名。': 'Could not recognize the CSV column names.',
  'CSV 引号未闭合，未导入任何项目。': 'CSV contains an unclosed quote. No items were imported.'
};
const enPath = new URL('../src/i18n/ui-en.json', import.meta.url);
const catalog = JSON.parse(await readFile(enPath, 'utf8'));
Object.assign(catalog, english);
await writeFile(enPath, JSON.stringify(catalog, null, 2) + '\n');
// Keep every offline catalog complete; new strings use the established English fallback.
const directory = new URL('../public/locales/', import.meta.url);
for (const name of await readdir(directory)) {
  if (!/^ui-.*\.json$/.test(name)) continue;
  const file = new URL(name, directory), local = JSON.parse(await readFile(file, 'utf8'));
  for (const [key, value] of Object.entries(english)) if (!Object.hasOwn(local, key)) local[key] = value;
  await writeFile(file, JSON.stringify(local, null, 2) + '\n');
}
