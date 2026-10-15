# Native profile write boundary — Android 1.0.320 alignment

This checkpoint adds the extension engine's atomic write boundary. It does **not** enable Wi-Fi synchronization of profiled collections yet. Complete binary reads landed previously; Android-compatible owner-isolated archives and receive mapping remain necessary. Android production sources and wire protocol are unchanged.

## Behavior

- `collection-profile-set` references a staged binary asset, rather than encoding bytes inside the JSON plan. It preserves arbitrary bytes, collection type, schema, allowed object types and required capabilities. Payloads are bounded to 1 MiB; referenced copies count against the existing memory and write budgets.
- `collection-presentation` updates only favorite, archived and icon reference. Native title, hierarchy, Tiga override, identity, counters and other project fields are loaded and retained.
- Both commands share the existing revision-guarded transaction with objects, labels and attachments. The original command variants retain their positions and serialized representations. Existing database format and Android provenance remain unchanged; the extension changes are recorded as a separate source overlay.
- Profile replacement requires the **current** profile's capabilities before checking the requested profile. A caller cannot drop an unavailable capability to bypass it. Immutable types, registered extension contracts and existing object types are checked by the original native repository. No capabilities or adapters are registered or activated by these commands.
- Engine capability `supportsCollectionProfileWrite` is required before staging. Native receive preflight also checks it before storing a durable intent when these commands occur.
- Creation/update timestamps follow native repository behavior: existing creation identity is retained and the new update receives its native commit/device identity. Historical source metadata must be retained separately by the future portable archive.

## Bounds and failure evidence

The existing native sync delta limit remains 16 MiB. Encrypted rows and historical snapshots contribute serialized size in addition to raw data. A 1 MiB profile plus a 1 MiB attachment exceeded this limit during initial acceptance. The complete transaction rolled back, including profile, presentation and attachment rows; no receipt was recorded. The failed experiment and diagnostic log are retained. The temporary diagnostic output was removed from source.

A 1 MiB binary profile, presentation and a small attachment fit and commit atomically. Receive planning must account for this shared native limit rather than assume independent payload limits guarantee a combined batch fits. Unsupported restoration must stay explicit and preserve the source archive. Foreign root metadata must not overwrite the shared destination root's profile or presentation.

## Verification

Synthetic fixtures use isolated vaults and Edge profiles; no user Chrome profile, accounts, Android emulator, push, tag or release is involved.

- Client staging checks full-size binary transfer, snapshot isolation, capability gating, malformed declarations and repeated-reference budgets.
- Native tests check exact bytes, preservation of Passkey payloads with zero and positive counters, rollback for immutable type/object/capability/attachment failures, unavailable-current-capability denial, Power disclosure denial, resource bounds, revision rejection and durable replay after reopening.
- The real Edge scenario imports a native encrypted fixture, performs profile/presentation writes through the TypeScript client and compiled engine, rejects a conflicting immutable type without changing revision, and checks exact data and replay after browser restart.

Results on 2026-10-15:

- 157 TypeScript tests in six affected files passed; main/interop and strict E2E types passed.
- Full native run: 107 passed, one existing snapshot-prune test failed because its two-second retention deadline elapsed before the second snapshot was created. The exact unchanged test passed in isolation (14.04 s). Both outputs are retained. All four added profile-write tests passed in the full run.
- Native Clippy across all targets and debug Host build passed.
- Real Edge profile write/restart scenario passed (18.4 s). Existing production Wi-Fi coordinator passed (42.8 s), including 142 items, 40 connected password records, signature verification with the original Passkey key/counter, reciprocal edits, trash restoration, 600 kB attachment bytes and repeated-sync stability.
- Production build, source provenance and security audit passed: 219 runtime commands, 24 password-project manager commands, and the dedicated nearby manager port.
- Rust 1.97.0 / Emscripten 4.0.18 browser engine: 6,426,095 WASM bytes; SHA-256 `544aafc8177954d0b9bd4c0d673a4569a50bb4c375d9a21b9ef51f5b98e397de`. `dist` contains this engine. Public version remains 0.1.39 Preview; this checkpoint is not a release.

Local evidence: `.artifacts/profile-write/{client-red,native-first-failure,native-diagnostic,native-final,snapshot-recheck,ts-final,clippy,host-build,browser-build,e2e-types,edge,production,security}.log` and isolated Edge evidence JSON. The native source overlay is `native/mdbx2-host/runtime-patches/extension-collection-profile-write.patch` with baseline and result hashes in `ENGINE-PROVENANCE.json`.
