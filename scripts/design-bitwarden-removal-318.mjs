import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
const root = new URL('../', import.meta.url);
const base = JSON.parse(await readFile(new URL('docs/design/keepass-removal-317.m3e.json', root), 'utf8'));
const doc = { ...base, title: 'Monica · Bitwarden 密码移除与 Passkey 保留',
  brief: '沿用 Monica 青绿色与系统字体。左右12px；信息行连续分组，外侧24px相邻4px圆角、4px间距。核对并继续、重新登录和取消各自只做一种操作。Passkey进度只显示数量，不显示凭据或内部标识。取消后明确说明可能保留独立副本。',
  frames: [], groups: [] };
const scenes = [
  ['bwremoveconfirm318', '确认移除密码', [
    ['listItem', '工作账号 · 密码 1', '移入回收站', 'key'],
    ['listItem', '保留 2 个密码', '备注、共享内容与附件会保留', 'inventory_2'],
    ['listItem', '保留 Passkey', '先保存独立副本，再移除原密码', 'key'],
    ['button', '确认移除并保存', '', 'check']]],
  ['bwremovepending318', '未完成的密码移除', [
    ['listItem', '工作账号', 'Bitwarden · 移除 1 个密码', 'key'],
    ['listItem', '正在保留 Passkey', '已核对 1 / 2 个独立副本', 'pending_actions'],
    ['button', '核对并继续', '', 'restore'],
    ['button', '取消这次移除', '', 'undo']]],
  ['bwremovelocked318', '未完成的密码移除', [
    ['listItem', '工作账号', 'Bitwarden · 移除 1 个密码', 'key'],
    ['listItem', '需要重新登录', '登录原 Bitwarden 账号后继续', 'lock'],
    ['button', '重新登录', '', 'lock_open']]],
  ['bwremovecancel318', '已取消这次移除', [
    ['listItem', '其他编辑已保留', '原密码仍然保留', 'undo'],
    ['listItem', '独立 Passkey 副本会保留', '同步后检查已创建或结果未确认的副本', 'key'],
    ['button', '刷新', '', 'refresh']]],
  ['bwremovelocal318', '核对本地编辑', [
    ['listItem', '移除已撤销', '原密码和 Passkey 均已保留', 'undo'],
    ['listItem', '两份内容均已保留', '移除期间本地有修改，请核对后选择', 'compare_arrows'],
    ['button', '保留浏览器版本', '', 'check'],
    ['button', '采用 Bitwarden 版本', '', 'cloud_sync']]],
  ['bwremovepreparation318', '正在核对取消准备', [
    ['listItem', '原密码尚未移除', '本地编辑与恢复记录均已保留', 'undo'],
    ['listItem', '核对已尝试创建的副本', '确认结果后再选择本地或远端内容', 'key'],
    ['button', '继续', '', 'sync']]]
];
scenes.forEach(([id, name, rows], index) => {
  const x = index * 430;
  doc.frames.push({ id, name, x, y: 0, w: 390, h: 660 });
  doc.groups.push({ id: `${id}-header`, frameId: id, x: x + 12, y: 16, axis: 'y', items: [
    { id: `${id}-title`, kind: 'topAppBar', label: name, icon: 'arrow_back', size: 366, variant: 'filled' }] });
  const list = rows.filter(row => row[0] === 'listItem');
  doc.groups.push({ id: `${id}-rows`, frameId: id, x: x + 12, y: 112, axis: 'y', gap: 4,
    items: list.map(([kind, label, supporting, icon], i) => ({ id: `${id}-row-${i}`, kind, label, supporting, icon, size: 366, variant: 'filled', radius: 24 })) });
  rows.filter(row => row[0] === 'button').forEach(([kind, label, , icon], i) => doc.groups.push({
    id: `${id}-action-${i}`, frameId: id, x: x + 12, y: 160 + list.length * 88 + i * 72, axis: 'y',
    items: [{ id: `${id}-button-${i}`, kind, label, icon, size: 366, variant: i ? 'text' : 'filled' }] }));
});
await writeFile(new URL('docs/design/bitwarden-removal-318.m3e.json', root), JSON.stringify(doc, null, 2) + '\n');
const link = 'http://127.0.0.1:5186/#docz=' + deflateRawSync(JSON.stringify(doc)).toString('base64url');
await writeFile(new URL('docs/design/bitwarden-removal-318.md', root), `# Bitwarden removal\n\n${doc.brief}\n\n[本地可编辑草图](${link})\n`);
