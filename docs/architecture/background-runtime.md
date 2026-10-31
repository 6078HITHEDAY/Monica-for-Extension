# Background runtime ownership

The background worker composes source adapters and workflows, wires browser lifecycle events and selects command handlers. This first refactor concentrates synchronization and attachment state in their owning modules. Remaining vault, KeePass and Passkey command implementations still live in `src/background/index.ts`; they can be migrated in separate batches without expanding a shared global context.

| Module | Responsibility | Callers know |
| --- | --- | --- |
| `provider-sync-runtime.ts` | Running sync promises, polling, notification connections, token refresh validation and serialized pause persistence | Synchronize, pause, cancel and request background work |
| `provider-sync-activity.ts` | Shared activity ownership for sync, Passkey refresh and project recovery | Reserve, test signal ownership, abort and release the same owner |
| `attachment-runtime.ts` | Download routes, uploads, completion receipts, chunk limits, transfer orchestration and cleanup | Explicit attachment commands and lifecycle cleanup |
| `bitwarden-send-runtime.ts` | Send operations and temporary file-upload metadata | Explicit Send commands and cleanup |
| `command-router.ts` | Default sender denial and queued MDBX write protection | Execute a typed request with its selected handler |
| `request-access.ts` | Web-page allowlist, extension-page and manager-page assertions | Apply the same sender policy across command modules |

State stays private to the module that changes it. Source adapters continue to own their encryption and file-format implementation. The shared local-attachment adapter is injected once so normal downloads and cross-source transfers observe the same cleanup lifecycle. Runtime dependencies are explicit and limited to source adapters, vault operations and recovery/persistence callbacks; callers do not receive the private maps.

Every top-level request crosses `createCommandExecutor` before dispatch. An MDBX direct write holds `ProviderOperationQueue`, checks both Bitwarden-move recovery and nearby native sequencing, then invokes the selected handler with native ownership metadata. The batch-transfer target-type check consumes that metadata. Internal attachment operations invoke their own handlers through the same executor rather than reconstructing a call to the global dispatcher. The outer attachment transfer does not hold the native queue while its nested writes acquire it.

Synchronization, Passkey refresh and project recovery share `ProviderSyncActivity`. A late canceled operation cannot remove a replacement owner. Passkey paths that already hold the provider queue use the runtime's direct execution entry; calling its queued synchronization entry there would re-enter the queue.

Command coverage has two checks: TypeScript requires complete domain-handler maps and exhaustiveness for the remaining core request union; `scripts/runtime-command-audit.mjs` inspects the production wiring and requires exactly one handler per declared command, including intersection-type declarations. The audit rejects missing or duplicate handlers, disconnected handler tables, default-denial removal, native-guard bypass, weakened manager restrictions and missing confirmation. Its negative fixtures run from `npm run test:security`.

Changes to these modules should retain behavioral regressions for manual sync following a running snapshot, cancellation before projection, concurrent pauses, stale notification refreshes, upload retries, completion replay, handle ownership and internal native transfer writes. Browser regressions cover actual MV3 restart, SignalR transport, provider locks, attachment encryption and Passkey continuation. Static source audit complements these tests; it does not substitute for them.
