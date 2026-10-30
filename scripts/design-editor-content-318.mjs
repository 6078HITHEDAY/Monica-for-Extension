import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
const root = new URL('../', import.meta.url);
const base = JSON.parse(await readFile(new URL('docs/design/settings-pages-318.m3e.json', root), 'utf8'));
const doc = { ...base, title: 'Monica · 新建页补充内容', frames: [], groups: [],
  brief: '参考 Android EntryContentPanel：主编辑页只显示一致的图标、名称、状态摘要与右箭头，点击进入独立编辑层，返回恢复入口焦点与草稿。沿用 Monica 青绿色、系统字体和既有主题；24px 圆角，8px 间距，16px 内边距。添加内容与排列内容使用同样入口，不混入常驻表单或折叠。备注与笔记关联合并，收藏与归档放入更多选项。密钥摘要不显示秘密。'};
function frame(id, title, rows) {
  const x = doc.frames.length * 430;
  doc.frames.push({ id, name: title, x, y: 0, w: 390, h: Math.max(800, rows.length * 88 + 120) });
  [{kind:'topAppBar', label:title, icon:'arrow_back'}, ...rows].forEach((row, i) => doc.groups.push({
    id:`${id}-${i}`, frameId:id, x:x+12, y:12+i*88, axis:'y', gap:8,
    items:[{id:`${id}-${i}-control`, size:366, radius:24, variant:'filled', icon:null, ...row}]
  }));
}
const entry = (label, supporting, icon) => ({kind:'listItem',label,supporting,icon,icon2:'chevron_right'});
frame('editorcontent318', '补充信息', [
  entry('银行卡与支付','可选','credit_card'), entry('个人信息','可选','person'), entry('地址','可选','location_on'),
  entry('两步验证','可选','verified_user'), entry('登录方式','密码登录','login'), entry('自定义字段','可选','edit_note'),
  entry('笔记与恢复备注','可选','note'), entry('更多选项','收藏、归档与自动填充','tune'),
  entry('添加内容','API Key、SSH 密钥与完整副本','add'), entry('内容顺序','排列项目中的补充内容','swap_vert')]);
frame('editorpayment318', '银行卡与支付', [
  {kind:'textField',label:'卡号'}, {kind:'textField',label:'持卡人'}, {kind:'textField',label:'有效期'},
  {kind:'textField',label:'安全码'}, {kind:'button',label:'完成',icon:'check'}]);
frame('editoradd318', '添加内容', [
  entry('API Key','添加内容','key'), entry('API Token','添加内容','token'), entry('SSH 密钥','添加内容','terminal'),
  entry('GPG 密钥','添加内容','key'), entry('二维码','添加内容','qr_code_2'),
  entry('银行卡副本','独立保存','credit_card'), entry('证件副本','独立保存','badge'),
  entry('地址副本','独立保存','location_on'), entry('完整笔记副本','独立保存','note')]);
await writeFile(new URL('docs/design/editor-content-318.m3e.json', root), JSON.stringify(doc,null,2)+'\n');
await writeFile(new URL('docs/design/editor-content-318.md', root), `# 新建页补充内容\n\n${doc.brief}\n\n[本地可编辑草图](http://127.0.0.1:5186/#docz=${deflateRawSync(JSON.stringify(doc)).toString('base64url')})\n`);
