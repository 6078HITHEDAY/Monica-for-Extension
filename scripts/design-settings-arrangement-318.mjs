import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
const base = JSON.parse(await readFile('docs/design/settings-pages-318.m3e.json', 'utf8'));
const doc = {...base, title: 'Monica · 直接设置与分组', frames: [], groups: [],
  brief: '通用、同步与填充、密码库与安全三组连续M3E行；24px外圆角、4px相邻圆角、4px间隔、横向16px纵向8px内边距；普通字号主要行约72px，组间20px，语言与模式不预留空提示行。语言和显示模式直接选择，同步和自动填充直接开关；仅配色、排除项、解锁与保护、备份与迁移进入二级页。Hello与保护方式合并，备份与迁移合并，安全说明回到对应功能附近。沿用Monica青绿与系统字体，桌面/窄屏保持单列信息顺序。'};
const text = label => ({kind: 'text', label, variant: 'filled', icon: null, radius: 0, textStyle: 'titleSmall', fill: 'surface'});
const row = (label, supporting, icon, extra={}) => ({kind:'listItem',label,supporting,icon,...extra});
const select = (label, values, selected=0) => ({kind:'select',label,tabs:values.map(label=>({label,icon:null})),selected});
function frame(id, title, sections) {
  const x=doc.frames.length*430; let y=12;
  const groups=[{title:null,rows:[{kind:'topAppBar',label:title,icon:id==='settingsdirect318'?'settings':'arrow_back'}]},...sections];
  for (const [i, group] of groups.entries()) {
    if (group.title) {doc.groups.push({id:`${id}-heading-${i}`,frameId:id,x:x+16,y,axis:'y',gap:4,items:[{id:`${id}-label-${i}`,size:14,...text(group.title)}]});y+=44;}
    doc.groups.push({id:`${id}-group-${i}`,frameId:id,x:x+12,y,axis:'y',gap:4,items:group.rows.map((item,j)=>({id:`${id}-${i}-${j}`,size:366,radius:4,corners:{tl:j===0?24:4,tr:j===0?24:4,bl:j===group.rows.length-1?24:4,br:j===group.rows.length-1?24:4},variant:'filled',icon:null,...item}))});
    y+=group.rows.reduce((height,item)=>height+(item.kind==='topAppBar'?64:item.kind==='textField'?64:item.kind==='select'?56:72)+4,0)+24;
  }
  doc.frames.push({id,name:title,x,y:0,w:390,h:y+12});
}
frame('settingsdirect318','设置与备份',[
 {title:'通用',rows:[select('界面语言',['跟随浏览器','简体中文','English']),select('显示模式',['跟随系统','浅色','深色']),row('配色','Monica','palette',{icon2:'chevron_right'})]},
 {title:'同步与填充',rows:[row('自动同步','锁定后暂停，可随时手动同步','sync',{switch:true,checked:true}),row('表单旁自动填充','关闭后仍可从工具栏填写','edit',{switch:true,checked:true}),row('自动填充排除项','自动填充 0 个 · 保存提示 0 个','domain_disabled',{icon2:'chevron_right'})]},
 {title:'密码库与安全',rows:[row('解锁与保护','主密码 · Windows Hello 未注册','key_vertical',{icon2:'chevron_right'}),row('备份与迁移','加密备份、恢复与 JSON / CSV 迁移','encrypted',{icon2:'chevron_right'})]}
]);
frame('settingssecurity318','解锁与保护',[
 {title:'更改保护方式',rows:[{kind:'textField',label:'当前主密码'},{kind:'textField',label:'新主密码（可选）'},{kind:'textField',label:'确认新主密码'},{kind:'button',label:'更改主密码',icon:'check'}]},
 {title:'Windows Hello',rows:[row('设备不可用','当前密码库未注册','fingerprint'),{kind:'button',label:'刷新状态',icon:'refresh'}]},
 {title:'安全说明',rows:[row('推荐使用长而独立的主密码','设备密钥依赖浏览器与系统保护','security')]}
]);
frame('settingsdata318','备份与迁移',[
 {title:'加密整库备份',rows:[{kind:'button',label:'导出加密整库备份',icon:'encrypted'},{kind:'button',label:'选择加密整库备份',icon:'upload'}]},
 {title:'明文手动迁移',rows:[row('明文文件包含密码等敏感信息','仅保存到可信位置，迁移完成后妥善处理','warning'),{kind:'button',label:'导出 JSON',icon:'download'},{kind:'button',label:'导入明文 JSON / CSV',icon:'upload'}]}
]);
await writeFile('docs/design/settings-arrangement-318.m3e.json',JSON.stringify(doc,null,2)+'\n');
await writeFile('docs/design/settings-arrangement-318.md',`# 设置分组与直接操作\n\n${doc.brief}\n\n[本地可编辑草图](http://127.0.0.1:5186/#docz=${deflateRawSync(JSON.stringify(doc)).toString('base64url')})\n`);
