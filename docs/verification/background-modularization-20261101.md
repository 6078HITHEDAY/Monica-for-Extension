# Complete background modularization, 2026-11-01

Baseline: `b51137b45892b860d984fc1cfaed382e676db820`, extension 1.0.103. The first batch already extracted sync and attachments; this continuation completes domain ownership and command routing. No Android sources, extension formats, version or published release archives changed.

## Structure and preserved behavior

- The entry is 3 lines of code, compared with 4,179 before this continuation and 5,176 before the first batch. Composition is 373 lines; events are 187. The remaining business commands are explicit domain tables. The aggregate table is checked against the whole `ExtensionRequest` union.
- KeePass owns session and durable persistence state. Transfers own progress/status/session state. Credential candidates and stepped usernames, Passkey request races, journal receipts and verification state each have explicit owners. Callers receive operations rather than mutable Maps.
- Passkey request flow, journal and verification are separate Modules. Source adapters retain their existing cryptography, queue, file-format and connection-binding implementations. Deferred callbacks have explicit getters; no runtime imports point back to the composition root.
- Read-only TypeScript AST comparison found 116 existing function bodies and 204 switch-case handler bodies unchanged after normalizing dependency qualification. The remaining differences are the candidate/transfer cleanup, journal cache access and KeePass queue-wait wrappers; each was checked for equivalent ordering.
- Explicit lock, automatic lock and restore keep their distinct cleanup order. `KEEPASS_LOCK` still flushes, pauses, waits and locks. Native writes still require the manager, queue ownership and both recovery guards. Batch transfer receives the native-ownership flag and rechecks its target after queueing.
- Passkey preserves prepared/committed/unknown recovery, document/signing identity, verification cleanup and the direct sync entry inside an already-held provider queue. Save confirmation can survive navigation; stepped username continuation requires a different document. HOTP delivery is acknowledged before reporting another field's error.

## Validation

| Check | Result |
| --- | --- |
| Full Vitest suite | 353 files, 4,465 tests passed in 279.70 seconds |
| Focused Module-interface regressions | 4 files, 32 tests passed, including the final typed sender fixture |
| Command-wiring audit | All 29 positive/negative fixtures passed; 231 commands parsed, including 24 manager-only password-project commands |
| TypeScript checks | Both production and interop projects passed after correcting the new test sender's incomplete Tab fixture |
| Complete extension build | Passed, build ID `edea635b15831daf9271`; existing large-chunk warnings remain |
| Production bundle security audit | Passed, including command authorization, nearby ownership, redaction and lifecycle cancellation |
| Emitted runtime import graph | All 50 background Modules checked; no runtime import cycle |

The installed-Edge run selected 84 cases. All 82 in-scope cases eventually passed; 2 explicit environment-dependent cases were skipped. The initial run had 74 passes, 8 failures and 2 skips in 17.3 minutes. The first follow-up had 10 passes and 1 remaining selector failure in 4.9 minutes; 3 of those passes repeated the other locked-autofill cases. A single MDBX follow-up reached import and then failed on the old file-picker label in 27.6 seconds. The final MDBX run passed in 13.9 seconds (18.4 seconds including setup/teardown). Initial failures are distinct attempts, not passes; the final 82 counts distinct accepted cases rather than repeated executions.

The new interface-level regressions exercise journal recreation, expired registration reconciliation, locked uncertainty, interrupted assertions, failed receipt persistence, requester identity, save confirmation across navigation, stepped username rules, candidate invalidation and HOTP partial success. Router regressions exercise both authorization and actual dispatcher metadata delivery. Audit negative fixtures alter the actual wiring, not a disconnected copy of it.

The icon-font gate initially misclassified type-only method names (`clear`, `pause`, `stop`, `resume`) as icons. It now scans emitted TypeScript runtime text, preserving executable strings while excluding erased types/comments. No icon font was regenerated. Initial new test fixtures omitted a valid active document ID/lifecycle or iframe message stub; only those fixtures were corrected, with no production-policy relaxation.

Browser acceptance uses the installed Microsoft Edge and checks its `Edg/` user agent. Six previously Chromium-only suites now use the shared opt-in browser helper, retaining Chromium for CI. Profiles have per-run ownership and automatic teardown. Test secrets, synthetic files, browser profiles, screenshots and build output remain outside Git.

Initial browser failures exposed stale test fixtures: KeePass/MDBX connection actions are now buttons, the editor's More Options opens a section dialog, and Bitwarden batch moves were already available before this refactor. The relevant UI sources have no diff from `b51137b`; only selectors and the obsolete disabled-radio assertion were updated, retaining persistence, content and cryptographic assertions. MDBX's button accessible name also includes supporting text, so its initial exact match was corrected; the portable-file picker now uses the existing `MDBX 可移植备份` label. A 15-second locator timeout makes stale-selector failures explicit without waiting for the whole 180-second test deadline. Another initial case could not find the Debug Native Host previously removed with local build caches. The shared fixture now accepts `MONICA_E2E_NATIVE_HOST_EXECUTABLE`, and the follow-up run uses the already-built Release binary (SHA-256 `86699cbb7b0b2c35411a12b9ca75d5b85d83c0d4d2047608116530a785cad855`) with the existing temporary registration/restore checks. Initial failures are retained as failed attempts in local logs and traces, not counted as passes.

Two opt-in cases need an Android-return snapshot or a separately running Apache WebDAV service. They are outside this browser-only refactor's acceptance run and must be reported as skipped. Other cases cover synthetic Bitwarden HTTP recovery, KeePass remote version/recovery behavior, browser/native MDBX routing, Passkey cryptographic assertions and restart, save confirmation, HOTP/custom/inline/locked autofill, policy exclusions and manager/document/origin authorization.

Each browser run completed its owned-profile cleanup: 82 initial profiles, 11 first follow-up profiles and one profile for each of the two final single-case runs were removed. The final MDBX case creates, reads, exports, locks, restarts, unlocks and imports through the production UI with no available Native Host; the unavailable legacy source keeps its native binding and does not interrupt the browser vault. The separate router case verifies both backends across restart and preserves credential bytes, counters and signatures.

These are synthetic-account/file/site tests, not official account login, physical Windows Hello hardware, real cloud account or every-site certification. Static equivalence complements runtime regression; it is not a claim that all possible bugs have been excluded. Native Host, Wi-Fi and Windows Hello remain optional; MDBX retains the bundled browser backend and existing source bindings.
