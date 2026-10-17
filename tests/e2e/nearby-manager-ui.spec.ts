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
    const manager = await context.newPage();
    const errors: string[] = [];
    manager.on("pageerror", error => errors.push(error.message));
    await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(manager, { type: "VAULT_SETUP", masterPassword: VAULT_PASSWORD });
    await manager.reload();
    await manager.getByRole("button", { name: "设置与备份", exact: true }).first().click();
    await manager.locator('[data-settings-entry="nearby-sync"]').click();

    const page = manager.locator("[data-settings-page=nearby-sync]");
    await expect(page.getByRole("heading", { name: "与 Monica 安卓版进行 Wi-Fi 同步" })).toBeVisible();
    await expect(page.getByText("还没有配对的设备。请在下方添加你的手机。")).toBeVisible();
    await expect(page.getByText("正在连接附近设备同步服务…")).toHaveCount(0);

    // Rejected locally before any native work.
    await page.locator("#nearby-invitation").fill("not a pairing link");
    await page.getByRole("button", { name: "连接", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("配对链接无效。");

    // Settings round-trip through the encrypted preferences store.
    await page.locator("#nearby-device-name").fill("Synthetic work browser");
    await page.locator("#nearby-device-name").press("Enter");
    await expect(page.locator("#nearby-device-name")).toBeEnabled();

    await page.getByRole("button", { name: "显示配对二维码" }).click();
    await expect(page.getByRole("alert")).toContainText("尚未安装 Monica 本机助手。");
    await expect(page.getByRole("alert")).toContainText("README");
    await testInfo.attach("nearby-sync-page", { body: await manager.screenshot({ fullPage: true }), contentType: "image/png" });

    // Leaving the page releases the single manager lease; reopening works.
    await manager.getByRole("button", { name: "返回" }).click();
    await manager.locator('[data-settings-entry="nearby-sync"]').click();
    await expect(page.locator("#nearby-device-name")).toHaveValue("Synthetic work browser");
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
