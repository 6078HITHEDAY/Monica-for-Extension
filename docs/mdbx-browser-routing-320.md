# MDBX browser / Native Host ownership routing

Internal integration block, 2026-10-15. The normal extension UI is not yet wired
to this router. Current `dist` still uses Native Host. This report does not claim
no-helper UI, cloud end-to-end or Android application acceptance.

`Mdbx2BackendRouter` preserves every runtime, vault, record, credential and key
identifier. A strict IndexedDB origin index records only runtime handle UUIDs,
their allocating backend and role; it contains no passwords, keys, records or
cloud credentials. Existing unindexed handles retain Native Host semantics;
new unbound imports and vault creation choose the bundled browser engine.

- Unknown legacy handles are reserved before dispatch. A concurrent origin
  collision or failed index write stops the operation before a native write.
- New result handles are committed before acknowledgment. An origin persistence
  failure closes both clients and withholds the result; creation is not replayed.
  The allocated working copy is retained, so later recovery must not assume a
  failed acknowledgment means no write occurred.
- The index rejects changed backend ownership, invalid roles and malformed rows.
  Mixed-engine requests stop before dispatch. Retired handles remain indexed,
  preventing stale browser references from falling back to Native Host.
- Inputs are snapshotted before asynchronous lookups. Closing invalidates delayed
  dispatch and pending acknowledgments. Each underlying client owns its own
  transport failure; losing native transport does not retire a live browser lease.
- Vault, state, file, attachment-read and health-plan handles are tracked.
  `transferId` is an owned handle only for local transfer/attachment RPCs; remote
  sync stream IDs, object IDs and opaque payloads remain untouched.
- Incoming sync segments explicitly inherit the destination vault's backend.
  Capability checks, including batch restore and backup, use that same vault.
  `status()` checks a shared client without closing its Worker; disposable
  `probe()` retains its previous close-on-completion behavior.
- Windows Hello and nearby platform operations continue to use Native Host.

## Verification

374 tests in 32 files passed, covering the MDBX provider, router, transport,
restore and storage behavior. Project/interop TypeScript, strict E2E TypeScript,
normal extension build, engine artifact/source verification and the 218-command
security audit passed. No Rust engine rebuild or source changes were needed.

The installed Edge 155.0.4283.45 test passed in 6.9 seconds with an isolated
profile and isolated native application data. It runs the production router,
offscreen entrypoint and Worker alongside real Native Messaging:

- Browser-created vault and an independently imported legacy native working copy
  coexist; the legacy handle begins with no origin record.
- Router replacement and full browser restart reopen both correct working
  copies, retaining vault identity and original Passkey private bytes/credential
  IDs. Fresh signatures verify against the original public key. Counters 0 and
  19 remain unchanged.
- Incoming transfers inherit each destination engine and newly allocated file
  handles retain their engine. A mixed native/browser request is rejected.
- Status checks do not close either live vault.
- Real IndexedDB validates reopening, concurrent role merges, whole-transaction
  collision rollback, an injected transaction abort after a successful put,
  simultaneous conflicting owners and corrupt-row rejection. Exactly one
  conflicting owner can commit.
- Temporary Edge Native Messaging registration is restored and verified after
  closing the isolated context. No user Chrome, accounts or vaults are accessed.

The initial harness attempted to reopen an already-open seeded vault; the core
correctly returned `vault-already-open`. Explicitly locking the synthetic seeds
before reopen fixed the harness. Both failure evidence and final evidence remain
local. Final evidence:

`.artifacts/mdbx-browser-router-20261015/final/mdbx-browser-router-MDBX-r-d1dad-start-without-changing-keys/isolated/evidence.json`

Run `npm run test:mdbx2-routing` after building the pinned browser package and
Native Host debug executable. This test does not rebuild the Rust toolchain.

## Remaining application work

Task 63 remains open: preserve backend ownership in encrypted provider accounts,
restore/check it before routing after unlock, integrate the shared router in the
normal background, bypass generic replies for offscreen control messages, package
the offscreen document/Worker/verified WASM, and provide the actual no-helper
create/import UI. Existing native working copies must stay accessible without
silent migration. Full production UI and cloud fault/restart acceptance still
follow those changes. No Android sources or published versions are modified.
