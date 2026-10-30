import { mkdir, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
const dir = new URL('../docs/design/import-export/', import.meta.url);
await mkdir(dir, { recursive: true });
const groups = [];
function part(id, x, y, kind, label, extra = {}) { groups.push({ id: `g-${id}`, x, y, axis: 'x', items: [{ id, kind, label, icon: null, variant: 'filled', ...extra }] }); }
const frames = [{ id: 'transfer', name: '导入与导出', x: 0, y: 0 }, { id: 'preview', name: '导入预览', x: 492, y: 0 }, { id: 'export', name: '导出文件', x: 984, y: 0 }];
for (const f of frames) part(`${f.id}-bar`, f.x, 0, 'topAppBar', f.name, { icon: 'arrow_back' });
part('intro', 16, 106, 'text', '在设备与应用之间迁移项目', { size: 18 });
groups.push({ id: 'import-rows', x: 16, y: 150, axis: 'y', items: [
  ['archive', 'Monica ZIP', 'Android 备份，支持独立备份密码'], ['key', 'KeePass KDBX', '数据库密码与可选密钥文件'], ['description', 'JSON / CSV', 'Monica、Bitwarden、Chrome、Proton Pass'], ['security', '验证器', 'Aegis、Stratum、OTP URI、Steam maFile']
].map(([icon, label, supporting], i) => ({ id: `source-${i}`, kind: 'listItem', icon, label, supporting, variant: 'filled', action: { to: 'preview', transition: 'slide' } })) });
part('choose', 16, 462, 'button', '选择导入文件', { icon: 'upload', size: 380, action: { to: 'preview', transition: 'slide' } });
part('export-row', 16, 550, 'listItem', '导出文件', { supporting: '选择格式，验证身份后保存', icon: 'download', action: { to: 'export', transition: 'slide' } });
part('backup-row', 16, 632, 'listItem', '加密整库备份', { supporting: '含附件和连接配置，可完整恢复插件', icon: 'encrypted' });
part('file', 508, 112, 'listItem', 'monica-backup.zip', { icon: 'description', supporting: '已选择文件 · 读取后预览' });
part('source-format', 508, 202, 'select', '导入格式', { tabs: [{ label: '自动识别' }, { label: 'Monica ZIP' }, { label: 'KeePass KDBX' }, { label: 'CSV' }] });
part('source-password', 508, 282, 'textField', '文件密码（如有）', { icon: 'lock', variant: 'outlined' });
part('read', 508, 364, 'button', '读取并预览', { size: 380 });
groups.push({ id: 'preview-rows', x: 508, y: 454, axis: 'y', items: [{ id: 'preview-count', kind: 'listItem', label: '12 个项目', supporting: '登录项 8 · 验证器 3 · 笔记 1', icon: 'check_circle', variant: 'filled' }, { id: 'destination', kind: 'listItem', label: '导入到 Monica 本地库', supporting: '新增独立副本，保留已有项目', icon: 'database', variant: 'filled' }] });
part('confirm', 508, 646, 'button', '导入 12 个项目', { size: 380, icon: 'upload' });
part('export-format', 1000, 122, 'select', '导出格式', { tabs: ['Monica ZIP', 'KeePass KDBX', 'Monica JSON', '密码 CSV', 'Aegis JSON', 'Stratum JSON', 'OTP URI', 'Steam maFile'].map(label => ({ label })), selected: 0 });
part('scope', 1000, 208, 'listItem', '当前密码库中的项目', { supporting: '不含回收站、附件文件与连接配置', icon: 'inventory_2' });
part('backup-password', 1000, 310, 'textField', '文件密码', { icon: 'lock', variant: 'outlined' });
part('warning', 1000, 396, 'text', '明文文件包含密码，请妥善保管。', { size: 14 });
part('verify', 1000, 468, 'button', '验证身份并导出', { size: 380, icon: 'fingerprint' });
const doc = { title: 'Monica · 导入与导出', brief: '沿用现有设置页的分组圆角和间距。导入先预览，导出按格式显示范围并重新验证。', frame: 'phone', platform: 'web', paletteKey: 'purple', frames, groups };
const json = JSON.stringify(doc, null, 2);
const url = 'http://127.0.0.1:5186/?project=extension-import-export#docz=' + deflateRawSync(json).toString('base64url');
await writeFile(new URL('canvas.json', dir), json);
await writeFile(new URL('canvas-url.txt', dir), url);
console.log('Saved docs/design/import-export/canvas.json and canvas-url.txt');
