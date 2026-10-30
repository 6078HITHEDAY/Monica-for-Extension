# Bundled MDBX engine: durable browser implementation

This is a completed internal engine block, not the finished no-helper user flow. The extension's normal `dist` still uses Native Host for MDBX. Background/offscreen ownership, legacy Native Host handle routing, account adoption, cloud acceptance and the database UI must be connected before enabling this engine.

The browser crate reuses the pinned MDBX FFI/storage/crypto and the extension Host runtime, cloud protocol and complete-backup implementation. The database format and cryptography are unchanged. A synchronous, bounded Rust ABI runs inside an exclusively owned Worker. Native sockets and Windows Hello are explicitly unavailable. Sky and Multi disclose records under their existing policy; Power creation/opening works but its existing policy denies sensitive disclosure in this browser context. No policy bypass or automatic downgrade was added.

## Persistence and failure behavior

- A Web Lock grants one session exclusive ownership of its database. A second Worker fails before loading it.
- MEMFS files under `/monica` are persisted as 64 KiB blocks. Stable file identities avoid copying content on rename. Write, mapped-write and truncate hooks track changes; read-only requests do not commit a new generation.
- The catalog and all changed blocks are committed in one strict IndexedDB transaction. The complete previous catalog is checked before replacement. A successful RPC response is withheld until transaction completion.
- Catalog validation rejects path traversal, duplicate file identities, orphan nodes, links, invalid sizes and incomplete block lists. SHA-256 detects missing/corrupt block storage; authenticated MDBX encryption remains the security boundary, not these catalog hashes.
- Caller-owned blocks are copied before asynchronous hashing. Temporary block copies are wiped after use. Startup restores only the committed catalog and verifies each block before passing it to the engine.
- Engine traps or storage failures invalidate the session. No mutation is automatically replayed. Closing suppresses pending sensitive responses and lets an already-running commit finish; the next session restores the committed generation.
- An abort callback only records failure. It never re-enters a borrowed Rust runtime or wipes an executing WASM stack. Cleanup happens after control unwinds. Rust ABI buffers and serialized response values are cleared after use.

The 2 GiB catalog bound is an upper safety limit, not a verified capacity promise. Startup still restores the stored files into Worker memory; large-vault memory/latency acceptance remains open. The engine must be kept in an appropriately managed offscreen Worker to avoid rebuilding it for every UI interaction.

## Browser-only filesystem adaptation

Real Edge acceptance exposed `tempfile::persist_noclobber` failing when backup publication attempted a hard link. Emscripten MEMFS does not support hard links. The browser crate therefore pins a local copy of tempfile 3.27.0 and enables `monica-private-memfs` only for its Emscripten build. It checks destination absence with `symlink_metadata` and performs a synchronous rename in the private, single-threaded filesystem. Existing files and links are rejected. This sequence cannot interleave with another filesystem writer; it must never be reused with a shared filesystem. The browser crate rejects WASM atomics. Native and Android dependencies remain unchanged.

`native/mdbx2-browser/TEMPFILE-PROVENANCE.json` records the verified crates.io archive SHA-256, every original source hash, and the two modified files. Both original licenses are retained. Build verification checks this inventory as well as the existing Android engine provenance.

## Reproducible build

The browser compiler is Rust 1.97.0 (`2d8144b7880597b6e6d3dfd63a9a9efae3f533d3`) with Emscripten 4.0.18. The previous feasibility report explains why Rust 1.86's Emscripten standard library is ABI-incompatible with this SDK. No global toolchain activation is required.

Load the local SDK environment, then run `npm run build:mdbx2-browser`. `MONICA_MDBX_BROWSER_TARGET` can reuse an existing compatible target cache. The build uses locked/offline Cargo, disables dynamic code execution, permits memory growth, allocates a 2 MiB checked stack, and exports only the bounded ABI plus the filesystem/heap needed by the controller.

`npm run verify:mdbx2-browser` verifies the current source inventory and generated JS/WASM hashes against `BROWSER-BUILD.json`. Sources changing during compilation or since the last build are rejected. Generated engine files and compiler targets remain ignored. This optional build is not yet added to the normal extension build or release package.

## Acceptance

The committed test bundles the production engine, block store, filesystem tracker and session into a synthetic extension with no Native Messaging permission. It uses the installed Edge executable and isolated profiles. The independent native executable is the same fixture recorded in the feasibility report, SHA-256 `7da58ae2a3c11d4581231c11d0e550100777c88f763ce8d10f9bc9ecea8d0f16`.

Verified in installed Edge 155.0.4283.45:

- Small overwrite and append each persist one block; rename persists no content blocks; mapped writes and truncate/regrow retain correct bytes; deleted files remove their old block keys.
- Caller mutation after commit begins cannot alter committed bytes; stale generations are rejected. A real IndexedDB transaction abort preserves the previous catalog and every restored file byte.
- Sky/Multi/Power creation, wrong-password rejection, and preserved Power disclosure denial.
- Browser-generated ES256 credentials preserve exact PKCS8 bytes, credential IDs, original public-key signatures, intentional zero counters and an existing positive counter of 19. Tests do not increment either counter.
- Exact large integers/decimals, encrypted password storage, and a 600,000-byte attachment survive live-Worker termination, failed persistence, lost successful responses, close during commit, and a full browser restart.
- No automatic replay: the committed note remains exactly one record after its reply is lost. A write completed during close remains durable while its response is suppressed.
- Complete backup includes encrypted external blobs. An independent native process reads the browser database, changes a password-record field, preserves the original Passkey payload, and produces a backup. The browser imports that native result, reads the change and signs against the original public key.

This does not constitute manager UI acceptance, website WebAuthn login, Android Credential Manager acceptance, live cloud synchronization or large-vault performance acceptance. Synthetic fixture passwords/keys are used exclusively; user Chrome, accounts and vaults are untouched.

Evidence is retained under `.artifacts/mdbx-browser-production-20261014/`; the initial successful complete run is `native-roundtrip/.../isolated/evidence.json` (29.9 seconds). Failed intermediate runs remain recorded: unsupported hard-link publication, fixture payload identity/attachment/export argument mistakes, and the expected Power policy denial before the test explicitly covered that policy. No assertion was weakened to bypass Power security.

The task ledger identifies the final verification run and commit. Remaining integration belongs to task 63; the full parity goal remains active.
