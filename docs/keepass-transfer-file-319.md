# KeePass batch file preparation and durable receipts

Date: 2026-10-11. Extension development version: 0.1.37, unreleased.

This block supplies the encrypted-file transaction needed by KeePass transfer destinations. It does **not** expose KeePass as a destination in the manager yet. Publication, vault adoption and the shared transfer coordinator still need integration.

## Behavior

- Prepare against the exact persisted target SHA-256 in a disposable KeePass session. Reject unpersisted live edits, stale source fingerprints, incomplete native password projects, duplicate native identities, target/source replacement and locking. Preparation leaves live sessions and source files unchanged.
- Local files reuse credentials inside their unlocked session. Remote-file preparation accepts internal credentials; key-file and temporary file buffers are cleared. The draft is an internal authenticated-resource contract, not a manager message carrying secrets.
- Copy native entries with raw/protected fields, binaries, full entry history and custom metadata. Restore metadata omitted by the library's copy helper. Derive new native entry/project identities from the operation, remove old Android Room IDs, and preserve credential bytes, private keys, counters and backup flags. Same-file moves retain native entry and project identities.
- Preserve source-scoped folder ancestors, including slash-containing names and separate same-named folders. Reject conflicting deterministic identities and recycle-bin targets.
- Foreign sources must provide an authenticated attachment catalog, including an explicit empty catalog. Validate names, exact sizes and SHA-256, with a 16 MiB aggregate limit. Convert portable password history into native history. Reject fields the target codec cannot represent rather than silently dropping them.
- Refuse native 4.1 metadata/icon downgrades and conflicting custom icons. Do not automatically upgrade the target file. Foreign moves remain unavailable until durable source deletion is integrated.
- Atomically save encrypted file bytes and an encrypted `batch-transfer` receipt through existing compare-and-swap storage. Validate one-to-one source/target/native mappings. A retry can recover the mapping after complete browser restart without unlocked source sessions. It does not rewrite the file or resurrect later deletions. Existing expired-operation markers prevent execution after receipt retirement.

## Native field-reference fix

Real `KdbxUuid.toString()` values use base64, whereas standard `{REF:U@I:…}` references contain hexadecimal UUIDs. The resolver previously compared incompatible representations. Normalize base64 UUIDs before case folding so real native references resolve correctly. A test using an encrypted KDBX proves both original resolution and copying of linked entries.

Native copies rebind selected UUID references to copied identities, including history, while retaining field protection. Same-file references to unselected surviving entries remain intact. Cross-file copies with missing reference dependencies and ambiguous name-based references are rejected.

## Verification

- Final related regression: **688 tests in 46 files passed**, covering KeePass codecs/provider/writer, references, transfer preparation, local/remote persistence, durable synchronization, receipt encryption/storage, project removal/restore and OneDrive KeePass sessions. Evidence: `.artifacts/keepass-transfer-final-regression-20261011.log`.
- The new transfer suite contains 24 cases: native and portable data preservation; local, WebDAV and OneDrive working-copy persistence; failure before/after commit; stale revisions; restart recovery; later deletion; same-file moves; unsupported metadata; folder identity; missing members; source/target locking; attachment corruption; field-loss refusal; and a real signature made with a copied zero-counter Passkey.
- Production build and project TypeScript passed, including 236 bundled icons and three extension pages. The original `dist` was rebuilt. Evidence: `.artifacts/keepass-transfer-file-build-accepted-20261011.log`.
- Standalone E2E TypeScript passed: `.artifacts/keepass-transfer-file-e2e-types-accepted-20261011.log`. An earlier command failed because PowerShell split unquoted comma-separated compiler arguments; the corrected command quotes both lists.
- Unchanged security audit passed for 213 runtime commands. No new runtime command is exposed by this block.
- Final installed Edge acceptance: **3 cases passed in 30.6 seconds**. The new production-module harness uses real Argon2id KDBX and IndexedDB; it aborts after a queued file write, simulates a lost commit response, fully restarts Edge without a source session, recovers the receipt, verifies exact attachments/protected fields/project rebasing, then proves retries preserve later deletion. Existing storage migration/retirement and a built-extension case with 257 runtime mutations also passed. Evidence: `.artifacts/keepass-transfer-final-installed-edge-20261011.log`. The new harness is a synthetic-origin file/persistence test, not manager UI or cloud acceptance.
- An earlier combined run inadvertently selected a legacy grouping test hardcoded to bundled Chromium. That synthetic-profile test passed but is excluded from Edge acceptance; the combined run was interrupted and replaced with explicit installed-Edge tests. No user browser profile or account was accessed.

Earlier fixture/type/checkpoint failures remain in local evidence logs. They were corrected without weakening assertions: explicit KDBX minor version, typed rich-field fixture, stable empty-group defaults, protected-key presence and owned ArrayBuffer conversion.

## Remaining integration

KeePass destinations still need shared transfer preview/runtime/UI, complete foreign dependency selection, authenticated-resource handoff, conditional WebDAV/OneDrive publication, reload and atomic adoption against the full encrypted vault. A persisted file receipt alone is insufficient proof of completion for those workflows. Bound note/OTP links without a KDBX carrier remain rejected. No real cloud-account or current Android/system acceptance is claimed for this new flow.

Full Android parity remains active: KeePass and Bitwarden transfer destinations, shared Cipher lifecycle, durable foreign moves, the rich-field/backend acceptance matrix, direct OneDrive/current Android checks, and nearby-device synchronization with per-recipient Passkey consent remain open. This block makes no Android changes and performs no release, push or tag.
