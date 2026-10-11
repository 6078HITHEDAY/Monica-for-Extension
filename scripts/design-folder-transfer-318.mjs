import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
const root = new URL('../', import.meta.url);
const base = JSON.parse(await readFile(new URL('docs/design/passkey-status-318.m3e.json', root), 'utf8'));
const doc = {...base,title:'Monica · 数据库与文件夹',frames:[],groups:[],brief:'沿用青绿 M3E 和系统字体。数据库与文件夹连续列表，12px边距、24px外圆角、4px相邻圆角；完整路径与选中状态可见。Passkey/Steam页面的传输入口继承当前搜索与数据库/文件夹范围（包含分页外匹配项），后台预览再展开必要关联项目。复制保留源记录，受限项列出原因并允许取消或跳过。当前执行目标为MDBX，其他后端仍在接入。保留分类时按来源数据库分别解析文件夹，不能跨库混用同名/同ID目录。'};
function frame(id,title,rows){const x=doc.frames.length*430;doc.frames.push({id,name:title,x,y:0,w:390,h:850});
doc.groups.push({id:id+'header',frameId:id,x:x+12,y:12,axis:'y',gap:4,items:[{id:id+'bar',kind:'topAppBar',label:title,icon:'arrow_back',size:366,radius:24,variant:'filled'}]});
doc.groups.push({id:id+'rows',frameId:id,x:x+12,y:100,axis:'y',gap:4,items:rows.map((row,i)=>({id:id+i,size:366,icon:null,radius:i===0||i===rows.length-1?24:4,variant:'filled',...row}))});}
const row=(label,supporting,icon='folder')=>({kind:'listItem',label,supporting,icon});
doc.brief += ' 复制/移动选项在窄屏或大字号下排列为两条完整行，图标与标题同排、说明自然换行，避免两列挤压。';
const select=(label,value)=>({kind:'select',label,tabs:[{label:value,icon:null}],selected:0});
frame('transferentry318','Passkey',[
 {kind:'searchBar',label:'搜索当前分类',icon:'search'},select('数据库','工作密码库'),
 row('工作 / 登录','当前文件夹','folder'),{kind:'button',label:'批量传输',icon:'drive_file_move'},
 row('GitHub','可跨端使用','key'),row('设备密钥','仅原设备可用','key'),
 {kind:'button',label:'下一页',icon:'chevron_right'}]);
frame('folderfilter318','Steam · 筛选',[
 select('数据库','游戏密码库'),row('全部文件夹','包含根目录与子文件夹','list'),
 row('根目录','未放入文件夹','folder_off'),row('游戏 / Steam','已选择 · 2 个项目','check'),row('游戏 / 其他','1 个项目'),
 {kind:'button',label:'完成',icon:'check'}]);
frame('foldertransfer318','Passkey · 复制',[
 select('目标数据库','家庭 MDBX'),row('家庭 / 登录','目标文件夹','folder'),
 row('GitHub','可复制 · 保留源记录','key'),row('设备密钥','不能导出私钥 · 将跳过','warning'),
 {kind:'button',label:'取消',icon:'close'},{kind:'button',label:'跳过受限项并继续',icon:'content_copy'}]);
await writeFile(new URL('docs/design/folder-transfer-318.m3e.json',root),JSON.stringify(doc,null,2)+'\n');
await writeFile(new URL('docs/design/folder-transfer-318.md',root),`# 文件夹筛选与传输\n\n${doc.brief}\n\n[本地可编辑草图](http://127.0.0.1:5186/#docz=${deflateRawSync(JSON.stringify(doc)).toString('base64url')})\n`);
