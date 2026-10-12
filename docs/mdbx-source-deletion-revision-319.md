# MDBX source deletion revision fence

Cross-vault MDBX moves now persist a separate source-deletion intent before deleting native records. This closes the interval where source attachments could change without changing the selected Object heads. It also provides the deletion primitive required for the remaining MDBX-to-Bitwarden move integration; that destination remains copy-only for native sources in this block.

## Behavior

- Before preparing a new deletion, authenticate the source vault ID, capture its complete write revision, recheck source Object heads, and reread source attachments against the saved destination attachment proofs. Recheck the revision after those reads. Changed content or a changed attachment manifest stops preparation.
- Save the revision and deterministic deletion scope inside the encrypted move journal. Source snapshots, dependency closure and pending local edits/conflicts are checked under the vault mutation lock before staging this intent and before deletion.
- Send the saved revision as the Native Host transaction precondition. A later source commit rejects the entire deletion, even if Object heads are unchanged. Retrying never replaces the saved revision with a newer one, including when the original attachment bytes have been restored.
- After a successful native delete with a lost reply or failed local adoption, keep the same intent and recover its committed receipt. Recovery verifies the target again but does not reread already-deleted source Objects or attachments. The source group is deleted in one native transaction, bounded by the existing 50-Object limit.
- Old, already-committed group deletions retain their original scope. A separate legacy receipt can only replay the matching authenticated commit. An unknown legacy scope is upgraded through fresh source verification; a known but uncommitted result stops without issuing a new unguarded delete. Damaged or future intent data is rejected without dropping its journal.
- Source sync cannot overwrite the recovery snapshot while a move is pending. The background checks before starting ordinary MDBX sync, and the encrypted service independently rejects source adoption during pending recovery.
- Existing same-vault moves, local-source moves and copy behavior remain covered by regression tests. Credentials, private-key bytes and the intentional zero-counter policy are unchanged. The unused native single-delete fallback now refuses to bypass durable finalization.

## Verification

- Full unit suite: **3,347 tests in 284 files passed**. The earlier targeted run also passed 856 tests in 62 files. Added cases cover the revision fence, changed source files and dependencies, failed intent persistence, immutable encrypted intent after unlock/restart, source-sync protection, legacy committed/ambiguous receipts, response identity and lost-reply recovery.
- Production build, project and interop type checks, strict standalone browser-test types, and the 217-command output security audit passed. The original `dist` contains this build at 0.1.37.
- Installed Edge: **three final cases passed** on the same build: local-source Bitwarden move (37.9s), native MDBX-to-Bitwarden copy (41.2s), and native password-history loss prevention/restart (13.9s). The first two retain the real browser-created key and independently verify fresh-client assertions against its original public key, plus attachment bytes and project fields.
- The initial browser run had two Passkey waits time out while the full unit suite was also running. Both passed on the same build afterward with unchanged assertions; this does not establish a precise cause for those initial timeouts. The history test expected an old button name; its locator now matches the existing “skip restricted items and continue” button and still requires it to be disabled when all items are blocked. Failure traces are retained. Native Messaging registration was restored after each native browser case.

Evidence remains local under `.artifacts/mdbx-move-revision-*20261012*` and `.artifacts/mdbx-source-delete-native-*20261012*`.

The new native test imports an explicitly selected, hash-verified historical synthetic fixture into an isolated Native Host data directory. It creates synthetic records and a file, confirms that replacing only the file leaves the Object head unchanged, and observes a real `vault-revision-conflict` with no Object deletion. Restoring the old bytes still cannot reuse the stale revision. A new verified operation commits, deliberately loses its reply, closes the native process, reopens the same working vault, and recovers the exact saved scope and one deletion commit. Unrelated native data and the input fixture remain unchanged. This is native primitive evidence, not current Android or full Bitwarden-move acceptance.

The first native test attempt had an invalid synthetic writer payload missing `monica_entry_id`; the production Host correctly refused it. That fixture was corrected. Type checks also caught missing explicit test array/function types; those were corrected before building. Earlier failure evidence is retained.

## Remaining work

Wire this durable deletion intent into the Bitwarden batch journal and runtime, including source-provider operation locking, full native dependency membership, pending-source protection, and restart recovery after the native delete. Keep remote sources copy-only there until this full path is verified. Explicit keep-both resolution for changed-source moves, other backend move adapters, the remaining rich-field/history/association matrix, live OneDrive/current Android/F-Droid/system Credential Manager acceptance, and nearby transport/recipient consent remain open.

No Android edits/build/device operations, real accounts, user Chrome, outgoing messages, publication, or cache deletion were performed. Development version remains 0.1.37.
