# First-run import and authentication follow-up

Date: 2026-10-31. Extension version remains 1.0.102; next-release notes remain
unreleased. Integration preserves PR #22 head
`25b60efae950957ec9332426ae94a7abbb03931d` as a merge ancestor of main `258b792`.

## Import ownership and lifecycle

The author's follow-up protects successful registration followed by import-log
write failure, serializes commit/cancel/recover for the same operation, reuses
the registered provider on retry and preserves an unverifiable committing
record while locked. The original cancellation deletion regression now passes.

Further review found a second deletion case: provider persistence succeeds but
its caller receives an error while the provider list is locked. The existing
catch treated an unavailable list as proof that the copy was unregistered. A new
test failed with the registered handle in `discarded` (10 passed, 1 failed).
The catch now retains the committing record and handle until ownership can be
verified. A subsequent closed native session also preserves this evidence.
Cancellation, stale recovery, unlocking and retry retain one provider and its
original handle.

The import preparation and commit commands stay manager-only. The first-run
KeePass branch now uses the common typed runtime client for setup, unlock,
open, sync and list instead of bypassing the build-compatibility probe. A cached
status check cannot authorize sending a password to a different worker build.
Existing source credentials, encryption/KDF and source-file preservation rules
remain intact.

## Build and regression evidence

- Pinned Rust 1.97.0 and Emscripten 4.0.18 browser engine build passed in 1m17s;
  bundled WASM is 6,456,460 bytes. Browser provenance verification passed.
- Native Host tests: 119 passed, 111.42 seconds. Original compilation omissions
  (`Blob.name` and two implicit-any fixture parameters) were fixed; extension
  TypeScript/interop, icon inventory, bundling and four page inventories pass.
- Integrated full Vitest suite: 347 files, 4,422 tests passed in 217.02 seconds.
  After the final ownership-evidence and common-client adjustments, 35 targeted
  import/runtime tests and 59 runtime/import/language tests passed. The earlier
  full run was interrupted after compilation failures were found and is not
  counted as passing.
- Initial actual Microsoft Edge validation: 12 passed in 1.3 minutes, including
  eight Bitwarden verification cases and four first-run cases. Expanded import
  acceptance checks incorrect passwords, retry, refresh, source-file hashes,
  retained provider handles, browser backend selection and login-attached OTPs.
  Final expanded actual Edge run: all five cases passed in 27.0 seconds. A real
  complete backup is generated through the production browser export interface
  and reopened in a separate uninitialized profile. Both MDBX and ZIP retain a
  single provider and the same handle after reload; the original golden hash is
  unchanged. The KeePass case verifies actual username/password/OTP projection
  and displays its code in the authenticator section.
  The final screenshot capture repeated all five cases: 5 passed in 31.9 seconds,
  and all six isolated profiles were removed. The actual first-run screen was
  visually checked against the saved local draft.
- Security audit: 230 runtime commands and manager ownership checks passed.
  Toolchain, lockfile, workflow/preview and native provenance checks pass.
  Production npm audit found zero vulnerabilities.

The first expanded ZIP fixture used ordinary DEFLATE ZIP encoding, which the
reviewed extractor rejects: complete backups use ZIP Stored. MDBX-1 itself is
supported. The fixture now uses a migrated database exported through the
production complete-backup interface and Stored encoding. Its initial decoder used
an excessive spread-argument count; the test now collects bounded chunks without
argument spreading. A KeePass locator initially matched both the precise error
and the orphan-information alert; it now asserts the precise error. Those failed
attempts are preserved and are not counted as product acceptance.

Logs are under the workspace `.codex-tmp/`, prefixed `extension-pr22-`. Editable
M3E drafts and screenshots are local ignored files in
`docs/design/first-run-import-20261031/`. The draft project is
`http://127.0.0.1:5186/?project=extension-first-run-import-20261031`; its full
reopen URL and JSON are saved alongside it. Screenshots and fixture archives are
excluded from Git. Isolated browser profiles are removed by the test lifecycle.

Bitwarden's reporting official account and Windows Hello issue #17 still require
reporting-device evidence. The new authentication response tests are synthetic;
they do not establish the cause of that account's failure. No version change,
Release, tag or package delivery is part of this follow-up.

The final dependency-security follow-up supersedes the earlier local build:
source identity `74ff7189bd356afffed7`, full 4,423-test Vitest regression and
13-case actual Edge authentication/import run pass. Detailed dependency,
historical scanner attribution and corrected browser-runner evidence are in
[the integration security record](extension-integration-security-20261031.md).
