# Nearby local folders, root metadata and tombstones

This development block follows the production [manager owner](nearby-manager-owner-320.md). Android's nearby catalog includes standalone `folder` and `vault-metadata` records, including empty categories and database root tags. Treating every incoming record as a password item rejected those catalogs. The local adapter now persists these records separately in the encrypted vault and exports them with their portable identities. There is no additional runtime command or user-facing nearby page.

## Application behavior

- Preserve nested folder paths, independent same-name categories, empty folders, folder/root tags, labels, relations, unknown payload fields and attachment data. JSON object ordering may be canonicalized by the native protocol; opaque JSON strings and lossless numeric values are retained. Metadata never becomes a fake password item.
- Existing local categories are included in source snapshots. Reciprocal updates reuse their numeric IDs, and legacy categories identified only by name retain their original binding through paginated content adoption. New local category allocation reserves IDs from deleted metadata so a later import cannot reuse a deleted folder's identity.
- Stage content pages before standalone metadata pages. A category rename or deletion may affect many items; applying it after content avoids invalidating the original guards of entries still waiting in a later page. Connected password projects retain the existing 200-record transaction limit without grouping every member of a large folder into one project.
- Empty tombstones do not contain password-project fields. The coordinator recovers their grouping identities from authenticated local bindings before pagination, so a project deletion is not split across the 200-record boundary.
- Apply a folder rename to its original category and members. Deleting the folder removes its membership from local items while retaining the items and the folder's tombstone. Restoring the folder does not silently put independently unclassified items back into it. Hierarchical path metadata remains available for later native MDBX adoption.
- Accept Android's empty deletion payloads. Known content/folders use their authenticated previous projection, retaining original content and attachment bytes where available. Unknown empty tombstones are kept as independent encrypted sync metadata; they do not create a visible item. A later authenticated resurrection can establish the actual content item while keeping its global identity.
- Save metadata, folder membership and acknowledgements in the same encrypted application transaction. Exact receipt replay recovers a committed response that was lost. Corrupt metadata/identity/receipt state fails validation instead of resetting identities or losing recovery information.

Metadata-only records and ordinary content share the existing session/source guard and manager cancellation checks. Native sockets, permissions and the Native Host protocol are unchanged. The coordinator now exposes only the existing bounded data-error codes, rather than collapsing a validated application failure into an undiagnosable generic error; native messages and secrets remain redacted.

## Portable backups

Real reciprocal testing exposed a pre-existing restore problem: a portable backup creates a new native replica, but its retained local receipts still contained the former replica's vector clocks. A normal returned edit was rejected as `adoption-clock-regression`.

Portable restore now invalidates only receipt replay/history authorization. It retains item IDs, metadata IDs, baselines, attachments, original credential IDs, keys and signing counters. The new authenticated replica establishes its own history on the next adoption. Ordinary restart keeps its original receipt history and durable replay. A regression test first reproduced the clock failure and then passed with the restore fix.

## Evidence

Read-only Android contract baseline: `c791b28f3a39b814c5dde28f51f2eeb3349322e1`, development 1.0.320, particularly `DeviceRoomVaultMetadata`, `DeviceNativeRootMetadata`, `DevicePasswordSyncProvider` and `DeviceVaultShape`. No Android source, APK or device was changed in this block.

Installed Edge 155.0.4283.45 acceptance used two isolated profiles, the production `dist/background.js`, actual Native Messaging/Noise transport, and synthetic encrypted backups seeded with the Android-shaped catalog. It verified:

1. Independent nested same-name folders, an empty folder, root tags containing opaque large-number/decimal JSON, an empty tombstone, a 600,000-byte attachment and a portable Passkey reach the other browser.
2. Original credential/private-key bytes and a signature verified by the original public key survive. The positive-19 credential is not exported, and source counters remain 0 and 19.
3. Both browsers/native processes restart, reuse pairing, and send an edited login back into its original item ID. Folder IDs, item IDs, metadata and attachment integrity remain intact.

Evidence: `.artifacts/nearby-metadata-edge-restored/`, `.artifacts/nearby-metadata-edge-final-build/` and the final tombstone-aware build under `.artifacts/nearby-metadata-edge-tombstone-final/`; each has an `evidence.json` explicitly recording `productionBackground: true`, `managerUi: false` and `androidApplicationAcceptance: false`. Native registration was restored after every run. The separate production-owner scenario also passed during this block.

The concurrent full unit run passed 3,693 of 3,694 tests; one existing Bitwarden project-batch case reached its five-second timeout. Its four-test file passed immediately in isolation. Five further regressions were added afterward. Final affected checks passed 199 distinct tests across nine files, including 14 dedicated metadata tests: encrypted restart/replay, stale bindings, empty tombstones and project grouping, numeric and legacy category pagination, portable restore and deleted-ID reservation. Project/interop types, strict affected E2E types, production build, bundled-engine provenance and the security audit (219 runtime commands / 24 manager-only project commands plus the nearby port) passed.

The first browser comparison incorrectly required JSON object property order to survive Rust serialization; the corrected check compares lossless parsed values and still requires opaque payload strings to be identical. The next run revealed the actual portable-restore clock bug above. Both failures and their follow-up evidence remain local.

## Remaining scope

This completes the local adapter's metadata path, not full Android parity. Native MDBX catalog/adoption and its application of folder/root metadata, archived local-origin records, conflict/restore workflows, nearby UI/automatic scheduling, current Android/F-Droid application acceptance and direct OneDrive/backend acceptance remain unfinished. Already-published 0.1.38 notes, tag and assets are unchanged; this block is subsequent development. No user Chrome/accounts/vaults, cache deletion, new native build or publication occurred.
