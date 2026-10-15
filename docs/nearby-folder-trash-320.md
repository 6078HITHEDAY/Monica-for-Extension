# Wi-Fi retained folder trash — 2026-10-15

This browser-only checkpoint adds retained folder deletion to the extension's bundled MDBX engine and optional Native Host. It follows existing Android wire records (`deleted`, `trashed`, and empty purge payloads). It does not change the Android application, LAN protocol, database schema, Passkey material or counter policy. Full Wi-Fi/Android parity remains unfinished.

## Behavior and compatibility

The explicit `collection-trash` command preserves folder attachment rows, bytes and IDs. Ordinary `collection-delete` still refuses active attachments. Both reject active child folders and entries. Within a revision-guarded composite transaction, normal commands run first, attachment changes next, and retained folder deletions last. Failure rolls back the entire transaction. Replaying the original operation returns its receipt without undoing later restoration.

The new enum variant is appended, preserving prior variant indices. Its implementation is recorded as the seventh extension source overlay, `retained-folder-trash`, with baseline, patch and resulting source hashes. Existing command identities and native storage schema are unchanged. `supportsRetainedFolderTrash` advertises support; the adapter checks capabilities before saving an encrypted intent, and the writer checks again before native staging. Older engines fail explicitly without leaving a new recovery intent.

The extension's local folder marker distinguishes retained trash from permanent purge. Retained trash keeps exact wire metadata and file mappings; purge removes that owner's labels and file contents and projects an empty tombstone. Restoration after retained trash uses the original native file IDs. Restoration after purge can allocate a new native file ID while retaining the portable attachment ID. Other root owners and folders remain untouched.

The planner orders folder deletions child-first and restorations parent-first within one batch. It rejects live members or restoration under a deleted parent before persisting an intent. This is not acceptance of arbitrary hierarchy changes spread across separate coordinator batches; that scheduling work remains open.

## Verification

- All 102 native tests passed in 268.55s; all-target Clippy passed. New tests cover ordinary-delete refusal, attachment replacement plus retained trash, restoration and rename, lock/reopen, exact original receipt replay, and complete rollback when active child folders or entries prevent deletion.
- Bundled engine rebuilt with Rust 1.97.0 and Emscripten 4.0.18; WASM size 6,422,829 bytes. Debug Native Host rebuilt. Source/artifact provenance verified.
- 281 affected TypeScript tests across 15 files passed, covering retained trash, parent state, hierarchy ordering, capability refusal before journal persistence, metadata validation and existing adoption/security boundaries. Main, interop and strict affected E2E/worker types passed with the final production build. Security audit passed for 219 runtime commands, 24 project commands and the dedicated nearby port.
- Three actual Edge scenarios passed in 52.5s: native adoption/journal recovery (5.3s), production Wi-Fi coordinator (35.6s), and metadata/file forwarding (8.9s). Synthetic isolated profiles were automatically removed. The final targeted coordinator rerun after adding adapter capability preflight passed in 34.9s (runner 37.0s).
- Actual compiled-engine metadata acceptance covers two native vaults and encrypted local-vault adoption/capture. A 280,000-byte attachment becomes 180,000 bytes while retaining identity. Folder/root trash passes through native → local → native with full metadata and verified hashes; restore, purge, restore again and real browser restart retain the expected portable identities and readable bytes. Other root labels remain intact. Encrypted storage plaintext scans pass.
- Existing production coordinator coverage retains 142 records, a 40-record password group, a 600,000-byte attachment, original Passkey signature/counter zero, repeat-sync no-op and simultaneous listener discovery. The independent journal regression preserves counter 19.

Evidence: `.artifacts/folder-trash-native-full.log`, `folder-trash-clippy.log`, `folder-trash-browser-build.log`, `folder-trash-host-build.log`, `folder-trash-unit-final-2.log`, `folder-trash-production-build-final-2.log`, `folder-trash-e2e-types-final-2.log`, `folder-trash-security-audit-final.log`, `folder-trash-final-edge.log`, and `folder-trash-coordinator-final.log`. Per-scenario JSON evidence is retained alongside Edge outputs.

The parent-restoration red test is retained in `folder-trash-parent-red.log`. Type-check failures from optional parent IDs and a test union narrowing were fixed without loosening compiler settings. No user Chrome profile, account or vault was used. No Android sources, emulator state or previously denied cache paths were changed. Local `dist` includes this work; public 0.1.39 remains unchanged and no push, tag or Release was made.

## Remaining acceptance

Nested coordinator scheduling across batches, native collection profiles and unsupported schema/source archives remain open. Android/F-Droid attachment persistence and their UI/multicast acceptance are not claimed by these browser tests. The existing Android repair is owned by its main chat; subsequent extension work should adapt to Android and avoid unnecessary outgoing requests. Wider backend/OneDrive acceptance also remains open.

Follow-up: [bounded hierarchy scheduling](nearby-hierarchy-320.md) subsequently passed actual nested trash, restart restoration, moves and repeat-sync acceptance. The remaining list above records this checkpoint's original boundary; native profiles, archives and Android/F-Droid application acceptance are still open.
