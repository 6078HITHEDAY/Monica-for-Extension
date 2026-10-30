# Revision-guarded native content adoption

This is the write boundary required by the complete native nearby catalog. It
does not provide a Wi-Fi UI, scheduling, native catalog mapping, or the completed
Android/F-Droid application round trip.

The bundled browser engine and Native Messaging Host share `content.write.begin`,
`content.write.chunk`, `content.write.finish`, `content.write.abort`, and the
optional `supportsContentWrite` capability. Old engines fail with a useful update
requirement before any content is staged. Every operation carries its vault
handle, original write revision and stable operation UUID.

## Atomicity and recovery

The new explicit extension overlay adds a content-write operation without
changing existing composite APIs or the storage format. Generic commands and
attachment commands share one `BEGIN IMMEDIATE` transaction. The revision is
checked after the core's durable replay lookup and before applying any command;
another connection's commit is visible to this guard. The expected vault ID and
revision are part of the durable operation intent. Identical retries recover the
original commit, including after later edits/deletion and vault reopening.
Changed input under an existing operation ID is rejected.

The operation returns only its durable commit receipt. It does not read current
attachment records after commit, which could otherwise make an old committed
operation appear to fail after those records change. Attachment-only operations
are supported. Mixed move/restore operations use the native multi-operation
commit kind; native repository checks remain responsible for object ownership
and storage invariants.

The browser client distinguishes a definite `content-write-stale` guard rejection
from an unconfirmed result. Cancellation before finish aborts staging. Once finish
has been sent, a valid receipt is returned even if cancellation arrives meanwhile;
transport/storage failures or invalid receipts produce
`content-write-outcome-unknown` with the original operation ID. Callers must retry
the identical operation and recover its receipt before choosing another write.
No error claims that a dispatched operation necessarily did nothing.

## Data and resource boundaries

- Up to 128 generic commands, 64 attachment commands/descriptors, an 8 MiB plan,
  and 64 MiB of attachment data. Reusing an asset in multiple commands also
  counts toward the 64 MiB expanded-content bound.
- Two memory-only staging sessions and 128 MiB of reserved staged buffer capacity
  across the runtime. Chunk limit is 256 KiB. Session cleanup is lazy after five
  minutes of inactivity on the next content-write request, on owned vault lock,
  on abort/finish, or on runtime destruction.
- Canonical Base64, contiguous offsets, identical chunk replay, final SHA-256
  checks, exact field allowlists and vault ownership checks. Unreferenced and
  duplicate asset descriptors are rejected. Incomplete/invalid finish consumes
  its staging session without applying a plan.
- Rust staging buffers use `Zeroizing`; the client snapshots caller-owned data
  before its first await and clears its own byte copies in `finally`. Native
  parsed values, existing core/FFI buffers and immutable JavaScript strings do
  not have a universal explicit-wipe guarantee. No plaintext staging files are
  created, and RPC errors do not include submitted payloads.
- Payload JSON remains an opaque string in the transport and typed client. The
  native lossless parser retains large-number/decimal lexemes. Credential IDs,
  key material, zero counters and existing positive counter values are not
  rewritten by the transport.

Supported generic commands cover collection create/rename/move/delete/restore;
object create/update/move/delete/restore; labels, assignments and relations.
Attachments support create, replace, rename and delete. These are low-level native
commands; application-level source mapping, per-item merge policy and safe native
nearby adoption remain part of task 79.

## Validation record

- Full native suite: 95/95 passed. After refining the definite stale-revision
  error, all seven content-write regressions passed again; all-target Clippy
  with `-D warnings` passed. Covers rollback, independent connections, replay
  after deletion/reopen, intent/vault mismatch, lock/abort and chunk/hash bounds.
- Client, native client, metadata and router: 134 tests across four files passed,
  including 24 new content-write scenarios. Main/interop and strict changed-E2E
  TypeScript checks passed.
- Actual installed Edge 155.0.4283.45: 20.2-second scenario passed. A 600,000-byte
  attachment, folder, Passkey object and tag were persisted in one durable
  browser commit. Definite stale rejection and bad-attachment rollback passed.
  The actual browser closed/reopened; the original commit receipt, asset hash,
  credential ID, zero counter and signing with the original public key passed.
  Durable block scanning found none of the synthetic payload/key/password
  strings. Automatic teardown removed the profile; the profile root was empty.
- Final WASM: 6,317,655 bytes, built with the pinned Rust 1.97.0 compiler and
  Emscripten 4.0.18. Source/artifact provenance and reverse patch applicability
  passed. Production build updated development `dist` and verified four pages.
- Security suite: 649/649 tests across 43 files passed with two workers. The
  first unrestricted parallel run had 29 failures in nine files, with reported
  5-second timeout errors; the same suite passed without changing assertions or
  timeout limits when concurrency was bounded. The original log is retained.
  Static audit passed for 219 runtime commands, 24 manager-only project commands,
  the nearby manager port and absence of fixture secrets/source maps in output.

Exact logs are `.artifacts/content-write-*.log`. Actual browser evidence is
`.artifacts/content-write-edge/mdbx-content-write-bundled-cc138-nd-original-Passkey-signing/isolated/evidence.json`.

No Android sources, published 0.1.39 assets or version numbers are modified by this
development block. Full native nearby integration and current Android application
acceptance must remain open until separately demonstrated.
