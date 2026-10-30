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
doc.brief += ' 320–420px传输弹窗减少叠加留白：正文8px、分组12px、条目8px，保留复选框触控面积和图标，让项目名称与来源有足够行宽。';
const select=(label,value)=>({kind:'select',label,tabs:[{label:value,icon:null}],selected:0});
doc.brief = doc.brief.replace('当前执行目标为MDBX，其他后端仍在接入。','传输目标统一选择本地库或已解锁MDBX，其他后端仍在接入。本地保存与MDBX使用相同连续分组布局；单选文件夹、复制/移动和预览位置保持一致。附件沿用现有管理弹窗，显示文件名、大小与下载/替换/删除。');
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
frame('localsource318','密码源 · 本地库',[
 row('Monica 本地库','已连接 · 加密保存','database'),
 {kind:'button',label:'批量传输',icon:'drive_file_move'},
 {kind:'button',label:'导出脱敏诊断',icon:'download',variant:'text'},
 row('传输预览','选择项目、目标库与文件夹','fact_check')]);
frame('localtransfer318','复制或移动项目',[
 select('目标密码库','Monica 本地库'),row('复制','保留来源项目','content_copy'),row('根目录','未分类项目','folder_off'),
 row('游戏','已选择 · 本地文件夹','check'),row('保留原分类层级','包含关联项目与附件','folder_copy'),
 row('Steam · 2 个项目','关联笔记与验证码自动包含','link'),
 {kind:'button',label:'检查并生成计划',icon:'rule'}]);
frame('localfiles318','附件',[
 row('Monica 本地库','附件随本地密码库加密保存','database'),
 row('steam.maFile','197 B · 可下载','description'),{kind:'button',label:'下载',icon:'download'},
 {kind:'button',label:'替换文件',icon:'upload_file'}, {kind:'button',label:'删除附件',icon:'delete'},
 {kind:'button',label:'上传文件',icon:'add'}, {kind:'button',label:'完成',icon:'check'}]);
await writeFile(new URL('docs/design/folder-transfer-318.m3e.json',root),JSON.stringify(doc,null,2)+'\n');
await writeFile(new URL('docs/design/folder-transfer-318.md',root),`# 文件夹筛选与传输\n\n${doc.brief}\n\n[本地可编辑草图](http://127.0.0.1:5186/#docz=${deflateRawSync(JSON.stringify(doc)).toString('base64url')})\n`);
