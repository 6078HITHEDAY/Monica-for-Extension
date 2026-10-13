# Bundled MDBX application integration — 0.1.37 development

The normal extension build now includes the pinned MDBX WASM engine and authenticated offscreen Worker. The actual manager creates Sky password databases, imports local MDBX/complete backups, exports backups and reopens browser working copies after a full browser restart. These operations no longer require a separately installed Native Host.

## Ownership and security

New accounts record `runtimeBackend: browser` inside the encrypted vault. Existing accounts without this field continue to mean native storage; existing handles, record identities and pending operations are retained. A synchronous projection of the already authenticated account snapshot can restore a missing ownership index. Invalid metadata, conflicting account/index ownership and attempts to switch an existing vault's backend fail closed. The projection performs no storage I/O and cannot reenter the vault's exclusive mutation queue.

Background create/open operations require an unlocked session and verify that session when saving the account. Failure to save locks the opened database. Creation is not automatically replayed. Each provider checks its own backend availability; an unavailable native helper cannot relabel every browser database unavailable. Status requests retain active connections. The ordinary runtime listener leaves authenticated MDBX control traffic to the dedicated handler. The offscreen page and engine are not web-accessible resources.

The engine uses the existing [durable storage](mdbx-browser-durable-engine-319.md), [offscreen ownership](mdbx-browser-offscreen-320.md) and [legacy routing](mdbx-browser-routing-320.md) boundaries. This block does not change credential IDs, private-key bytes, deliberate zero counters or existing positive counters.

## Build and interface

`npm run build` verifies the pinned source/artifact inventory before copying the engine, WASM, provenance and Rust dependency notices into `dist`. Notices describe 133 source dependencies, including build tools; they do not claim that all of them are linked. Release packaging requires these assets and checks references in all four extension pages. Local development package verification supports an explicit output directory so published artifacts are not overwritten.

CI has pinned source-build setup for Rust 1.97.0, Emscripten 4.0.18 and emsdk commit `eb5eb4b3b2b792f44ded198bfe615c985da5be2c`. Local workflow policy validation passed; hosted CI has not run for this change. The native helper remains on its existing toolchain.

The new-source dialog offers creation, local backup and WebDAV in one select. The primary action stays outside the scrolling form. Source status explains whether the copy is stored in this browser or in the existing helper. All 21 added messages have English, German, Spanish, Japanese, Korean, Russian and Vietnamese catalog entries; Chinese uses the source strings. The editable M3E Canvas document, local link and screenshots remain local under `docs/design/mdbx-browser-320.*`; its editor is `http://127.0.0.1:5186/`.

## Acceptance on installed Edge 155.0.4283.45

All browser profiles, records and HTTP endpoints were isolated and synthetic. The no-helper scenario copied the actual production `dist` to a separate extension path and confirmed that Native Messaging reported `Specified native messaging host not found.`

| Scenario | Result |
| --- | --- |
| Production UI: create, write/read, status, export, lock, full restart, unlock and import exported MDBX | Passed, 8.9 s; no helper registration, no page errors; primary action visible at 390 px |
| Complete backup: password project, five original Passkeys and 3,145,801 attachment bytes; cancel, wrong-password retry, separate restore profile and restart | Passed, 28.1 s; 13 encrypted blobs; exact object/key/file readback and independent original RSA WebAuthn signature |
| Browser-created MDBX Passkey moved to Bitwarden with interrupted upload, deletion recovery and fresh-client authentication | Passed, 23.5 s; complete project and attachment readback; original key and zero counter preserved |
| Source page shape and icons; new/local/WebDAV mode switching | Passed, 5.9 s |
| Narrow manager dialogs with 200% text | Passed, 5.0 s |
| WebDAV join controls at 800 px with 200% text | Passed, 2.4 s; layout only, not a cloud-sync claim |
| Real native/browser router coexistence, IDB abort/collision/corruption and restart | Passed, 8.3 s; original signatures and counters 0/19; temporary native registration restored |

956 distinct affected unit tests across 70 files passed after updating the account-projection expectation and rerunning all 55 vault-service cases. The 28 locale checks passed again after completing translations. Project/interop types, strict types for all changed E2E files, production build, engine provenance, workflow policy, 219-command security audit and `git diff --check` passed.

The initial acceptance failures remain in local evidence: the complete-backup test still inspected the old Native Host scratch directory, a layout assertion compared an 820 px width without subpixel tolerance, and an old settings check expected cards instead of the current grouped rows. Tests now check the actual browser catalog for released backup scratch paths, use 0.01 px tolerance and verify the grouped outer corners. No backup, signature or layout assertion was removed to obtain a pass.

Local evidence: `.artifacts/mdbx-browser-app-20261015/{acceptance,acceptance-repair,visual-final,final}` and adjacent `mdbx-browser-app-*-20261015.log` files. A local development package with 1,140 files passed hash, inventory, content and two independent byte-identical packaging checks. Its SHA-256 is `0b0c193637ff94d304cce7d71baa66e04f53917af443e7bbfe0b88b0670a3e8e`; it records the pre-commit dirty source state and is not a release.

## Remaining acceptance

The subsequent [WebDAV recovery acceptance](mdbx-browser-webdav-recovery-320.md) completes production browser-engine synchronization, its tested fault cases and manager coexistence with an unavailable legacy helper. Task 63's bundled browser-engine scope is complete. Historical Android-generated fixtures establish file compatibility, not current Android application acceptance. Actual current Android/F-Droid, direct OneDrive and the remaining cross-backend field/Passkey matrix still need acceptance. Nearby application mapping, consent and adoption remain separate unfinished work. Existing helper copies are not automatically migrated. No Android edits/builds/device operations, user Chrome/accounts, publication, tag or cache deletion were performed.
