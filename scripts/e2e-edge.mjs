import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

// Edge acceptance run: installed Windows Edge is required, so a missing browser
// fails instead of skipping. Extra arguments select specs, e.g. a single file.
const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
const result = spawnSync(process.execPath, [cli, "test", ...process.argv.slice(2)], {
  stdio: "inherit", env: { ...process.env, MONICA_E2E_REQUIRE_EDGE: "1", MONICA_E2E_EDGE: "1" }, windowsHide: true
});
process.exit(result.status ?? 1);
