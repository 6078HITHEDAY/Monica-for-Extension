import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
const root = new URL('../', import.meta.url);
const base = JSON.parse(await readFile(new URL('docs/design/editor-content-318.m3e.json', root), 'utf8'));
const doc = { ...base, title: 'Monica · Passkey 使用状态', frames: [], groups: [],
  brief: '沿用 Monica 青绿 M3E 主题与系统字体。列表在来源旁放文字状态：浏览器不可用、仅原设备、跨端受限。可导出的本地库凭据不标为仅本地可用。详情用连续圆角列表说明浏览器登录、跨端保存与限制原因，先显示能力再显示技术字段；不展示私钥。12px页边距，24px外圆角，4px相邻圆角，状态同时使用文字和图标。'};
function frame(id, title, rows) {
  const x = doc.frames.length * 430;
  doc.frames.push({id,name:title,x,y:0,w:390,h:830});
  doc.groups.push({id:`${id}-header`,frameId:id,x:x+12,y:12,axis:'y',gap:4,items:[{id:`${id}-bar`,kind:'topAppBar',label:title,icon:'arrow_back',size:366,radius:24,variant:'filled'}]});
  doc.groups.push({id:`${id}-content`,frameId:id,x:x+12,y:110,axis:'y',gap:4,items:rows.map((row,i)=>({id:`${id}-${i}-control`,size:366,radius:24,variant:'filled',...row}))});
}
const row = (label,supporting,icon='info') => ({kind:'listItem',label,supporting,icon});
frame('passkeystatus318','Passkey',[
  {kind:'searchBar',label:'搜索 Passkey',icon:'search'},
  row('GitHub · 可跨端保存','Bitwarden · user@example.test','key'),
  row('Android 设备密钥 · 浏览器不可用','仅原设备 · 未包含可导出的私钥','smartphone'),
  row('历史凭据 · 跨端受限','KeePass · 有非零计数历史','info'),
  row('本地 Passkey · 可跨端保存','Monica 本地库 · 尚未连接同步','key')]);
frame('passkeydetail318','历史凭据',[
  row('使用状态 · 跨端受限','密钥可以用于浏览器签名','info'),
  row('浏览器登录','可用；网站仍会校验凭据与账户','check'),
  row('跨端保存 · 计数受限','Android 使用零计数，部分网站可能拒绝登录','sync'),
  row('密码源','KeePass · KDBX / WebDAV','database'),
  row('更多信息','算法、凭据 ID 与原始标志','chevron_right'),
  {kind:'button',label:'关闭',icon:'close'}]);
await writeFile(new URL('docs/design/passkey-status-318.m3e.json',root),JSON.stringify(doc,null,2)+'\n');
await writeFile(new URL('docs/design/passkey-status-318.md',root),`# Passkey 使用状态\n\n${doc.brief}\n\n[本地可编辑草图](http://127.0.0.1:5186/#docz=${deflateRawSync(JSON.stringify(doc)).toString('base64url')})\n`);
