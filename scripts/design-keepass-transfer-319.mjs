import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { chromium } from '@playwright/test';
const base = JSON.parse(await readFile('docs/design/folder-transfer-318.m3e.json', 'utf8'));
const doc = { ...base, title: 'Monica · KeePass 传输与恢复', frames: [], groups: [],
  brief: '沿用现有青绿 M3E、系统字体与紧凑连续列表。目标选择加入 KeePass，文件夹仍用原生身份；复制、同库移动、保留分类与预览沿用现有操作位置。未完成传输在目标选择下方提供恢复按钮；只有尚未写入文件的操作可取消。已写入本地文件须导出，云文件须发布成功后确认完成。' };
const list = (label, supporting, icon = 'folder') => ({ kind: 'listItem', label, supporting, icon });
function frame(id, name, rows) {
  const x = doc.frames.length * 430;
  doc.frames.push({ id, name, x, y: 0, w: 390, h: 850 });
  doc.groups.push({ id: id + 'header', frameId: id, x: x + 12, y: 12, axis: 'y', gap: 4,
    items: [{ id: id + 'bar', kind: 'topAppBar', label: name, icon: 'arrow_back', size: 366, radius: 24, variant: 'filled' }] });
  doc.groups.push({ id: id + 'body', frameId: id, x: x + 12, y: 100, axis: 'y', gap: 4,
    items: rows.map((row, i) => ({ id: id + i, size: 366, icon: null, variant: 'filled', radius: i === 0 || i === rows.length - 1 ? 24 : 4, ...row })) });
}
frame('keepasstarget319', '复制或移动项目', [
  { kind: 'searchBar', label: '筛选项目', icon: 'search' }, list('工作账号', '2 个关联密码与附件', 'check_box'),
  { kind: 'select', label: '目标密码源', tabs: [{ label: '家庭 KeePass · WebDAV', icon: null }], selected: 0 },
  list('复制', '保留来源项目', 'content_copy'), list('登录 / 工作', '目标文件夹', 'check'),
  list('保留原分类层级', '按来源文件夹身份保留', 'folder_copy'), { kind: 'button', label: '检查并生成计划', icon: 'rule' }
]);
frame('keepassresume319', '复制或移动项目', [
  { kind: 'select', label: '目标密码源', tabs: [{ label: '家庭 KeePass · WebDAV', icon: null }], selected: 0 },
  list('未完成的传输', '工作账号 · 2 个项目', 'history'), { kind: 'button', label: '恢复传输', icon: 'refresh' },
  { kind: 'button', label: '取消未写入操作', icon: 'close', variant: 'text' },
  list('文件保存后可继续恢复', '重试保留已完成的文件修改', 'info'), list('工作账号', '来源保留', 'key')
]);
frame('keepasslocaldone319', '传输结果', [
  list('家庭 KeePass · 本地文件', '在同一数据库中移动', 'folder'),
  list('工作账号', '已写入目标 · 原项目身份保留', 'check'),
  list('完成后请导出并保存 KDBX', '修改已保存在本机加密副本中', 'info'),
  { kind: 'button', label: '关闭', icon: 'close' }
]);
const file = 'docs/design/keepass-transfer-319.m3e.json';
await writeFile(file, JSON.stringify(doc, null, 2) + '\n');
await writeFile('docs/design/keepass-transfer-319.md', `${doc.brief}\n\n[本地可编辑草图](http://127.0.0.1:5186/#docz=${deflateRawSync(JSON.stringify(doc)).toString('base64url')})\n`);
const out = resolve('.artifacts/keepass-transfer-canvas-20261012'); await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', channel: 'msedge', headless: true });
try {
  for (const frame of doc.frames) {
    const page = await browser.newPage({ viewport: { width: 1060, height: 1020 } });
    await page.goto('http://127.0.0.1:5186/');
    if (!(await page.evaluate(() => navigator.userAgent)).includes('Edg/')) throw new Error('Expected installed Edge');
    await page.waitForFunction(() => Boolean(localStorage.getItem('m3e:doc')));
    const preview = { ...doc, frames: [{ ...frame, x: 0 }], groups: doc.groups.filter(g => g.frameId === frame.id).map(g => ({ ...g, x: g.x - frame.x })) };
    await page.locator('input[type=file]').setInputFiles({ name: 'keepass-transfer.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(preview)) });
    await page.waitForFunction(id => JSON.parse(localStorage.getItem('m3e:doc') || '{}').frames?.[0]?.id === id
      || [...document.querySelectorAll('button')].some(button => button.textContent.trim() === '确定'), frame.id, { timeout: 5000 }).catch(async error => {
        console.log((await page.locator('body').innerText()).slice(-2500));
        await page.screenshot({ path: resolve(out, 'import-failure.png'), fullPage: true }); throw error;
      });
    const confirm = page.getByRole('button', { name: '确定', exact: true }); if (await confirm.isVisible()) await confirm.click();
    await page.waitForFunction(id => JSON.parse(localStorage.getItem('m3e:doc') || '{}').frames?.[0]?.id === id, frame.id);
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await page.getByRole('button', { name: '关闭', exact: true }).waitFor();
    await page.screenshot({ path: resolve(out, frame.id + '.png'), fullPage: true });
    await page.close();
  }
  await writeFile(resolve(out, 'render.json'), JSON.stringify({ browser: browser.version(), source: file, frames: doc.frames.map(f => f.id) }));
} finally { await browser.close(); }
