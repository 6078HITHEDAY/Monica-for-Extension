# Revision-bound native attachment catalog

Development groundwork after 0.1.39, 2026-10-14. This adds folder-owned attachments
to the native catalog boundary. It does not complete nearby synchronization, its
UI, scheduling, or current Android/F-Droid application acceptance.

## Contract and data preservation

Native Messaging and the bundled browser engine share `supportsContentAttachments`,
`content.attachments.list` and `content.attachments.begin`. Requests use an open
opaque vault handle and a content write revision. There are no caller filesystem
paths or new content-writing methods.

The list method takes `collectionId` and `pageSize` (1–50). A collection UUID
selects every active attachment in that collection, including folder-owned
attachments whose `objectId` is null. A null collection selects the existing
global tombstone query. Cursors bind the handle, vault UUID, revision and query
scope. The revision is checked before and after each native read.

Rows retain attachment, collection and optional object IDs; filename and media
type; storage mode; content SHA-256; original/stored sizes and chunk count; head
commit, deletion status and timestamp. The TypeScript collector filters global
tombstones to requested collections only after charging all received rows
against its limits. It never turns a tombstone into an empty live attachment.
Legacy object-only attachment navigation is unchanged. No core overlay, schema
migration or Android source change was needed.

The collector caps its input at 10,000 distinct owners, all received rows at
10,000, aggregate catalog metadata at 32 MiB and each RPC response at 850 KiB.
It rejects wrong owners/revisions, duplicate IDs, invalid sizes/hashes, malformed
envelopes, repeated cursors and oversized pages. It returns no partial catalog.
Old engines without the capability return an explicit update-required error.

## Content reads

The begin method takes an attachment UUID and the expected write revision. It
returns the full snapshot metadata alongside the existing in-memory attachment
read session. It reuses native integrity validation, Tiga authorization, deleted
content denial, resource bounds, lock cleanup and idle expiration. If the
revision changes while beginning a read, the new staged buffer is removed.

`readContentAttachmentBytes` reads one selected live attachment, at most 64 MiB,
in canonical Base64 chunks of at most 256 KiB. It validates all chunk identities,
offsets, sizes and EOF flags, compares the complete SHA-256 with native metadata,
and checks the content revision again before returning bytes. Source metadata is
copied before the first await. A changed database, bad hash, cancellation or
malformed response cannot produce a successful partial download. Native read
handles stay on their allocating backend through router recreation.

Read sessions are released on success and error; release transport failures use
existing lock/idle cleanup. Temporary byte arrays are cleared after a failed or
cancelled read, including cancellation while releasing. The caller owns bytes
returned by a successful read. This is not a claim that immutable JavaScript
strings or every native/FFI copy can be wiped.

Power mode can enumerate attachment metadata but retains its existing denial of
folder and object plaintext in this browser security context. Deleted attachment
contents remain unavailable. Listing either case is not proof that its contents
can be synchronized. The full nearby adapter must expose these limitations and
must not silently discard such records.

## Verification

- Rust 1.86.0: all 99 native tests passed, including four new catalog/read/policy
  scenarios; all-target Clippy with `-D warnings` passed. The full suite used two
  test threads and took 351.89 seconds.
- 178 distinct client tests across five affected files passed: the grouped run
  passed 177, then the added backend-ownership regression passed with all 19 router
  tests. Main/interop types and strict changed E2E/worker types passed.
- Actual installed Edge 155.0.4283.45: 7.1-second scenario (11.1-second runner),
  two multi-chunk attachments with folder/object ownership, original Passkey
  signature and zero counter, precise numeric lexemes, atomic commit/rollback,
  browser restart and replay, complete attachment hash, tombstones, stale reads,
  lock denial and persisted-block plaintext scan all passed. This uses synthetic
  isolated data and the compiled browser engine, not a user vault or Android app.
- Bundled engine rebuilt with pinned Rust 1.97.0 and Emscripten 4.0.18:
  6,340,890 WASM bytes. Production build updated development `dist`; source and
  artifact provenance checks passed. Static security audit passed for 219 runtime
  commands, 24 manager-only project commands and the dedicated nearby manager port.

Logs and actual browser evidence are in `.artifacts/content-attachments-*`.

Initial failures are retained: the fixture combined creation/deletion and three
600,000-byte attachments in one batch. A diagnostic rerun after separating the
deletion confirmed the core's existing 16 MiB encoded sync-delta limit was hit.
The corrected fixture uses one
600,000-byte folder attachment, small object/tombstone assets and a separate
deletion transaction. The browser scenario uses two 280,000-byte attachments,
each spanning multiple transport chunks. These are bounded acceptance batches;
the 64 MiB staging/read limit does not promise every asset batch fits one native
sync delta. No core limit was raised. ES2020 compatibility errors in new tests
and shape checking were also corrected without changing the project target.

The test runner automatically deleted its isolated browser profile; the profile
root was confirmed empty afterward. The earlier cleanup freed 24.641 GiB and
`.tmp` remains about 9.104 GiB. An additional 2,586,278,594 bytes of idle Rust
incremental cache was verified but left in place: automatic policy rejected both
the validated cleanup command and the direct literal-path deletion with only
`blocked by policy`. No alternate deletion tool was used. The local cleanup
receipt records this as blocked, not reclaimed space.

## Remaining integration

Nearby native catalog mapping and adoption still need root/folder metadata,
unsupported and retained deleted content handling, source archive restoration,
durable adoption receipts and coordinator integration. Those tasks remain open.
The published 0.1.39 ZIP is unchanged.
