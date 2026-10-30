# KeePass sources moved into Bitwarden

Development build: 0.1.37, 2026-10-12. This extends the source-removal foundation in `keepass-source-removal-319.md` and the native conversion limits in `bitwarden-keepass-source-319.md`. It does not establish complete Android parity.

## Behavior and preservation

The existing batch dialog now accepts eligible KeePass local-file, WebDAV and OneDrive sources for moves into a personal Bitwarden vault. Every selected entry from the same KDBX is one file transaction. The preview verifies the complete native project and relation closure, source fields/history/files and destination representation. A rejected conversion blocks that source file's entire selection. Selecting the same physical file through multiple accounts is rejected.

Destination Ciphers and attachments are written and independently authenticated before source removal is authorized. Whole original KeePass entries move to the native recycle bin with their UUIDs, original private keys, credential IDs, zero or positive counters, history and binaries retained. The source KDBX and encrypted receipt commit together. Cloud publication uses a version precondition and exact-byte recovery; this move path does not automatically rebase over another device's edits. Local working copies must still be exported and saved by the user.

A fresh destination readback precedes final atomic adoption of all target items and removal of the source index bindings. A Passkey's Bitwarden parent Login projection can add an extra destination row without creating an extra Cipher or changing the transferred credential. No signature counter policy was changed.

## Durable recovery and concurrency

- Version 5 journals store per-file source identity, source snapshots, input file/native hashes, destination fingerprints, immutable deletion authorization, encrypted file receipt and publication confirmation.
- Version 6 records an explicit keep-both decision before any native deletion authorization. The reviewed destination version is completed as a copy while current source edits and pending mutations remain intact. Earlier journal versions retain their existing behavior; older readers reject the new versions rather than ignore the decision.
- Fresh target verification runs before authorization, before local file removal and before final adoption. Lost file replies, failed receipt saves, failed cloud publication or failed target adoption resume the same operation. Recovery does not refresh the source deletion request to match changed content.
- A persisted file receipt is recovered without requiring a live source session. When no receipt exists, the source is reopened outside the encrypted-vault mutation lock before proceeding. OneDrive token refresh/checkpoint updates retain stable file/account identity and cannot replace the account.
- Provider queues include known aliases of the same file, then KeePass mutation queues in the same order. Pending moves block source sync, direct writes, source replacement and provider removal. Source snapshots are frozen after deletion authorization, including edits through import and other general vault operations.
- Local reopening authenticates the picked original/exported file and restores the durable working copy without flushing a stale session over it. Remote restore remains available. A rejected provider removal cannot delete the working-copy database first.
- Explicit null, malformed, downgraded or incomplete journals fail closed. Publication must identify the exact file from the removal receipt. External restoration or remote changes retain the pending operation and destination copies instead of finalizing or overwriting the source.

Newly created KDBX entries leave optional foreground color, background color and URL override values unset in memory; reloading empty XML nodes yields empty strings. The native-content comparison now treats those forms as equivalent. Nonempty values remain in the content proof. Equivalent older indexed database scope, derived Passkey labels and hidden-field types are accepted through the existing authenticated native reader; field values and protection are still checked.

## Validation

The consolidated checks cover 3,473 distinct tests across 288 files, including 25 new move/recovery cases and three additional file-layer regressions. One earlier full run passed all 3,471 tests. After the two live-entry hash regressions and UI text changes, the final suite passed 3,443 cases and identified 29 locale-catalog failures plus one existing five-second project test timeout. All 46 cases in those three affected files passed after completing the six locale catalogs and rerunning without competing browser work. The earlier unconstrained parallel run also produced timeouts; no product check was weakened to hide them.

Project and interoperability types, strict E2E types, production build and the 218-command security audit pass. The build retains existing large-chunk advisories. An icon inventory false positive treated the internal literal `target` as an icon; the validation-only placeholder was renamed without changing the font.

Installed Edge 155.0.4283.45 uses isolated profiles and synthetic accounts/files. Acceptance covers the existing KeePass copy plus local KeePass move, keep-both after a source edit, and WebDAV KDBX move. The fixture creates a real browser Passkey, two-password project and encrypted attachment, loses a successful Cipher response, closes the entire browser and resumes the same operation. The cloud case additionally loses the successful KDBX PUT response, rejects provider removal while pending, restarts again and confirms exactly one successful removal upload. Exported/native source entries remain in the recycle bin with original key and file bytes. A fresh independent client reads the project/attachment and produces a WebAuthn assertion independently verified against the original public key with zero counter unchanged.

Evidence is retained under `.artifacts/bitwarden-keepass-move-*20261012*`, with browser acceptance in `bitwarden-keepass-move-edge-final-20261012`. Initial browser failures exposed the empty-value comparison bug and the fixture expecting a generic source-change message instead of the earlier pending-mutation rejection. One concurrent test attempt failed to see the registration chooser within five seconds; this is retained as intermittent latency evidence rather than claimed as solved by this block.

The existing dialog layout is reused, with supported-source and recycle-bin/export text updated in all seven translated catalogs. The local editable M3E Canvas document is `docs/design/bitwarden-keepass-move-319.m3e.json`, with its loopback link in the neighboring Markdown file. Sketches and screenshots stay local.

## Limits and remaining work

The existing native conversion restrictions remain: unsupported complete-history snapshots, fields, policies, associations or opaque native metadata stop the affected file selection. Post-deletion manual conflict resolution/keep-both is not added; changed source files remain protected with pending recovery records. Other source/destination move combinations remain separate work.

WebDAV acceptance uses an actual local HTTP server. OneDrive file persistence and token-rotation recovery are covered by synthetic adapter tests, not a live Microsoft account test. Current Android/F-Droid and system Credential Manager acceptance, nearby-device transport, per-recipient consent and the broader field/history/association matrix remain open. No Android source/build/device operations, user Chrome or real accounts, outgoing messages, cache deletion, push, tag or release were performed.
