# KeePass expired-operation replay protection

Date: 2026-10-11. Extension development version: 0.1.37, unreleased.

KeePass working-copy storage previously discarded the oldest operation receipt when adding a 257th receipt. A later lookup returned `undefined`, which the background mutation coordinator interprets as an operation that has never run. After a worker or browser restart, an old create request could therefore recreate a deleted group. This also makes the old retention strategy unsuitable as the sole journal for future whole-project transfers.

## Change

- Retain at most 256 detailed encrypted receipts as before. When retiring one, retain only its provider ID, operation ID, marker version and expired flag; no title, password, attachment contents or result snapshot enters the marker.
- Store the marker, remove the detailed receipt and replace the encrypted KDBX working copy in the same IndexedDB transaction. A failed marker write aborts all three changes.
- Both receipt lookup and receipt-backed saving reject retired operation IDs with `operation-expired`. The background coordinator checks this before mutating the live KeePass database. Fresh operation IDs continue to work.
- Upgrade IndexedDB from version 2 to 3 by adding `expired-operations`; keep existing working-copy bytes and encrypted receipt envelopes unchanged. Marker lookups use exact keys, and provider cleanup uses an index.
- Acknowledging a live recovery receipt retains its existing semantics, including the reusable `item-sync-pending` ID. Acknowledgement cannot erase an already expired marker. Explicit provider removal clears that provider's file, receipts and markers together.
- Reject a receipt belonging to a different provider before committing working-copy bytes.

The memory implementation follows the same contract. Markers are not subject to the detailed-receipt eviction limit; browser storage quota still applies, and a quota failure must abort the transaction. They are durable replay state, not disposable cache.

## Verification

- Before the fix, the new restart/retention regression failed: after 257 saved receipts, lookup of the original operation returned `undefined`. Evidence: `.artifacts/keepass-receipt-retention-before-20261011.log`.
- 69 tests in seven affected suites passed: storage, receipt cryptography, local and remote working copies, durable synchronization, project removal and project resolution. Evidence: `.artifacts/keepass-receipt-retention-regression-20261011.log`.
- Installed Edge, isolated synthetic origin: migrated a populated version-2 IndexedDB; aborted after queuing a marker write and, separately, after queuing all marker/receipt/file changes; verified that the original bytes and old receipt survived and the new receipt was absent; rejected stale and cross-provider writes; restarted the browser and verified bounded detailed payloads, minimal persistent markers, unchanged later bytes and explicit provider cleanup.
- Installed Edge with the actual production extension: connected a synthetic Argon2id KDBX through the manager UI; executed 257 real runtime mutations (two creates, 254 renames, one delete); restarted the complete browser and reopened the original file through the UI. Replaying the expired creation failed before changing the stored revision or SHA-256. The deleted group remained solely in the recycle bin, the later renamed group survived and a new creation succeeded.
- Both Edge cases passed in 11.8 seconds. Evidence: `.artifacts/keepass-receipt-retention-edge-runtime-20261011.log`.
- Production build, standalone E2E TypeScript check and unchanged 213-command security audit passed. The original `dist` was rebuilt. Build and audit logs: `.artifacts/keepass-receipt-retention-build-20261011.log`, `.artifacts/keepass-receipt-retention-security-20261011.log`.

## Scope and limits

This is a working-copy recovery fix, not completion of KeePass transfer destinations. It rejects expired retries rather than reconstructing their results. Future transfer integration still needs its complete dependency graph, encrypted file preparation, durable publication/adoption and recovery contract.

The migration cannot reconstruct operation IDs already discarded by an older build. The new schema also requires this or a later compatible extension build; a build that opens this database at version 2 cannot read the upgraded database. Acknowledged live receipts and explicit provider removal remain intentional lifecycle boundaries.

No Android source, device, existing Passkey material or zero-counter policy changed. These tests used generated data and isolated Edge profiles; no user Chrome profile, real cloud account or Android interoperability acceptance was involved. No release, push or tag was performed. Full Android alignment remains open, including KeePass/Bitwarden transfer targets, durable foreign moves and nearby-device synchronization.
