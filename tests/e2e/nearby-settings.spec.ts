import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLoginItem } from '../../src/core/model';
import { launchEdgeContext } from './fixtures/edge';
import { temporaryNativeHost } from './fixtures/native-host';

async function runtime(page: Page, request: unknown): Promise<any> {
  const result = await page.evaluate(request => chrome.runtime.sendMessage(request), request);
  expect(result.ok, result.error).toBe(true); return result.data;
}
test('settings UI pairs, discovers, synchronizes and cancels using actual Native Messaging', async ({}, info) => {
  test.skip(process.platform !== 'win32', 'Installed Edge'); test.setTimeout(150000);
  const extension = path.resolve('dist'), run = path.resolve(info.outputPath('isolated')); await mkdir(run, { recursive: true });
  const contexts: BrowserContext[] = [], evidence: Record<string, unknown> = { status: 'failed', productionUi: true, androidApplicationAcceptance: false };
  let registration: Awaited<ReturnType<typeof temporaryNativeHost>> | undefined;
  const launch = async (name: string) => {
    const data = path.join(run, `appdata-${name}`); await mkdir(data, { recursive: true });
    const context = await launchEdgeContext(path.join(run, `profile-${name}`), { locale: 'zh-CN', colorScheme: 'dark', viewport: { width: 1080, height: 960 },
      env: { ...process.env, APPDATA: data, LOCALAPPDATA: data }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] }); contexts.push(context);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`); evidence.edgeVersion = context.browser()?.version(); return page;
  };
  const settings = async (page: Page) => {
    await page.reload(); await page.getByRole('button', { name: '设置与备份', exact: true }).click();
    await page.locator('[data-settings-entry="wifi-sync"]').click();
    await expect(page.getByRole('button', { name: '显示本机邀请', exact: true })).toBeEnabled();
  };
  try {
    const a = await launch('a'); registration = await temporaryNativeHost(new URL(a.url()).host, path.join(run, 'native')); const b = await launch('b');
    for (const page of [a, b]) await runtime(page, { type: 'VAULT_SETUP', masterPassword: '' });
    await runtime(a, { type: 'VAULT_IMPORT_ITEMS', items: [createLoginItem({ title: 'Synthetic UI sync login', username: 'alice', password: 'synthetic UI password' })] });
    await settings(a); await settings(b);
    await a.getByRole('button', { name: '显示本机邀请', exact: true }).click();
    const invite = await a.getByRole('textbox', { name: '本次配对邀请', exact: true }).inputValue();
    await expect(a.getByRole('img', { name: '本次配对邀请二维码' })).toBeVisible();
    await b.getByRole('textbox', { name: '配对邀请', exact: true }).fill(invite);
    await b.getByRole('button', { name: '连接设备', exact: true }).click();
    for (const page of [a, b]) await expect(page.locator('[data-nearby-phase]')).toContainText('同步完成', { timeout: 20000 });
    expect(await runtime(b, { type: 'VAULT_LIST_ITEMS' })).toHaveLength(0);
    await expect(a.getByRole('textbox', { name: '本次配对邀请', exact: true })).toHaveCount(0);
    await a.locator('[data-nearby-sync]').click();
    await expect(a.locator('[data-nearby-phase]')).toContainText('正在连接或传输');
    await b.getByText('通过局域网地址查找', { exact: true }).click();
    await b.getByRole('textbox', { name: '另一端 IPv4 地址' }).fill('127.0.0.1');
    await b.getByRole('button', { name: '查找附近设备', exact: true }).click();
    await expect(b.getByText('找到 1 台已配对设备', { exact: true })).toBeVisible({ timeout: 15000 });
    await b.locator('[data-nearby-sync]').click();
    for (const page of [a, b]) await expect(page.locator('[data-nearby-phase]')).toContainText('同步完成', { timeout: 20000 });
    const received = await runtime(b, { type: 'VAULT_LIST_ITEMS' }); expect(received).toHaveLength(1); expect(received[0].password).toBe('synthetic UI password');
    await b.setViewportSize({ width: 360, height: 900 });
    const closeNavigation=b.getByRole('button',{name:'关闭导航',exact:true}); if(await closeNavigation.isVisible())await closeNavigation.click();
    expect(await b.locator('[data-nearby-settings]').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await b.screenshot({ path: path.join(run, 'nearby-settings-narrow.png'), fullPage: true });
    await a.locator('[data-nearby-sync]').click(); await a.getByRole('button', { name: '取消同步', exact: true }).click();
    await expect(a.locator('[data-nearby-phase]')).toContainText('同步已取消');
    await a.getByRole('button', { name: '重新连接', exact: true }).click();
    await expect(a.getByRole('button', { name: '显示本机邀请', exact: true })).toBeEnabled();
    expect(await runtime(b, { type: 'VAULT_LIST_ITEMS' })).toHaveLength(1);
    evidence.status = 'passed'; evidence.pairingWithoutContent = true; evidence.unicastDiscovery = true; evidence.cancelReconnect = true;
  } finally { for (const context of contexts) await context.close(); await registration?.restore(); await writeFile(path.join(run, 'evidence.json'), JSON.stringify(evidence, null, 2)); }
});
