# Android 1.0.324 nearby protocol alignment

Extension version remains 1.0.103; these changes belong to the next unreleased notes. Native Messaging remains optional, and ordinary browser MDBX continues to use the bundled engine.

## Implementation

The local, frozen Android Rust protocol is recorded in `native/mdbx2-host/LAN-PROVENANCE.json`, with the original upstream pin and previous extension overlays retained. The new reversible `extension-lan-android324.patch` preserves the extension's lossless JSON number and marker-key adaptation. It adds paired incremental records, independent missing assets and authenticated ciphertext resume. Pairing-only and receive-only snapshots do not advertise a usable record inventory; old peers use full encrypted transfer.

The native owner advertises capabilities and controls a leased resume directory. A retry uses the same immutable snapshot and a fresh Noise handshake, restricted to pre-application connection/transfer failures. Cache cleanup rejects links/reparse points and suspicious owner hard links, respects live leases, bounds traversal and preserves unknown layouts. Caches contain ciphertext, without Wi-Fi credentials or content/handshake keys.

The browser parses bounded Android `monica-hotspot:1:` invitations, shows manual system Wi-Fi instructions and retains credentials only in the current page's memory for at most 180 seconds. Lock, cancellation, leaving and hiding the page revoke the operation. Active progress polls at 500 ms, idle discovery at five seconds, with online events waking discovery. All seven additional messages cover the seven translated catalogs.

Received deletions use a revision-bound preview and explicit include/omit choice before application. Durable application succeeds before acknowledging the transfer. Incremental transfers may omit an unchanged attachment already held by the receiver: the coordinator rereads it only from the currently authorized source, checks source revision, exact size and SHA-256, and refuses missing or changed bytes.

## Verified

- Complete extension build, TypeScript, bundled runtime/page and supply-chain checks passed. Final browser build identity: `33ac3f221f174597e01e`.
- Full Vitest: 354 files / 4,487 tests passed in 308.08 seconds before the final retained-attachment fix. The final affected nearby selection passed 310 tests in 7.98 seconds, including retained bytes, corruption, size, source revision, absence and legacy capability rejection.
- Native protocol: 65 cases passed. Native Host full suite: 121 cases passed in 1,101.24 seconds before a Clippy-equivalent conditional simplification; all-target Clippy with warnings denied passed afterward. Release Host and bundled WASM builds passed. WASM is 6,457,089 bytes (Rust 1.97.0 / Emscripten 4.0.18).
- Real installed Edge 156.0.4314.50 transport acceptance passed in 35.1 seconds: 770,240 bytes of large records, a 600,000-byte attachment, original Passkey signature/counter, exact JSON values and browser restart. An unchanged paired third round transferred only 91 artifact bytes.
- Final real Edge coordinator/UI/runtime selection: 15 cases passed in 3.4 minutes. Includes both deletion directions and all three review choices, ephemeral hotspot expiry, optional-helper behavior, offscreen MDBX ownership/service-worker recovery, local application/restart receipts, 300-row paginated recovery and bidirectional application into the bundled MDBX database with original keys and attachment bytes verified.
- Temporary Native Messaging registration was restored; final Edge run removed its 22 isolated profiles. Evidence and failure history remain under the local task's `raw/` directory.

## Failed runs and correction

The first bridge selection failed cancellation because resume maintenance received `path` instead of `root`; all six maintenance calls were corrected. An invitation-limit test caught enlargement of the ordinary invitation bound; ordinary invitations remain capped at 512 characters, while hotspot envelopes have a separate bounded parser. Stale vendor provenance and WASM inventory checks initially rejected builds; both were regenerated before the successful complete build.

The first real Edge matrix passed 12 and failed three. One historical-deletion case lost its browser page; its cause is unconfirmed, and the same assertions passed the final run. Local restart adoption and MDBX reciprocal edits exposed a production defect: attachment lookup required bytes in the current transfer even after negotiated incremental omission. The revision/size/hash-checked local reread described above corrected both cases. Final assertions still verify actual records, original keys, signatures, attachments and restart behavior; the failed run is retained separately.

## Pending interoperability and practical limits

An explicit opt-in extension-owned fixture is provided at `tests/interop/android-nearby/`, with the production JNI/provider and synthetic isolated stores. It adds 200 large records, reciprocal edits, original Passkey signatures and unchanged-round byte assertions. It has not yet been built or executed against ordinary Android and canonical F-Droid: the shared API32 emulator is currently owned by another Android task, and no user switch, package replacement or UIAutomation contention was introduced.

Android's separately recorded native/JVM/device results are not counted as browser interoperability results. Physical two-phone Wi-Fi/hotspot creation/join, radio interruption, OEM system dialogs and real account/vault behavior remain unverified. The browser supplies manual hotspot instructions; it does not advertise automatic hotspot joining.
