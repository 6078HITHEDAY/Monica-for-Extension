import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
const root = new URL('../', import.meta.url);
const base = JSON.parse(await readFile(new URL('docs/design/bitwarden-removal-318.m3e.json', root), 'utf8'));
const entries = [
  ['界面语言', '跟随浏览器', 'language'], ['外观', '显示模式与配色', 'palette'], ['自动同步', '接收其他设备的修改', 'sync'],
  ['表单旁自动填充', '输入框旁显示匹配的登录项', 'edit'], ['自动填充排除项', '自动填充 0 个 · 保存提示 0 个', 'domain_disabled'],
  ['Windows Hello', '设备不可用 · 主密码', 'fingerprint'], ['加密整库备份', '导出或恢复完整密码库', 'encrypted'],
  ['更改保护方式', '主密码或设备密钥', 'key_vertical'], ['明文手动迁移', '导出项目或导入 JSON / CSV', 'swap_vert'], ['安全边界', 'AES-256-GCM · 会话级解锁', 'security']
];
const doc = {...base, title: 'Monica · 统一设置入口与二级页面', theme: {...base.theme, dark: true}, frames: [], groups: [],
  brief: '设置首页的所有入口使用完全相同的列表项：48px图标容器、标题、说明、右箭头；每项独立24px四角，8px间距，16px内边距。首页不放开关、表单、折叠或弹窗。点击统一进入有返回栏的二级页；语言、外观、同步、填充、排除项、Hello、备份、保护方式、迁移、安全说明全部遵循。沿用Monica青绿色与系统字体。'};
function frame(id, name, rows, height = 800) {
  const x = doc.frames.length * 430;
  doc.frames.push({id, name, x, y: 0, w: 390, h: height});
  let y = 12;
  const controls = [{kind: 'topAppBar', label: name, icon: id === 'settingshome318' ? 'settings' : 'arrow_back'}, ...rows];
  controls.forEach((row, i) => {
    doc.groups.push({id: `${id}-${i}`, frameId: id, x: x + 12, y, axis: 'y', gap: 8, items: [
      {id: `${id}-${i}-control`, size: 366, radius: 24, variant: 'filled', icon: null, ...row}]});
    y += i ? (row.kind === 'textField' ? 92 : 88) : 94;
  });
}
frame('settingshome318', '设置与备份', entries.map(([label, supporting, icon]) => ({kind: 'listItem', label, supporting, icon, icon2: 'chevron_right'})), 1070);
frame('settingsappearance318', '外观', [
  {kind: 'radio', label: '跟随系统', checked: true}, {kind: 'radio', label: '浅色'}, {kind: 'radio', label: '深色'},
  {kind: 'listItem', label: 'Monica', supporting: '当前配色', icon: 'palette'}, {kind: 'listItem', label: 'Nothing', icon: 'palette'}]);
frame('settingsbackup318', '加密整库备份', [
  {kind: 'button', label: '导出备份', icon: 'encrypted'}, {kind: 'button', label: '选择加密整库备份', icon: 'upload'},
  {kind: 'textField', label: '备份密码'}, {kind: 'textField', label: '恢复前的当前主密码'}, {kind: 'button', label: '验证并替换当前密码库', icon: 'restore'}]);
frame('settingsprotection318', '更改保护方式', [
  {kind: 'textField', label: '当前主密码'}, {kind: 'textField', label: '新主密码（可选）'}, {kind: 'textField', label: '确认新主密码'}, {kind: 'button', label: '更改主密码', icon: 'check'}]);
frame('settingshello318', 'Windows Hello', [
  {kind: 'listItem', label: '设备不可用', supporting: '平台验证器', icon: 'fingerprint'},
  {kind: 'listItem', label: '未注册 · 主密码', supporting: '当前密码库', icon: 'key_vertical'},
  {kind: 'button', label: '刷新状态', icon: 'refresh'}]);
frame('settingsexclusions318', '自动填充排除项', [
  {kind: 'select', label: '排除类型', tabs: [{label: '禁止自动填充', icon: null}], selected: 0},
  {kind: 'textField', label: '网站域名'}, {kind: 'button', label: '添加', icon: 'add'},
  {kind: 'listItem', label: '禁止自动填充', supporting: '暂无排除项', icon: 'domain_disabled'}, {kind: 'button', label: '保存', icon: 'check'}]);
await writeFile(new URL('docs/design/settings-pages-318.m3e.json', root), JSON.stringify(doc, null, 2) + '\n');
const link = 'http://127.0.0.1:5186/#docz=' + deflateRawSync(JSON.stringify(doc)).toString('base64url');
await writeFile(new URL('docs/design/settings-pages-318.md', root), `# Unified settings\n\n${doc.brief}\n\n[本地可编辑草图](${link})\n`);
