import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
const root = new URL('../', import.meta.url);
const source = JSON.parse(await readFile(new URL('docs/design/wallet-order-318.m3e.json', root), 'utf8'));
const doc = { ...source, title: 'Monica · 圆润控件与搜索聚焦',
  brief: '数据库选择和表单使用四角24px填充容器，取消底部横线。只有聚焦或校验错误时显示完整圆角轮廓。搜索保持胶囊形，内部输入不画框。Canvas的outlined控件用于示意轮廓几何；产品保留填充色和内部浮动标签。',
  theme: { ...source.theme, dark: true, shape: 'full' }, frames: [], groups: [] };
for (const [index, name] of ['数据库与搜索', '新建项目'].entries()) {
  const x = index * 430, id = `rounded318-${index}`;
  doc.frames.push({ id, name, x, y: 0, w: 390, h: 680 });
  const items = index === 0 ? [
    ['topAppBar', '密码库'], ['searchBar', '搜索当前分类', 'search'], ['select', '数据库'],
    ['listItem', 'GitHub', 'key'], ['listItem', '工作邮箱', 'lock']
  ] : [['topAppBar', '新建项目'], ['textField', '名称'], ['select', '类型'], ['select', '保存到'], ['button', '加密保存', 'check']];
  items.forEach(([kind, label, icon], i) => doc.groups.push({ id: `${id}-${i}`, frameId: id, x: x + 12, y: 20 + i * 112, axis: 'y', items: [{
    id: `${id}-${i}-control`, kind, label, icon: icon || null, size: 366,
    variant: ['textField', 'select'].includes(kind) ? 'outlined' : 'filled',
    ...(kind === 'select' ? { tabs: [{label: index === 0 ? '全部数据库' : i === 2 ? '银行卡' : '本地', icon: ''}], selected: 0 } : {})
  }] }));
}
await writeFile(new URL('docs/design/rounded-controls-318.m3e.json', root), JSON.stringify(doc, null, 2) + '\n');
const link = 'http://127.0.0.1:5186/#docz=' + deflateRawSync(JSON.stringify(doc)).toString('base64url');
await writeFile(new URL('docs/design/rounded-controls-318.md', root), `# Rounded controls\n\n${doc.brief}\n\n[本地可编辑草图](${link})\n`);
