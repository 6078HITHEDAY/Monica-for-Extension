import path from "node:path";
import { chromium, expect, test, type Page } from "@playwright/test";

const VAULT_PASSWORD = "synthetic nearby page password";

async function send(page: Page, request: object): Promise<any> {
  const result = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(result.ok, result.error).toBe(true);
  return result.data;
}

/** The real manager page, background owner and Native Messaging path. No native
 * helper is registered in this profile, so actions must explain how to recover. */
test("nearby sync page pairs through the background owner and explains a missing helper", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), { channel: "chromium", headless: true, locale: "zh-CN",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    await worker.evaluate(() => { const connect=chrome.runtime.connectNative.bind(chrome.runtime); chrome.runtime.connectNative=(name:string)=>connect(name==='com.monica_pass.mdbx2'?'com.monica_pass.missing_pairing_test':name); });
    const manager = await context.newPage();
    const errors: string[] = [];
    manager.on("pageerror", error => errors.push(error.message));
    await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(manager, { type: "VAULT_SETUP", masterPassword: VAULT_PASSWORD });
    await manager.reload();
    await manager.getByRole("button", { name: "设置与备份", exact: true }).first().click();
    await manager.locator('[data-settings-entry="wifi-sync"]').click();

    const page = manager.locator("[data-settings-page=wifi-sync]");
    await expect(manager.locator('[data-settings-entry="nearby-sync"]')).toHaveCount(0);
    await expect(page.getByText('先在两端完成一次配对，再同步密码库。')).toBeVisible();

    // Settings round-trip through the encrypted preferences store.
    await page.getByRole("textbox", { name: "设备名称", exact: true }).fill("Synthetic work browser");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "设备名称", exact: true })).toBeEnabled();

    await page.getByRole("button", { name: "显示本机邀请" }).click();
    await expect(page.getByRole("alert")).toContainText("本机通信组件");
    await expect(page.getByRole("button", { name: "配置本机通信组件" })).toBeVisible();
    await testInfo.attach("wifi-sync-page", { body: await manager.screenshot({ fullPage: true }), contentType: "image/png" });

    // Leaving the page releases the single manager lease; reopening works.
    await manager.getByRole("button", { name: "返回" }).click();
    await manager.locator('[data-settings-entry="wifi-sync"]').click();
    await expect(page.getByRole("textbox", { name: "设备名称", exact: true })).toHaveValue("Synthetic work browser");
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
