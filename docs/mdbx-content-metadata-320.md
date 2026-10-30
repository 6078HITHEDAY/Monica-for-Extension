# Revision-bound native metadata reads

Development block after 0.1.39, 2026-10-14. This supplies the read boundary for future MDBX nearby adoption; it does not add a Wi-Fi synchronization UI, automatic synchronization, native adoption or Android application acceptance.

## Contract

The shared Rust HostRuntime exposes `supportsContentMetadata`, `content.metadata.list` and `content.metadata.read` to both Native Messaging and the bundled browser engine. Calls require an open opaque vault handle and `{ vaultId, revisionSha256 }`. The revision is checked before and after each read; a change returns `content-metadata-stale` without partial success. Caller paths and writes are not accepted.

- List labels by collection, assignments by object and outgoing relations by object, including deletion markers and unassigned labels. Pages contain at most 200 rows. Cursors bind the handle, owner, kind and content revision. The underlying cursor additionally binds the active-only versus tombstone-inclusive query.
- Read active label/relation payloads as canonical Base64 chunks of at most 256 KiB, with total byte length, SHA-256, offsets, completion and native metadata. Each payload is limited to 1 MiB and each RPC response to 850 KiB. JSON remains an opaque UTF-8 string: native numeric precision and literal keys are retained.
- Each chunk uses existing native policy-authorized disclosure. Labels obey their project scope; relations obey both endpoint scopes. Power restrictions, session authorization, payload bounds and security auditing remain active.
- Native policy intentionally denies deleted payload disclosure. The collector includes tombstone metadata with `payloadJson: null`; it neither exports deleted secrets nor substitutes an empty object. Recovering historical content is a separate feature.
- Security audit writes can occur during disclosure. They do not change the content write revision. The browser fixture observes four audit commits for four content chunks; this is not a claim of zero filesystem writes.

`Mdbx2NativeClient.readContentMetadata` snapshots its requested collection/object IDs and revision before awaiting capabilities. It checks every response envelope, owner, row ID, metadata schema, cursor, size, hash and offset, verifies fatal UTF-8 decoding, rejects duplicate records/repeated cursors, and rechecks the revision at completion. Reads are cancellable between RPCs; no partial catalog is returned. Temporary byte buffers are cleared. The collector caps each owner list at 10,000 IDs, the result at 10,000 rows and its combined metadata/payload byte budget at 32 MiB. Existing helpers without the capability return an explicit update-required error.

## Source provenance

The upstream summary APIs filter tombstones. The explicit extension overlay `content-metadata-tombstones` adds opt-in FFI/storage methods, retaining old signatures, active-only query predicates and cursor behavior. Query variants are internal enums; values stay bound SQL parameters. No database schema, cryptography, stored payload or Android source changes are involved. Existing deleted-payload disclosure policy is unchanged.

`native/mdbx2-host/ENGINE-PROVENANCE.json` records the overlay, base/final source hashes and exact patch hash separately from the original Android inventory. The patch is reverse-application checked, and both the native verifier and rebuilt browser inventory validate it.

## Verification

- Rust 1.86.0 native suite: 88 tests, including six new metadata regressions. Clippy with `--all-targets -- -D warnings` passes.
- TypeScript: 110 affected tests across the metadata collector, native client and backend router. Main/interop types and strict changed E2E/worker types pass.
- Installed Edge 155.0.4283.45: synthetic native Multi and Power vaults imported into the compiled browser engine. Checks exact 280 kB UTF-8 payloads, integer `9007199254740993`, decimal `1.00000000000000001`, original IDs, unassigned/deleted metadata, policy denial, stable content revision, stale revision rejection and lock rejection. Uses an isolated extension/profile, not user Chrome or a user vault.
- Browser build pins Rust 1.97.0 and Emscripten 4.0.18. Extension production build, source/artifact provenance, and security audit of 219 commands plus the dedicated nearby manager port pass.

Evidence is under `.artifacts/content-metadata-*`, including final native, client, build, E2E and security logs. The checked-in fixture generator is test-only and is never packaged in the extension or native helper.

Initial failures are retained: a fixture compared noncanonical input whitespace/order instead of authoritative stored JSON; an invalid synthetic relation kind; a bulk fixture exceeded the existing 16 MiB sync-delta limit; old summary APIs omitted tombstones; and an E2E assertion incorrectly expected native auditing to produce no filesystem commits. Fixtures now use valid kinds and separate bounded writes, compare stored payloads, and verify unchanged content revisions while preserving audit writes. The deleted-content test now explicitly enforces the existing denial policy. A Windows linker collision occurred when a previous test executable was still running; subsequent native commands ran sequentially.

## Remaining integration

The caller still has to enumerate the desired native owners and connect the catalog to nearby records. Native atomic adoption of folders, metadata, objects and attachments with revision guards; restoration of source archives; the UI/scheduler; and actual Android/F-Droid bidirectional acceptance remain open. None of this development block has been published as part of the existing 0.1.39 ZIP.
