# Extension PR and issue integration — 2026-10-31

## Scope

Reviewed and locally integrated community PRs #18 (Vivaldi popup fallback), #20 (one conflict scan per MDBX target collection), and #21 (MDBX OneDrive transport). Their original heads are preserved as merge ancestors: `1a86eb4`, `6bcd6a9`, and `6919be3`. The existing Bitwarden device-login and hotspot work was preserved in `279f7ee` before integration. Version remains 1.0.102, unreleased.

Issue #16: standard Bitwarden JSON types import as editable local items; older local opaque imports can be deleted, restored and explicitly purged without rewriting their payload. Remote opaque records remain protected, including restore and purge paths. Added encrypted-restart and remote negative regressions plus an actual Edge import/edit/delete/restore flow.

Issue #17: the reporter withdrew the initial malformed-JSON diagnosis. API 9 returned NotSupportedError / 0x80090027 with local passkey saving disabled. Enabling the Windows setting allowed their experimental ANY version to work, but PLATFORM with that setting enabled was not tested. Keep PLATFORM and REQUIRED; serialize client data through serde_json and return only whitelisted public error names, HRESULT and API version. This machine has no available platform authenticator, so the reporting-device failure is not confirmed fixed and the issue must remain open for retest.

OneDrive review hardening: bind clients to the original provider/session/path, abort transport on lock or cancelled login, do not replay partially consumed downloads, verify uploaded bytes by downloading and hashing them, enforce immutable-write preconditions and upload-session acknowledgement offsets/statuses. Real Microsoft cloud-account interoperability is not claimed.

## Validation

- Vitest: **344 files / 4,377 tests passed**, 208.31 seconds, with two workers and a 30-second per-test budget. Production Argon2 parameters remain unchanged.
- Native Host: **115 tests passed**, 133.87 seconds; Hello subset **6 passed**; Clippy all-targets with warnings denied passed.
- Snapshot CI fixture final retest: **1 passed**, 10.30 seconds. Give each snapshot a fresh eligibility timestamp; do not weaken production retention validation.
- Pinned Emscripten 4.0.18 / Rust 1.97.0 browser WASM rebuilt from final native sources; final TypeScript and extension production build passed, including native-source and browser-artifact verification.
- Actual Edge final focused run: **7 passed**, 53.4 seconds: issue #16, offscreen MDBX lifecycle, batch transfer, collections, OneDrive connection UI, and two Passkey/Hello fail-closed flows. Earlier Bitwarden authentication and shared security UI tests also passed. Browser fixtures are synthetic; these are not physical Hello or live-cloud tests.
- Actual Chromium toolbar-action popup probe passed. Vivaldi-specific fallback was reviewed and unit-covered, but Vivaldi was not installed for local acceptance.
- Security audit passed (225 runtime commands, 24 manager-only project commands); production npm audit reported **0 vulnerabilities**; supply-chain checks passed.
- Native Hello probe: supported=true, available=false, reason=platform-authenticator-unavailable, damagedBindingRejected=true, promptFree=true. No physical biometric enrollment was attempted.

## Failures and corrections

The original highly concurrent Vitest run had 26 five-second timeouts; a two-worker attempt still had one five-second timeout. The final complete run above passed with the configured resource budget. These earlier runs are not counted as passing.

The first issue #16 browser fixture assumed list ordering; corrected it to locate the intended record. A lock-cancellation regression exposed cancellation before a download stream was acquired; added abort checks around asynchronous hashing setup. A source guard still matched the old sync constructor and was updated to verify the actual injected WebDAV/OneDrive factory. Stale WASM provenance was rejected and then rebuilt with the pinned tools, without bypassing verification.

PR #18's earlier Windows failure reused an eligibility timestamp for a later snapshot; slow CI could create that snapshot after eligibility. The test now computes a fresh timestamp for each creation. PR #20's Windows packaging failure involved a stale tracked build identity; the final identity is regenerated before committing, and packaging must run from a clean tracked tree.

## Evidence and limits

Detailed local logs use the `extension-integration-*20261031.log` names under the workspace `.codex-tmp/` directory. Local editable M3E sketches and browser screenshots remain in ignored design/test-output directories and are not committed. No Android files or AVDs were touched; no user vault data was cleared. GitHub CI and merge outcomes are recorded in the integration PR.

New PR #22 and issue #23 appeared during final verification and are being reviewed separately; they are not covered by the test counts above.
