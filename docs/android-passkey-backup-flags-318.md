# Android Passkey backup flags — work in progress

## 2026-10-10 later Android review supersedes the frozen builds

The Android task found and repaired an uncovered refresh boundary: an existing NULL eligibility value already means BE=true for signing, so refreshing that credential must reject incoming BE=false. The earlier 37-test frozen build accepted that transition. Its results remain historical evidence and must not be used as the current application for system acceptance.

The user separately authorized the Android task to repair shared Bitwarden Cipher uploads and add portability labels. That work is now implemented in both variants, including guarded original-document merge, explicit folder-move intent and local/remote conflict handling. Its report records 52 unit tests and 12 API32 instrumentation tests per variant, with successful builds. This task checked the report's listed source hashes against current files and inspected the final logs. The instrumentation uses synthetic MockWebServer data; actual browser↔Android transfers and Android14+ system Credential Manager acceptance remain open. KDBX project-grouping scope is separate.

Current report: `../Monica-main/Monica for Android/docs/PASSKEY-COMPATIBILITY-VERIFICATION-2026-10-10.md` relative to the extension root. Evidence: workspace `.codex-tasks/passkey-fix-20261010/verification.json`. Refresh the application/source/API provenance from this current implementation before continuing; do not install the older `.tmp/android-backup-flags-318/system` build as if it contains these repairs.

2026-10-10. This follows the previously authorized backup-metadata repair, separately from the pending Bitwarden whole-Cipher upload and KDBX project-grouping proposals. The first implementation is present in ordinary Android and F-Droid. Build, migration and runtime acceptance are still in progress; this is not a completed compatibility claim.

## Evidence and compatibility rule

The current Android helper produced `0x1d` for imported MDBX credentials whose explicit backup flags required `0x05` or `0x0d`. See [the unchanged failing runtime evidence](android-passkey-current-runtime-318.md). `PasskeyAuthActivity` hard-coded BE and BS. `PasskeyEntry.isBackedUp` is a device-local backup marker, not the WebAuthn state that was signed at registration, and cannot safely replace those constants.

The new nullable `backupEligible` and `backupState` fields separate these meanings. Room migration 79→80 only adds nullable columns. It does not change existing IDs, private-key references, public keys, counters, usage, local backup markers or other columns. A legacy null/null record retains Android's historical BE=true/BS=true behavior. Explicit false remains false. BS=true with BE=false is refused before signing. A known BE value cannot be changed during a same-credential refresh. The intentional always-zero signing counter remains unchanged.

New Android registrations persist the true/true values already emitted by their attestation. MDBX reads/writes and export/import projections, Android ZIP backup, Monica KDBX payloads and KPEX-only imports carry explicit values. KDBX updates derive their flags from credential metadata rather than `isBackedUp`. Legacy Monica KDBX payloads without these fields keep the old signing behavior even when older KPEX fields were derived incorrectly from the local backup marker. Deduplication includes the flags so conflicting metadata is not silently collapsed.

Native Bitwarden and CXF do not carry a false BE flag. Exporting a backup-ineligible credential through those representations is rejected/skipped by their existing failure/reporting paths, rather than changing its immutable BE value. Ordinary legacy and BE=true credentials retain their existing behavior. This is an explicit remaining format limit, not a new cross-client metadata protocol. It does not repair the pending whole-Cipher overwrite bug.

## Verification being completed

- Both variants have regressions for old null records, all three valid flag pairs, the real authenticator-data helper, invalid combinations, KDBX payload/native fields and original key bytes, refresh conflicts and the Bitwarden boundary.
- Migration tests retain legacy row values and distinguish Room null from false; they run on an isolated SQLite/Room database, not the shared AVD's app data.
- The initial frozen-source build was started before the additional native export/dedup guards. Its manifest is a distinct intermediate snapshot; only a later snapshot containing those guards can establish final-build coverage.
- Initial ordinary-app build completed successfully in 19m26s; its 36 tests in 11 selected classes passed. This intermediate snapshot is archived separately under `main-initial`.
- Final ordinary and F-Droid application/instrumentation builds both passed (12m53s / 34m21s). Each final variant passed **37 tests in 11 classes**, with zero failures/errors/skips. Final verification hashes all 3,134 ordinary and 3,477 F-Droid snapshot files and finds no differences from their current source directories. Reports: `.tmp/android-backup-flags-318/main-final/verification.json` and `fdroid-final/verification.json`.
- Exact final ordinary-APK reuse and compile-API verification also passed when building system-seed instrumentation (1m10s). Its report is `.tmp/android-backup-flags-318/system/build-evidence.json`; the final APK is schema80. Build sessions 54965, 3164 and 32136 are terminal. No system runtime or F-Droid runtime acceptance is implied.
- Source baselines are under `.tmp/android-backup-flags-318/source-baseline/` and `source-baseline-followup/`. Initial build manifests and logs are in that batch directory and `.artifacts/android-backup-flags-*`.
- No new application has been installed on the public API32 AVD. Previous APK/source reuse proofs predate these product edits and must not be reused for the modified application.

Full system Credential Manager and current Android↔Edge file roundtrip acceptance remain necessary. Existing Bitwarden failure results, OneDrive real-account acceptance and the broader password-project matrix remain open. No version bump, release, push, or APK delivery is part of this batch.
