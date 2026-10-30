import { launchTestContext } from "./fixtures/edge";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import path from "node:path";

const GOLDEN = path.resolve("native/mdbx2-host/vendor/mdbx/crates/mdbx-storage/test-data/mdbx1-release-1.0.mdbx");

async function openManager(testInfo: { outputPath: (name: string) => string }): Promise<{ context: BrowserContext; manager: Page }> {
  const extensionPath = path.resolve("dist");
  const context = await launchTestContext(testInfo.outputPath("mdbx-first-import-profile"), {
    channel: "chromium",
    headless: true,
    locale: "zh-CN",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 20_000 });
  const manager = await context.newPage();
  await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  await expect(manager.getByRole("heading", { name: "创建加密密码库", exact: true })).toBeVisible();
  return { context, manager };
}

test("first-run shows three entries and keeps ordinary open locked", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const opened = await openManager(testInfo);
    context = opened.context;
    const manager = opened.manager;
    await expect(manager.getByRole("heading", { name: "创建加密密码库", exact: true })).toBeVisible();
    await expect(manager.getByRole("tab", { name: "创建密码库" })).toBeVisible();
    await expect(manager.getByRole("tab", { name: "打开已有的密码库" })).toBeVisible();
    await expect(manager.getByRole("tab", { name: "恢复插件备份" })).toBeVisible();
    await expect(manager.getByRole("button", { name: "创建并解锁" })).toBeVisible();
    await manager.getByRole("tab", { name: "打开已有的密码库" }).click();
    await expect(manager.getByText("将在独立工作副本上升级为 MDBX-2。原始文件不会被修改。").first()).toBeVisible();
    await manager.getByRole("tab", { name: "恢复插件备份" }).click();
    await expect(manager.getByText("恢复插件状态（条目与密码源配置）。独立 MDBX 数据库需要单独的 MDBX 备份。").first()).toBeVisible();
    const locked = await manager.evaluate(async () => chrome.runtime.sendMessage({
      type: "MDBX2_VAULT_OPEN",
      input: {
        name: "locked",
        source: { kind: "file", handle: "11111111-1111-4111-8111-111111111111" },
        credential: { method: "password", password: "x" }
      }
    }));
    expect(locked).toMatchObject({ ok: false, code: "VAULT_LOCKED" });
  } finally {
    await context?.close();
  }
});

test("uninitialized manager imports an MDBX1 golden with a plugin master password", async ({}, testInfo) => {
  test.setTimeout(120_000);
  let context: BrowserContext | undefined;
  try {
    const opened = await openManager(testInfo);
    context = opened.context;
    const manager = opened.manager;
    await manager.getByRole("tab", { name: "打开已有的密码库" }).click();
    await manager.locator('input[type="file"][accept*=".mdbx"]').setInputFiles(GOLDEN);
    await manager.getByLabel("MDBX 密码").fill("mdbx1-golden-password");
    await manager.getByLabel("插件主密码", { exact: false }).fill("first-run-mdbx-master");
    await manager.getByLabel("确认主密码").fill("first-run-mdbx-master");
    await manager.getByRole("button", { name: "打开并接入密码库" }).click();
    await expect(manager.getByRole("heading", { name: "全部项目", exact: true })).toBeVisible({ timeout: 90_000 });
    await manager.getByRole("button", { name: "密码源" }).click();
    await expect(manager.getByText("MDBX", { exact: false }).first()).toBeVisible();
  } finally {
    await context?.close();
  }
});

test("uninitialized manager imports an MDBX1 golden with a device key", async ({}, testInfo) => {
  test.setTimeout(120_000);
  let context: BrowserContext | undefined;
  try {
    const opened = await openManager(testInfo);
    context = opened.context;
    const manager = opened.manager;
    await manager.getByRole("tab", { name: "打开已有的密码库" }).click();
    await manager.locator('input[type="file"][accept*=".mdbx"]').setInputFiles(GOLDEN);
    await manager.getByLabel("MDBX 密码").fill("mdbx1-golden-password");
    await manager.getByRole("button", { name: "打开并接入密码库" }).click();
    await expect(manager.getByRole("heading", { name: "全部项目", exact: true })).toBeVisible({ timeout: 90_000 });
  } finally {
    await context?.close();
  }
});
