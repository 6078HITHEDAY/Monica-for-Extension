import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/** Shared by workers; profiles survive context restarts until the whole run ends. */
export default async function setup() {
  const runId = randomUUID();
  process.env.MONICA_E2E_PROFILE_RUN_ID = runId;
  // Workers inherit this PID. Manual cleanup must not race a running suite.
  process.env.MONICA_E2E_PROFILE_RUNNER_PID = String(process.pid);
  return async () => {
    if (process.platform !== 'win32') return;
    const script = fileURLToPath(new URL('../../../scripts/clean-test-profiles.ps1', import.meta.url));
    const { stdout } = await promisify(execFile)('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-File', script, '-RunId', runId
    ], { windowsHide: true, timeout: 120_000 });
    if (stdout.trim()) console.log(stdout.trim());
  };
}
