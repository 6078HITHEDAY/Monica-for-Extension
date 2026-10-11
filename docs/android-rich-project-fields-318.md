# Current Android rich password project roundtrip — 2026-10-09

The ordinary Android 1.0.318 writer, actual Edge extension and Android Compose editor passed one complete MDBX project roundtrip. Three passwords in two credential groups retained their fields, stable native identities and raw credential metadata through edits on both clients and browser restarts. This is a focused MDBX acceptance result, not completion of the full backend/type/lifecycle matrix.

## What was exercised

1. Android's actual `PasswordViewModel.savePasswordsAcrossTargets` created a project in a synthetic native MDBX database, followed by native reopen and encrypted backup.
2. Edge imported that backup through the real password-source UI and Windows Native Host. Its project editor changed the primary group's shared username, cleared the project's email and changed only the selected password's protected Recovery field.
3. Every native payload property was compared with the Android original plus those explicit edits. Edge then closed completely, restarted, unlocked the source, compared the payloads again and exported the encrypted database.
4. Android imported that file, displayed `PasswordDetailScreen`, used `AddEditPasswordScreen` to change the shared username again and saved through the real view model. Native reopen and comparison found **zero unexpected differences**.
5. A fresh Edge profile imported the Android return, verified the complete native records and two-group editor, then restarted and verified the same records again. The 320px editor screenshot was inspected.

The initial creation uses the Android business writer rather than simulating every creation-form interaction. Android editing uses the actual Compose screen and save action. Browser import and editing use the actual UI; export uses the extension's authenticated Native Messaging-backed export commands.

Fixture fields include two primary passwords and a recovery account, OTP, multiline websites, whitespace/CRLF/TAB/Chinese notes, full address/contact/payment/application fields with leading zeros, protected and duplicate-name custom fields, a future content-order token and the exact `futureCounter:9007199254740993` text inside credential metadata. Clearing email was checked on all three members. The unedited sibling's custom fields and passwords stayed intact.

Android remapped three local `room_id` values when saving its local projection. These are recorded individually in `roomIdChanges`; stable `monica_entry_id`, group/password IDs and every other native property are compared without exemptions. No Passkeys were changed or exercised in this password-field fixture; their deliberate zero-counter policy is unaffected.

## Runtime provenance

| Layer | Exact tested identity |
| --- | --- |
| Extension | Current uncommitted 0.1.37 `dist`, repository HEAD `18dd08d79a5ac454cac5512f85e0dbf55141e395` |
| Browser | Actual Microsoft Edge `154.0.4258.62`, visible isolated profiles, no Chromium fallback |
| Native Host | SHA-256 `781fa5b077ff2f3b5d8ecdb392d26b42dfe865c480bc82c8e00b55f17eee6df5` |
| Android runtime | Ordinary source `d7702cac415af9ca02318971aa33d61d8ec30ab8`, `1.0.318-26100912-03`, APK SHA-256 `b6a3ab4d75234caafe928780be27b69c469fcfee6e950368015108c2defe223f` |
| Instrumentation | SHA-256 `cf11a6e2f053191d6ed93c3711bce09c4df5da549419ac9a742f330d3431c98a` |
| Device | Shared `Monica_Issue136_API_32`, `emulator-5554`, Android user 0 |

Instrumentation was compiled against ordinary source `83664b96995d3d4ba7ecc6ad705b6716ac594431`, app build36 SHA-256 `d7958b594e320bd030fc9341e85c00a9f97e12378bb509f517c54eb4d55855a7`. While compilation was interrupted, another task installed the newer build03. The compile APK was **not** installed over it.

The separate `runtime-evidence.json` links the actual newer APK to that task's successful device record and the exact reviewed source difference: `VaultOverviewConfig.scope` changed from `local` to `all`, with two comment lines. Password APIs, model, editor and native writer remained identical. `scripts/interop-project-fields-runtime.mjs` verifies this exact transformation, clean production sources, APK hashes and unchanged test sources. The runner rejects mismatched runtime/test/source evidence. Original compile evidence is retained unchanged; the two APKs are not represented as identical.

## Results and artifacts

- Android export: **1 test passed**, 49.645 seconds.
- Edge forward/edit/restart/export: **1 test passed**, 15.9 seconds (17.5 seconds including runner).
- Android actual detail/editor/save/native reopen: **1 test passed**, 55.068 seconds.
- Fresh Edge return/editor/restart: **1 test passed**, 8.9 seconds (9.5 seconds including runner).
- Browser console errors: zero. Temporary Native Host registrations restored in both browser runs.
- Strict standalone TypeScript check for the new browser test and `git diff --check` passed. This batch changes acceptance tooling only; it did not require another production extension build.

Raw Android evidence, encrypted databases, JSON comparisons, current package baseline/restoration and the inspected Android screenshot are in `.tmp/android-project-fields-318/`. Logs are `.artifacts/project-fields-{install,export,import,edge-forward,edge-return}.log`. Browser evidence and inspected return screenshot are in `.artifacts/project-fields-edge-forward/` and `.artifacts/project-fields-edge-return/`.

The first Android compile failed because `JSONObject.valueToString` is unavailable on Android; its test-only replacement compiled successfully on retry (9m37s). Both logs remain. The targeted test APK inherits unrelated test-manifest provider declarations; logcat contains a missing `KdbxDeleteTestProvider` warning/crash in the auxiliary test-package process. The actual target-package instrumentation completed and the Compose screenshot/save/readback passed. These timings are harness timings, not application performance measurements; a minimal targeted test manifest remains a tooling follow-up.

Only the instrumentation APK was temporarily replaced. Its **current** pre-run baseline SHA-256 `980efe819f16d679356af70fc70f0e66da67718396c18cd7b906ff184682ecba` was restored and verified, with the newer application APK unchanged. Older pre-interruption package snapshots were not restored. No app data clear, Android product edit, release/tag/push or cache-deletion retry occurred.

Remaining scope includes current F-Droid runtime, other storage backends and types, project lifecycle operations, Android KDBX grouping repair scope and actual OneDrive OAuth/account acceptance. The [GitHub Passkey/performance user confirmation](github-passkey-performance-2026-10-09.md) and [rounded controls/search design](rounded-controls-and-wallet-editor-318.md) retain their separate evidence.
