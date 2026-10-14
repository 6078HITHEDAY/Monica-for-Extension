import { defineConfig } from "@playwright/test";

export default defineConfig({
  globalSetup: './tests/e2e/fixtures/edge-lifecycle.ts',
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" }
});
