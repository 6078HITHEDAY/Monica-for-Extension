# Password removal recovery source routing

2026-10-09: fixed the manager's pending password-removal panel routing every source's “解锁并设置” action to the MDBX dialog. A disabled KeePass source could not reach its own reconnect settings from this recovery entry point.

The handler now opens KeePass settings for KeePass sources (including the existing OneDrive dispatch) and MDBX settings for MDBX sources. Existing removal, cancellation, receipt and remote-write logic is unchanged. This reuses the [existing recovery design](design/keepass-removal-317.md), without changing layout or controls.

`tests/e2e/project-removal-source-routing.spec.ts` failed on the previous production build because the WebDAV action opened MDBX instead of KeePass. After the fix it passes all three source cases in actual Microsoft Edge `154.0.4258.62`, with the explicit installed `msedge.exe` and a separate synthetic profile. It checks correct settings, existing WebDAV path/OneDrive filename, closing back to the still-present operation, and 320px geometry. All three screenshots were inspected.

The test supplies synthetic provider/pending-operation summaries to the manager; it does not create real pending mutations, connect cloud accounts, resume writes or prove remote recovery. The earlier real WebDAV transaction/restart evidence remains in [member-removal acceptance](keepass-member-removal-317.md).

Evidence: `.artifacts/project-source-routing-before/` (failure and trace), `.artifacts/project-source-routing-after/` (passing test, browser provenance and screenshots), `.artifacts/project-source-routing-build.log` (both TypeScript configurations, production build and asset verification). `git diff --check` passes. `dist` is updated, still unreleased `0.1.37`; no new release/tag/push or Android product changes.
