# Test cache cleanup — 2026-10-14

The user requested immediate cleanup of the extension workspace. Deleted only
verified, inactive generated data inside the extension's `.tmp` directory:

- 1,134 isolated Edge audit profiles: 21,220,023,821 bytes (19.763 GiB).
- 232 old Android build-intermediate and legacy isolated browser-profile
  directories: 5,238,151,556 bytes (4.878 GiB).
- Total: 26,458,175,377 bytes (24.641 GiB). Every selected path was confirmed
  absent afterward; no deletion failures. `.tmp` now contains 9.104 GiB and
  `edge-audit-profiles` is empty. C: free space was approximately 56.44 GiB
  after cleanup; this is a disk snapshot, not a promised future free-space level.

Kept source snapshots, test inputs, reports, native Host test state, Android
build outputs, the current development build, release packages, toolchains,
the shared Android AVD, and personal browser/vault data. No browser or Android
process was terminated. The remaining temporary data was not blanket-deleted.

Local inventories and deletion receipts are under
`.artifacts/cache-cleanup-20261014-*.json`; the summary verifies all selected
paths are absent. These generated reports are not repository assets.

## Preventing accumulation

Playwright global setup assigns a unique run ID inherited by workers. The Edge
fixture writes an ownership marker outside the browser's own profile files.
At the end of the run, cleanup selects only profiles owned by that run, checks
live browser command lines, validates resolved paths under the dedicated test
root, rejects directory links, and deletes inactive profiles. Launch failures
also leave an owned marker for run cleanup. Browser evidence, traces and other
test output remain outside the removed profiles.

Profiles remain available throughout a run, including context close/reopen
tests. Manual recovery after an interrupted runner is available on Windows:

```powershell
npm run clean:test-profiles
# Inspect only:
powershell.exe -NoProfile -NonInteractive -File scripts/clean-test-profiles.ps1 -AllInactive -DryRun
```

Manual cleanup additionally skips profiles whose runner PID is still alive.
It requires ownership markers and does not remove arbitrary old directories.
An uninspectable browser process causes cleanup to stop without deleting data;
locked/failed removals are reported rather than killing browser processes.
Forced termination of the entire test runner can prevent automatic teardown;
the manual command covers its inactive owned profiles later.

## Verification

- Actual installed Edge: two lifecycle scenarios passed in 5.9 seconds,
  including a deliberately expected assertion failure. Live browser protection,
  live runner protection between launches, same-profile restart and cookie
  persistence passed. Final teardown reported `deleted=2`; the profile root
  was independently confirmed empty afterward.
- Strict TypeScript checking passed for both lifecycle helpers, the regression
  scenarios and Playwright configuration.
- PowerShell parsing and Windows PowerShell 5.1 execution passed. Corrected a
  PowerShell 5.1 hashtable grouping difference found by the first acceptance run.
- Playwright discovery: 326 tests in 131 files. This was discovery, not a full
  application regression run. The cleanup change does not alter extension
  runtime behavior or the published 0.1.39 package.
- `git diff --check` passed. No new release or version change.

Native content-write work remains uncommitted and unfinished in its own block;
this cleanup does not complete Wi-Fi nearby synchronization or Android parity.
