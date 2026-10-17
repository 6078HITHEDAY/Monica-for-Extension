import { chromium, test, type BrowserContext } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const profiles = new Map<string, string>();
export const EDGE_EXECUTABLE = process.env.MONICA_E2E_EDGE_EXECUTABLE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

/** Edge acceptance needs the installed Windows Edge (and, for some suites, the
 * registered native host). Where it is absent, as on Linux CI runners, skip with
 * the reason; MONICA_E2E_REQUIRE_EDGE=1 (`npm run test:e2e:edge`) makes a
 * missing Edge a failure so acceptance runs can never pass vacuously. */
export async function requireInstalledEdge(executable = EDGE_EXECUTABLE): Promise<void> {
  const installed = await stat(executable).then(() => true, () => false);
  if (installed || process.env.MONICA_E2E_REQUIRE_EDGE === "1") { await stat(executable); return; }
  test.skip(true, `Installed Microsoft Edge is required at ${executable}; run npm run test:e2e:edge on Windows.`);
}

/** Opt into installed Edge locally while retaining bundled Chromium in CI. */
export function launchTestContext(profile: string, options: Parameters<typeof chromium.launchPersistentContext>[1] = {}) {
  return process.env.MONICA_E2E_EDGE === '1' ? launchEdgeContext(profile, options) : chromium.launchPersistentContext(profile, options);
}

/** Actual Edge acceptance, with an isolated profile and no browser fallback. */
export async function launchEdgeContext(
  profile: string,
  options: Parameters<typeof chromium.launchPersistentContext>[1] = {}
): Promise<BrowserContext> {
  const executablePath = EDGE_EXECUTABLE;
  assert.equal(path.basename(executablePath).toLowerCase(), "msedge.exe");
  await requireInstalledEdge();
  // Edge's IndexedDB backing-store paths can exceed Windows limits when the
  // profile lives under Playwright's full test title. Keep restart identity.
  const shortProfile = profiles.get(profile) || path.resolve(".tmp/edge-audit-profiles", randomUUID().slice(0, 18));
  profiles.set(profile, shortProfile);
  await mkdir(shortProfile, { recursive: true });
  const context = await chromium.launchPersistentContext(shortProfile, {
    ...options, channel: "msedge", executablePath, headless: false
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    const userAgent = await page.evaluate(() => navigator.userAgent);
    assert.match(userAgent, /Edg\//, "Acceptance must run in Microsoft Edge");
    await mkdir(path.dirname(profile), { recursive: true });
    await writeFile(`${profile}-browser.json`, JSON.stringify({ executablePath, userAgent, version: context.browser()?.version(), headless: false, profile: shortProfile }, null, 2));
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}
