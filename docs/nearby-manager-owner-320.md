# Nearby production manager ownership

The extension now constructs the nearby owner in its production background. This completes the lifecycle integration left open by [the local coordinator block](nearby-local-coordinator-320.md). The public 0.1.38 preview, its tag and assets are unchanged. This is subsequent development work; nearby has no user-facing page or automatic networking scheduler yet.

## Boundary

`monica-nearby-manager-v1` accepts one full, active, top-level `index.html` document from this extension. The browser-provided extension ID, URL, origin, tab, frame and document identity are checked before registering messages. A second manager cannot take over the connection. Popup, content-page and child-frame senders are rejected. Disconnecting the owning port or disposing the document ends the lease.

The bounded API supports status, redacted preferences, preference changes/forget/request-sync, pairing, preparation, recipient-bound Passkey confirmation, start, progress and cancellation. It accepts neither native operations/handles nor records, replica keys or saved trust supplied by a page. Request IDs must strictly increase. Only one operation runs at a time; other requests return `busy`, while cancellation bypasses the pending operation and ends the lease immediately. A client can cancel and reconnect to edit settings while an operation is busy. Reading status alone opens no native connection and does not initialize preferences.

The native transport has its own connection, independent of MDBX and autofill. Successful authenticated pairing and remote settings updates remain internal to the coordinator, so they do not cancel themselves. A manager preference change closes the previous coordinator before saving, and the next explicit action creates a new one. Polling/progress never records user activity or extends the vault session.

## Cancellation and persistence

Production hooks close the lease synchronously before the first await in explicit lock, protection change, restore and provider-removal handling. Session replacement/key removal, manager disconnect and background suspension also close it. An active-lease timer follows the stored expiry deadline, including ordinary user-activity extensions; it does not wait for the existing minute alarm. Operations also check the deadline themselves, covering delayed timer delivery.

Cancellation clears native ownership, session state, temporary pairing material and consent. Awaited results from an old lease cannot respond to a newly connected manager. Session reads and preference initialization cannot revive a closed lease.

The coordinator supplies its exact generation and owner guard to identity initialization, trust/settings saves and incoming application adoption. These guards run inside the exclusive vault transaction and again after encryption, immediately before the encrypted storage write. Cancellation does not depend on a lock request reaching the front of that same transaction queue. Normal decoded-cache invalidation is deliberately not a cancellation signal.

An already committed atomic write cannot be rolled back by a later cancellation. Its encrypted records/receipts remain recoverable; a cancelled coordinator cannot send the subsequent acknowledgement. The earlier durable receipt/replay behavior remains in place.

## Validation

- Installed Edge 155.0.4283.45, two isolated profiles, the ordinary `dist/background.js` and actual Native Messaging/Noise transport: passed the production-port scenario, including the final typed-fixture run in 10.5 seconds. No source-only coordinator harness or extra test entry point was added to the build.
- Verified popup rejection; pairing with no source content; explicit lock during a connected transfer before application adoption; both-browser/native restart with saved trust; successful subsequent transfer; preference change, document close and short session expiry. Real TCP listener closure was checked after each cancellation.
- The received Passkey retained the exact credential ID and private key, and signed a challenge verified with the original public key. The original source IDs and counters 0 and 19 were preserved; the positive-history credential was not exported. Pairing saved no user items in the recipient.
- The affected unit suite passed 189 tests in nine files. A further incoming-adoption cancellation regression was added, and all 32 owner/boundary tests then passed: 190 distinct passing tests. These cover untrusted senders, stale and simultaneous requests, blocked initialization, expiry, error redaction and cancellation before encrypted preference/adoption writes.
- Project/interop types, strict affected E2E types, normal production build and security audit passed. The audit now explicitly includes the separate nearby `onConnect` boundary in addition to 219 runtime commands / 24 manager-only project commands.

Evidence is under `.artifacts/nearby-owner-*`. The first Edge run failed only because the fixture assumed list ordering for counters; the corrected check addresses each original item ID. The initial build's icon scanner interpreted a method-name string as an icon; the public action is now named `progress`, with no font/UI regeneration. The standalone E2E type check also identified missing fixture types; those were corrected.

Native registration was restored. No user Chrome/accounts/vaults, Android operations, cache deletion or publication occurred. No native code changed, so the previously tested Host was reused. This validates the production backend ownership contract; nearby UI, complete MDBX catalog/adoption, origin archives, folder/root metadata, conflict/restore handling, current Android/F-Droid and direct OneDrive acceptance remain open.
