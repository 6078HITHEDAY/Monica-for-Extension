# Background runtime refactor — 2026-11-01

Status: first batch completed. Extension version remains **1.0.103**; this is unreleased source work. Build identity: **8d84f84fd75082ea7d58**.

## Scope and result

The user selected synchronization and attachments first, followed by command routing. The refactor adds runtime modules that own synchronization activity, pause persistence, notification channels, attachment download routes, upload receipts and Send upload metadata. Internal attachment operations now invoke their own handlers through the shared authorization/native-write executor, preserving the two recovery guards and queue ownership metadata.

Physical line counts include blank lines and the final newline. `src/background/index.ts` decreased from **5,176 to 4,179 lines**; its top-level function count decreased from **142 to 123**. The original 2,201-line `handleRequest` is replaced by a small authorized entry and domain selection, with the remaining core dispatcher at **1,584 lines**. KeePass persistence and Passkey lifecycle implementations remain in the entry for later batches; this does not claim the entire background architecture has been finished.

The audit now follows the actual wired domain tables and the remaining core switch. It requires exactly **231** declared commands and handlers, with no missing, duplicate or undeclared handlers. The old audit omitted the intersection-type declaration for `PROVIDER_ATTACHMENT_TRANSFER`; the new collector includes it. Default denial, manager checks, confirmation requirements, native recovery guards and internal attachment execution are retained and checked.

## Validation

| Check | Result |
| --- | --- |
| Pre-refactor `npx vitest run src/background` | 13 files, 164 tests passed |
| Final `npm test` | 350 files, **4,442 tests passed**, 269.83 seconds |
| `npm run build` | Type checks, icon font validation, Vite/worker builds and four extension-page validations passed |
| `node --test scripts/runtime-command-audit.test.mjs` | **11 passed**, including removal of authorization, native guards, internal invocation, manager restriction, confirmation, handler wiring, coverage and duplicate-handler negative fixtures |
| `node scripts/security-audit.mjs` | Passed against the built output; **231 runtime commands**, including 24 manager-only password-project commands |
| Selected installed Microsoft Edge browser regressions | **16 passed**, approximately 3.1 minutes, no skips |
| `git diff --check` | Passed |

The selected browser suites are `automatic-sync`, `automatic-webdav-sync`, `bitwarden-attachments`, `bitwarden-sends`, `keepass-attachments`, `mdbx2-attachments` and `passkey-unlock`. The six older suites now use the existing `launchTestContext` fixture so the Edge opt-in selects the installed `msedge.exe` and verifies `Edg/` in its user agent; Chromium remains available for CI. The Passkey suite already used the strict Edge fixture.

Browser checks covered actual SignalR notification refresh/reconnection, automatic encrypted updates, MV3 worker restart, popup filling, WebDAV ETags and KeePass lock handling, encrypted Bitwarden attachments and Send, real KDBX attachment round trips, attachment transfer retry and caller denial, RSA Passkey unlock continuation/restart, and cancellation through abort, navigation, timeout and relock. The new runtime tests additionally cover manual synchronization following an in-flight snapshot, late canceled results, concurrent pause persistence, stale notification refreshes, activity ownership, upload completion replay, failed-write retry, cross-provider handles and internal MDBX write guards.

All **16 run-owned Edge profiles were deleted** by the test lifecycle teardown. Raw test/build logs and the task checklist remain under the ignored `.codex-tasks/20261101-background-refactor/` directory. Screenshots, traces, profiles, database fixtures and binaries are not source deliverables.

## Failures resolved during integration

Initial type checks identified duplicate/stale imports and the need to propagate native-write ownership metadata to the batch-transfer target-type check. These were corrected before the passing build. New attachment fixtures initially returned a nested WebDAV summary and omitted native upload/read protocol fields; the fixture data was corrected without relaxing production protocol validation. The first build also exposed the icon scanner treating a quoted `clear` dependency type as an icon name; that type was expressed as a narrow method shape, with no icon/font changes. The audit collector was extended for the real intersection-type declaration and the synchronization handler table.

## Limits

Accounts, credentials and network services in these tests are synthetic. Bitwarden uses local HTTP/SignalR fixtures; WebDAV uses local test endpoints. MDBX manager/transfer browser tests use the existing backend harness, supplemented by direct runtime queue/guard regressions; this is not a new native-host hardware interoperability result. No official cloud-account, Windows Hello hardware, Android or Chrome Web Store review was performed. Encryption algorithms, file formats, optional Native Host/WASM selection and the published `v1.0.103` release were not changed.
