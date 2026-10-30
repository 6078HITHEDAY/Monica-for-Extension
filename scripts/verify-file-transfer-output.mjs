import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
const source = new URL('../docs/design/import-export/canvas.json', import.meta.url);
const link = await readFile(new URL('../docs/design/import-export/canvas-url.txt', import.meta.url), 'utf8');
const doc = JSON.parse(await readFile(source, 'utf8'));
if (!link.startsWith('http://127.0.0.1:5186/?project=extension-import-export#docz=')) throw new Error('Expected a local project-scoped Canvas link');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, reducedMotion: 'reduce' });
  await page.goto(link, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const value = localStorage.getItem('m3e:doc:project:extension-import-export');
    return value && JSON.parse(value).title === 'Monica · 导入与导出';
  });
  const actual = await page.evaluate(() => JSON.parse(localStorage.getItem('m3e:doc:project:extension-import-export')));
  if (actual.frames.length !== doc.frames.length || actual.groups.length !== doc.groups.length) throw new Error('Canvas did not load the saved editable draft');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await page.getByRole('button', { name: '关闭', exact: true }).waitFor();
  await page.screenshot({ path: fileURLToPath(new URL('../docs/design/import-export/canvas-preview.png', import.meta.url)), fullPage: true });
  await writeFile(new URL('../docs/design/import-export/render.json', import.meta.url), JSON.stringify({ local: true, project: 'extension-import-export', title: actual.title, frames: actual.frames.length, groups: actual.groups.length, browser: browser.version() }, null, 2));
  console.log('Local editable Canvas loaded and previewed: three frames with saved components.');
} finally { await browser.close(); }
