# Background runtime ownership

`src/background/index.ts` only starts the worker. `composition.ts` constructs source adapters and domain Modules, supplies their explicit dependencies, assembles the complete command table and installs lifecycle events. Business commands and mutable domain state live with their owning Modules. There is no remaining core business switch or shared background context.

| Module | Responsibility | Callers know |
| --- | --- | --- |
| `provider-sync-runtime.ts` | Running sync promises, polling, notification connections, token refresh validation and serialized pause persistence | Synchronize, pause, cancel and request background work |
| `provider-sync-activity.ts` | Shared activity ownership for sync, Passkey refresh and project recovery | Reserve, test signal ownership, abort and release the same owner |
| `attachment-runtime.ts` | Download routes, uploads, completion receipts, chunk limits, transfer orchestration and cleanup | Explicit attachment commands and lifecycle cleanup |
| `bitwarden-send-runtime.ts` | Send operations and temporary file-upload metadata | Explicit Send commands and cleanup |
| `command-router.ts` | Default sender denial and queued MDBX write protection | Execute a typed request with its selected handler |
| `request-access.ts` | Web-page allowlist, extension-page and manager-page assertions | Apply the same sender policy across command modules |
| `keepass-runtime.ts` | KeePass sessions, working copies, durable mutation queues, pending persistence and recovery workflows | Mutate exclusively, flush, wait for idle, reconcile and invalidate |
| `keepass-command-runtime.ts` | KeePass file opening, group/history management, export and locking; OneDrive commands | Typed manager commands |
| `bitwarden-runtime.ts` | Account identity, login, folders/collections, session persistence, cipher projection and attachment keys | Typed account commands and session/projection operations |
| `identity-flow-runtime.ts` | SSO, WebAuthn/Duo continuations and browser identity flows | Complete one authentication flow |
| `mdbx-runtime.ts` | Browser/native backend routing, MDBX handles, cloud adapters, file exports and restore coordinators | Source operations and backend-bound adapters |
| `mdbx-file-runtime.ts`, `mdbx-sync-runtime.ts`, `mdbx-object-runtime.ts` | MDBX file lifecycle/import, cloud connection/bootstrap, and collections/objects/history/snapshots | Separate typed manager command tables |
| `transfer-runtime.ts` | Local, KeePass, Bitwarden and MDBX batch transfers and temporary progress state | Typed transfer commands; clear sessions or status explicitly |
| `project-runtime.ts` | Password-project removal/restore, source recovery before sync and recovery downloads | Typed project commands and one recovery callback |
| `credential-runtime.ts` | Save candidates, stepped usernames, expiry, session persistence and confirmation | Typed page commands; clear candidates and usernames |
| `autofill-runtime.ts`, `autofill-policy-runtime.ts` | Current-document targeting, login/wallet filling, inline menus and site/field policies | Typed fill/policy commands and policy checks |
| `passkey-runtime.ts` | Request acceptance, document/session identity, signing, cancellation, source queues and completion races | Typed page commands and lifecycle cancellation |
| `passkey-journal.ts`, `passkey-state-types.ts` | Pending requests and prepared/committed completion receipts, persistence, expiry and restart reconciliation | Load/store/reconcile receipts; no mutable Maps |
| `passkey-verification-runtime.ts`, `passkey-errors.ts` | User-verification prompts, password/Hello checks and shared error identities | Verification operations and typed manager commands |
| `vault-runtime.ts`, `vault-item-runtime.ts`, `provider-command-runtime.ts`, `steam-runtime.ts` | Vault identity/export/restore, item management, provider management and Steam operations | Distinct typed command tables |
| `live-views.ts`, `command-effects.ts`, `events.ts` | Port ownership/visibility, request effects and browser lifecycle/message response wiring | Publish/invalidate views and install explicit lifecycle callbacks |

State stays private to the module that changes it. Source adapters continue to own their encryption and file-format implementation. The shared local-attachment adapter is injected once so normal downloads and cross-source transfers observe the same cleanup lifecycle. Runtime dependencies are explicit and limited to source adapters, vault operations and recovery/persistence callbacks; callers do not receive the private maps.

Every top-level request crosses `createCommandExecutor` before dispatch. An MDBX direct write holds `ProviderOperationQueue`, checks both Bitwarden-move recovery and nearby native sequencing, then invokes the selected handler with native ownership metadata. The batch-transfer target-type check consumes that metadata. Internal attachment operations invoke their own handlers through the same executor rather than reconstructing a call to the global dispatcher. The outer attachment transfer does not hold the native queue while its nested writes acquire it.

Synchronization, Passkey refresh and project recovery share `ProviderSyncActivity`. A late canceled operation cannot remove a replacement owner. Passkey paths that already hold the provider queue use the runtime's direct execution entry; calling its queued synchronization entry there would re-enter the queue.

Command coverage has two checks: TypeScript requires complete domain-handler maps and an aggregate `CommandHandlers<ExtensionRequest>` table; `scripts/runtime-command-audit.mjs` follows the actual entry, composition, factory construction, returned tables, dispatcher and browser listener. It requires exactly one handler per declared command, including intersection-type declarations. The audit rejects missing/duplicate tables, disconnected construction, default-denial removal, disabled native classification/conditions, lost queue ownership, replaced lifecycle dependencies, disconnected Passkey cancellation, weakened manager imports/checks and missing confirmation. Its negative fixtures run from `npm run test:security`.

Some callbacks point forward to Modules constructed later, notably sync, live views and Passkey journal cancellation. Only those dependencies use getters. Constructors retain these callbacks; business operations read them after assembly. Modules import other runtime Interfaces using TypeScript types and never import `index.ts` or `composition.ts` back. Keep construction free from new eager reads of deferred dependencies.

The lifecycle Interface includes ordering. Explicit vault lock awaits username/Passkey cancellation before locking the service; automatic lock preserves still-valid unlock prompts. KeePass lock flushes, pauses sync, waits for its mutation queue, then locks and clears. Restore captures the old Hello binding, clears source sessions, restores, revokes the old binding, then clears page requests. These different orders remain explicit rather than hidden in one generic cleanup registry.

Save candidates follow tab/frame/origin rules for lookup and permit top-frame confirmation after same-origin navigation; stepped usernames are inherited only from a different document. Passkey requests require the exact current document instead. A successful HOTP field fill consumes its counter before another field's failure is reported. Do not unify these distinct policies during later refactors.

Changes to these modules should retain behavioral regressions for manual sync following a running snapshot, cancellation before projection, concurrent pauses, stale notification refreshes, upload retries, completion replay, handle ownership and internal native transfer writes. Browser regressions cover actual MV3 restart, SignalR transport, provider locks, attachment encryption and Passkey continuation. Static source audit complements these tests; it does not substitute for them.
