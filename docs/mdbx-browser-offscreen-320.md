# MDBX browser Worker ownership

The production browser runtime adapter and offscreen controller are implemented and tested as an internal block. They are not yet connected to the normal extension background, manifest or database UI. The current `dist` still uses Native Host. Legacy backend routing must be completed before changing that default.

The adapter implements the existing `Mdbx2NativeRuntime` Port interface, so existing typed database clients and coordinators can use the browser engine. It creates or reuses the dedicated offscreen document, verifies readiness using a bounded probe without credentials, then establishes the database port. Requests are bounded JSON strings to preserve exact numeric tokens across Chrome message serialization. It never retries database operations.

The offscreen page first authenticates its own context through a background message. The background requires the same extension ID, exact document URL, no tab, and a matching official `OFFSCREEN_DOCUMENT` context. If Chrome supplies a document ID it is also checked. Installed Edge 155 does not supply a document ID for this offscreen sender; a normal tab supplies one and a tab identity and is rejected. Only an authenticated offscreen page installs the port listener.

Database ports accept only the exact `background.js` sender, with no tab/document identity. Page and content-script senders cannot impersonate it. A normal tab opening the offscreen HTML cannot install a second database receiver. This matters because Chrome broadcasts extension port connections to eligible contexts: rejecting a second receiver by disconnecting the shared port would also disrupt the legitimate owner. The normal-tab case now has no production receiver at all.

One client owns one Worker lease. A new owner waits for the old Worker to retire, including when an intermediate connection is abandoned. Port loss, an invalid frame, an engine error or an expired heartbeat closes the session. Close waits for an active durable operation and suppresses its response, then terminates the Worker. A 30-second retirement bound terminates an unresponsive Worker; only its last committed generation can be restored. A 15-second heartbeat and 45-second lease prevent an orphaned unlocked Worker from remaining indefinitely when a disconnect event is missing. These deadlines are policy bounds, not claims of instantaneous OS memory erasure.

The dedicated engine Worker loads the previously verified WASM and production durable session. It never invokes Native Messaging. Unexpected errors exposed across the bridge are static codes; raw exceptions or decrypted payloads are not logged.

## Verification

`tests/e2e/mdbx-browser-runtime.spec.ts` builds a synthetic extension from the production adapter, offscreen controller and Worker. It has the `offscreen` permission and no Native Messaging permission. A test-only background driver requests operations through the real `Mdbx2NativeClient`.

Installed Edge 155.0.4283.45 verified:

- The typed capability handshake, creating an encrypted database, writing and reading a record.
- A direct manager-page port is rejected while the legitimate owner's database connection keeps working.
- A visible tab opening the same offscreen HTML cannot become a database owner, including after close/reopen.
- Stopping only the isolated extension's service worker through CDP releases the old connection. A fresh background worker reconnects to the existing offscreen document and reopens the same stored record.
- Repeated explicit close/reopen works.

The final production-only offscreen bundle passed; evidence is in `.artifacts/mdbx-browser-runtime-20261015/final/`. The earlier instrumented passing run took 2.9 seconds. Initial failures retained in sibling directories established the missing Edge document-ID behavior and the shared-port disconnection problem. Twenty bridge-boundary unit tests cover exact sender identity, byte bounds and malformed request envelopes; the combined browser/native-client/lossless suite has 94 passing tests.

This is Worker ownership acceptance, not manager UI, live cloud sync or Android application acceptance. The separate durable-engine test covers original Passkey signatures/counters, native format round trips, attachments, transaction aborts and lost replies.

## Remaining integration requirements

- Add the document/Worker/build assets and `offscreen` manifest permission when the application router is ready.
- Register browser document authorization before normal application message handling, and let `isBrowserMdbxControlMessage` bypass the general command responder so it cannot race the private handshake.
- Share one live browser client among coordinators. The current standalone `probe()` closes its client; it must not replace or close a live owner during status checks.
- Route existing Native Host working-copy and sync-state handles to their original backend. Do not silently reinterpret legacy handles as browser data. Preserve operation scopes, pending transfers and source bindings.
- Give unbound inbound transfers an explicit owning vault/backend when used for legacy cloud synchronization. `Mdbx2SyncCoordinator.downloadToHost` currently begins a transfer with size/hash/purpose only; merely changing the default backend would route an old Native Host vault's incoming segment into the wrong engine.
- Preserve data identities, credential IDs, private bytes and signing counters. Only runtime ownership belongs in the routing layer; opaque record payloads must never be recursively rewritten.
- Connect account adoption, cloud synchronization, local M3E Canvas designs and real UI acceptance before claiming no-helper MDBX is available.
