import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
const root = new URL('../', import.meta.url);
const base = JSON.parse(await readFile(new URL('docs/design/rounded-controls-318.m3e.json', root), 'utf8'));
const doc = { ...base, title: '本地 KDBX · 项目移除与恢复', brief: '复用现有项目移除确认和密码源面板。锁定保留加密副本；重开仍需文件凭据；导出由用户保存。', frames: [], groups: [] };
const pages = [
  ['确认移除', [['topAppBar', '编辑密码'], ['listItem', '本地 KDBX', '保留 1 条密码和共享附件', 'database'],
    ['listItem', '主账号 · 密码 1', '待移除，可撤销', 'remove_circle_outline'], ['listItem', '主账号 · 密码 2', '保留，密码内容不变', 'key'],
    ['button', '撤销移除'], ['button', '确认移除并保存']]],
  ['锁定后重开', [['topAppBar', '本地 KDBX'], ['listItem', '修改已在本机加密保留', '原文件需要导出后自行保存', 'save'],
    ['button', '选择原 KDBX 文件'], ['textField', '数据库密码'], ['button', '选择密钥文件（可选）'], ['button', '解锁并恢复修改']]],
  ['继续保存', [['topAppBar', '本地 KDBX'], ['listItem', '密码项目', '1 条密码 · 共享附件已保留', 'key'],
    ['listItem', '尚未导出修改', '关闭或锁定后可重新解锁继续', 'save'], ['button', '导出 KDBX 文件'], ['button', '锁定数据库']]]
];
for (let n = 0; n < pages.length; n++) {
  const [name, rows] = pages[n], id = `localkp318-${n}`, x = n * 430;
  doc.frames.push({ id, name, x, y: 0, w: 390, h: 760 });
  let y = 16;
  rows.forEach(([kind, label, supporting, icon], index) => {
    const item = {
      id: `${id}-${index}-control`, kind, label, supporting, icon: icon || null, size: 366,
      variant: kind === 'textField' ? 'outlined' : 'filled', ...(kind === 'listItem' ? { h: 80 } : {})
    };
    if (kind === 'listItem' && rows[index - 1]?.[0] === 'listItem') doc.groups.at(-1).items.push(item);
    else doc.groups.push({ id: `${id}-${index}`, frameId: id, x: x + 12, y, axis: 'y', items: [item] });
    y += kind === 'listItem' ? 84 : 104;
  });
}
await writeFile(new URL('docs/design/local-keepass-318.m3e.json', root), JSON.stringify(doc, null, 2) + '\n');
const link = 'http://127.0.0.1:5186/#docz=' + deflateRawSync(JSON.stringify(doc)).toString('base64url');
await writeFile(new URL('docs/design/local-keepass-318.md', root), `# 本地 KDBX 项目操作\n\n${doc.brief}\n\n[本地可编辑草图](${link})\n`);
