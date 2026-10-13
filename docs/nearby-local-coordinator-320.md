# Nearby local session coordinator

Follow-up: production ownership and immediate lifecycle cancellation are now implemented and verified in [Nearby production manager ownership](nearby-manager-owner-320.md). The earlier evidence and historical boundaries below describe the original coordinator block.

Internal implementation, 2026-10-15; extension development version 0.1.37. This block connects the encrypted local store, consent, authenticated Native Messaging transport and durable acknowledgements. It does not expose nearby synchronization in the extension UI or establish current Android application acceptance.

The coordinator owns a dedicated native port. Pairing uses a temporary empty native journal with Android's `pairing-only-v1` revision and never captures password content. Only two authenticated pairing-only snapshots bypass application merge. Content transfers still require native merge and complete local adoption before success is acknowledged. Receive-only sessions also use an empty snapshot; pending recovery cannot accidentally export unadopted remote changes.

Trusted connections reconstruct their invitation from the saved device key and a validated private/loopback IPv4 endpoint. Caller-supplied replacement keys are not accepted. Status excludes native handles, replica credentials and saved trust keys; temporary pairing codes/invitations are visible only during enrollment. Remote identity, content version and pairing mode are checked before adoption or trust changes. Old hosts reject the new empty-snapshot operations before opening a network session.

Every native operation checks the current vault session and preference epoch. Disclosure and adoption also verify the full local source hash. Restricted-Passkey consent is bound to the recipient, source, operation and session; positive-counter credentials remain excluded from native export. Original credential IDs, private/public key bytes, deliberate zero counters and positive history are retained. Initialization cannot resurrect a cancelled operation, and a new unlocked session discards old native ownership.

`close()` synchronously aborts the dedicated port and clears consent and session state. The eventual background owner must invoke it on lock, preference changes and manager disposal. There is no background owner, automatic polling or runtime command in this block: checks reject a changed session at the next operation, but UI-level immediate cancellation is still part of the pending production integration.

## Adoption and recovery

- Collect stable native pages before mutating: at most 256 records per page, 20,000 pending records and 48 MiB of record JSON. Native requests are split at 256 entries / 6 MiB.
- Resolve authenticated native aliases before grouping note, SSO, OTP and password-project dependencies. Complete connected components share one encrypted transaction; a component above the existing 200-record transaction bound fails before partial adoption.
- Download only assets needed by records without saved receipts. Assets are independently verified; each batch has the existing 16 MiB per-file, 32 MiB total and 512-asset bounds.
- Encrypted adoption returns its acknowledgements and the resulting source hash from the same exclusive transaction. The next batch cannot silently rebase onto an intervening user edit.
- Reopen the durable native replica and replay exact encrypted receipts before reading remote scratch files. If unapplied records remain, force a receive-only retry and finish their adoption before allowing export.
- Update existing records through authenticated native local IDs and guards. Unchanged linked records resolve through native bindings; no title matching or duplicate replacement items are used.
- Normalize legacy implicit local scopes so received links still resolve. Exact guard comparison also accepts the two equivalent pre-normalization spellings (`[]` and a bare `local` provider reference) while keeping every other field and attachment byte guarded. Source hashes still reject concurrent edits. External provider bindings and references containing other metadata are not rewritten.
- Preserve login-side OTP backlinks when only the login changes; changing/deleting an OTP clears its previous owner's backlink before binding the new owner.

## Validation

Real installed Edge 155.0.4283.45 passed both final scenarios in 47.6 seconds, using two isolated browser profiles, actual Native Messaging/Noise transport, production coordinator source and encrypted IndexedDB storage:

1. Pair with no source-content capture; transfer six records and a 600,000-byte attachment while retaining a positive-19 credential only at the source. Lose the actual persisted local-save response before native acknowledgement; restart both browsers and native processes; recover receipts; propagate a later edit back into the original local item. Verify note/SSO/OTP links, original credential/private/public bytes, attachment hash and a signature with the original key. Counters remain source `[0, 19]`, receiver `[0]`.
2. Transfer 306 records from 307 source items. Lose the persisted response after the first 200-record batch. After both-browser restart, replay 200 receipts and recover the remaining 106 records through receive-only transfer. Then edit 300 received entries and synchronize them back across multiple batches and legacy-scope normalization, retaining all original source IDs and previously created target IDs. Repeat project, attachment, key-signature and counter assertions.

Evidence resides under `.artifacts/nearby-coordinator-20261015/final/` in each scenario's `evidence.json`. Each explicitly records `managerUi: false` and `androidApplicationAcceptance: false`. Native registration is restored and no page errors occurred. Earlier successful paginated/recovery runs and the first failed association run are retained separately.

All 82 Host tests and strict Clippy passed. The final affected JavaScript suite passed 247 tests across 13 files with two workers. Project/interop types, strict affected E2E types, the normal build, bundled-engine provenance and the runtime security audit (219 commands, 24 manager-only) passed. Logs are retained under `.artifacts/nearby-coordinator-*-20261015.log`. Nearby is excluded from the browser WASM compilation; the bundled engine was rebuilt with its original cache to refresh the full Host-source provenance inventory. Unrelated rustfmt-only changes were verified against formatting of HEAD and removed. The normal `dist` build is updated; existing bundle-size warnings remain.

Failures kept as evidence: the first real reciprocal case exposed lost note/OTP links, fixed by local-scope and backlink handling; a targeted regression reproduced a later-batch stale-guard failure after scope normalization and now passes; the highly concurrent unit run timed out in the existing large-asset test, while the same 244 tests passed with two workers; the icon inventory scanner mistook a TypeScript method-name type literal for a new icon, corrected by using the existing operation type directly. No font or UI change was needed.

## Remaining integration

Read-only Android source baseline remains `c791b28f3a39b814c5dde28f51f2eeb3349322e1`, development 1.0.320. The empty-snapshot revision follows its pairing snapshot contract; this is not Android/F-Droid application or system Credential Manager testing.

Complete native MDBX catalogs and adoption, folder/root metadata, archival local-origin records, conflict/restore handling, production background ownership/cancellation and local-Canvas-designed settings/interaction flows remain unfinished. Current Android/F-Droid and direct OneDrive/backend acceptance also remain open. Ordinary MDBX local/WebDAV access is already helper-free; LAN sockets for this internal nearby implementation still require the dedicated native transport. No Android operation, user Chrome/account/vault access, publication or cache deletion occurred.
