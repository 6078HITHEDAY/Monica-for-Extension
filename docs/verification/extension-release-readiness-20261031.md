# Extension release readiness

Date: 2026-10-31. Current stable and build version: 1.0.102.
The accumulated changes justify a proposed 1.0.103 release; this check does not
create a tag, switch versions or publish a formal release.

## Main CI findings

Main CI [41201372360](https://github.com/Monica-Pass/Monica-for-Extension/actions/runs/41201372360)
tested `970668ae3ca42ecfad748e01f35d607e8dcc73a7`.
The Windows job passed Native Host tests and lint, the pinned browser engine
build, required Edge acceptance, host packaging and installer-isolation checks.
Linux passed 4,423 unit tests, 703 security tests and two Bitwarden contract
tests, but its E2E run ended with 161 passed, 227 skipped and one failed.
The failure prevented extension packaging and the rolling Preview update.
Skipped platform/hardware cases are not counted as acceptance.

The failed provider-page assertion still searched for `MDBX2 可移植备份`.
The production input is now `MDBX 可移植备份`, supporting standalone `.mdbx`
and complete `.zip` backups. Actual Edge reproduced the stale assertion.
The correction checks the exact current label and both accepted extensions.

The main CodeQL run 41201372287 and Secret Scan run 41201372314 passed;
historical full-history fixture findings and the complete dependency audit are
documented separately in [the security follow-up](extension-integration-security-20261031.md).

## Browser fixture corrections

A broader actual Edge visual run initially passed 13 cases and failed two
synthetic conflict/snapshot-manager cases. Their confirmation clicks did not
produce the expected runtime mutation requests. Keeping the existing 375px
viewport for the screenshot immediately before confirmation made both cases
pass (2/2 in 17.3 seconds). The former full-page captures disturbed the dialog
interaction during automation. The final complete visual suite passed all
15 cases in 1.2 minutes, including real confirmation clicks and assertions that
the resolved conflict and deleted snapshot disappeared. All 15 isolated Edge
profiles were removed by the existing lifecycle.

Only those two screenshots changed to viewport captures. Production handlers,
confirmation requirements and mutation-result assertions were preserved.
Temporary runtime instrumentation and diagnostic assertions were removed.
An earlier attempt to run diagnostic suites concurrently collided on shared
trace outputs and cleanup; it is not counted as a passing run. Final suites
run sequentially with separate output directories.

Earlier branch CI 41200938846 failed a Windows settings test when the language
selector remained expanded after Escape. Main Windows CI passed
the same production commit, and the original same-build Edge case passed three
independent repeats in 58.3 seconds. The fixture now waits for `aria-expanded`
and the visible language panel before sending Escape, retaining the existing
close and keyboard-focus assertions.
The corrected case passed all three actual Edge repeats in 37.4 seconds,
and all three isolated profiles were removed. The original intermittent
failure's full cause remains unconfirmed; the explicit waits avoid racing the
menu's opening transition.

Local logs remain under workspace `.codex-tmp/`, including
`extension-release-readiness-visual-{before,after,final}.log`,
`extension-release-readiness-manager-viewport.log`, and
`extension-release-readiness-settings{,-final}.log`.
Screenshots, traces and browser profiles are not committed.

## Release scope

The proposed release covers first-run MDBX/ZIP/KDBX opening, Bitwarden
authentication compatibility, community contributions, local synchronization
discovery and dependency security updates. Details are in the
[next-release changelog](../releases/Monica-Extension-next-changelog.md).
Published 1.0.102 notes remain unchanged.

Ordinary MDBX creation, import and editing use the bundled browser WASM engine.
The Native Host remains optional for native functions such as Wi-Fi sync;
existing native working copies retain their backend until explicit migration.
No storage rewrite or new component-installation requirement was introduced.

Before publishing, confirm both new main CI jobs pass, select the extension
version and give changed helper binaries a new version rather than replacing
the published 0.1.4 package. Verify the corresponding package checksums and
installation instructions. The reporting official Bitwarden account,
Windows Hello device and real OneDrive account still need their original
environment checks; successful fixtures do not establish those results.
