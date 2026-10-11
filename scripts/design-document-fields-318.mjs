import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
const root = new URL('../', import.meta.url);
const source = JSON.parse(await readFile(new URL('docs/design/rounded-controls-318.m3e.json', root), 'utf8'));
const id = 'document-fields318';
const doc = { ...source, title: 'Monica · 完整证件详情',
  brief: '称谓和用户名纳入更多信息。地址独立成组，保留三行地址、城市、省州、邮编和国家；不同的地址收件人和联系方式单独显示。秘密默认隐藏，每行保留复制操作。沿用圆润的连续列表。',
  frames: [{ id, name: '证件详情', x: 0, y: 0, w: 390, h: 1160 }], groups: [] };
doc.groups.push({ id: 'document-title', frameId: id, x: 12, y: 16, axis: 'y', items: [{ id: 'document-title-control', kind: 'topAppBar', label: 'Synthetic 证件', icon: 'close', variant: 'filled', size: 366 }] });
const group = (key, y, rows) => doc.groups.push({ id: key, frameId: id, x: 12, y, axis: 'y', items: rows.map(([label, supporting], index) => ({
  id: `${key}-${index}`, kind: 'listItem', label, supporting, icon: null, icon2: 'content_copy', variant: 'filled', size: 366
})) });
group('document-main', 110, [['证件号码', '•••••• 0042'], ['人物称谓', 'Dr.'], ['用户名', 'synthetic-account']]);
group('document-address', 355, [['街道地址', '42 Example Lane'], ['公寓/单元', 'Suite 42'], ['地址第三行', 'West entrance'],
  ['城市', 'Example City'], ['省/州', 'Example Province'], ['邮编', '42000'], ['国家/地区', 'Example Country'], ['地址 · 姓名', 'Different addressee']]);
doc.groups.push({ id: 'document-edit', frameId: id, x: 12, y: 1050, axis: 'y', items: [{ id: 'document-edit-control', kind: 'button', label: '编辑', icon: 'edit', size: 366, variant: 'filled' }] });
await writeFile(new URL('docs/design/document-fields-318.m3e.json', root), JSON.stringify(doc, null, 2) + '\n');
const link = 'http://127.0.0.1:5186/#docz=' + deflateRawSync(JSON.stringify(doc)).toString('base64url');
await writeFile(new URL('docs/design/document-fields-318.md', root), `# Document fields\n\n${doc.brief}\n\n[本地可编辑草图](${link})\n`);
