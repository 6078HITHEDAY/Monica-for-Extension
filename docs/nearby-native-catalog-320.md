# Native nearby source catalog and metadata planning

Status: internal groundwork, verified 2026-10-14. The production nearby
coordinator does not yet call these modules. This does not enable MDBX nearby
synchronization in the released extension or complete Android parity.

## Source and record mapping

`src/nearby/native-source.ts` captures native collections, objects, labels,
assignments, relations and attachment metadata at one content revision. It
reads the native authority rather than the user-facing item cache, validates
pagination and ownership, and rechecks the revision after disclosure. Available
payload JSON is retained verbatim, including unknown types and schema versions.
Deleted records retain their summary and an explicit `null` payload because
the native access policy prohibits disclosure; this is never a purge record.

Inventory limits are 10,000 collections, 10,000 objects, 32 MiB aggregate data
and 1 MiB per disclosed object. Cancellation is checked across reads. The root
identity follows Android's `UUID.nameUUIDFromBytes("monica-root:" + vaultId)`;
MD5 is used only for this existing routing identity, not cryptographic integrity.

`native-records.ts` maps supported records through the existing application
codec, preserving password fields, history, precise JSON numbers, folder paths,
labels, relations and portable attachment identities. Asset bytes are represented
by lazy native references. Only declared image/icon slots are remapped, leaving
password text intact. Passkey private/public keys, credential IDs, zero counters
and positive histories are retained. Connector-owned and staging records have
explicit exclusions.

The projection also reports blockers. `requireCompleteNearbyNativeProjection`
must succeed before a replica scan: omission must not become a remote deletion.
Current blockers include unavailable deleted payloads, unsupported types/schema,
unassigned label archives, folder/root assets, nondefault folder profiles and
unavailable image references. Reporting these blockers is an interim safeguard;
their lossless synchronization remains unfinished.

## Folder and root metadata planner

`native-metadata.ts` projects Android folder paths and separately owned root
tags. Root ownership is identified by UUID, not a special-looking title. It
preserves saved root data, opaque marker fields, unrelated labels and folder
asset guards, and rejects ambiguous ownership or folder cycles.

The pure planner checks each local guard, creates ancestors before children,
supports restore/move/rename/deletion, and updates only the selected root tag
owner. Sibling title collisions use a UUID suffix plus Android's logical-title
marker. An existing marker is refreshed even when the user intentionally adopts
the stored suffixed name, so recapture cannot revive the old logical name.
Generated label IDs derive deterministically from the operation ID.

Plans are capped at 128 commands and 8 MiB. Unsupported folder fields or metadata
assets are refused rather than silently dropped. Callers must use the captured
revision with `writeMdbx2Content`, recover its durable native receipt, and only
then acknowledge synchronization. The core's 16 MiB encoded sync-delta limit
still applies independently of staging limits.

## Verification

- 235 distinct affected TypeScript cases passed across the consolidated run
  (232 cases in 10 files), two additional asset blockers and the final rename
  regression. The final affected run passed all 60 cases in three files.
- The rename regression first failed against the unfinished planner; its repair
  preserves unknown marker fields and schema version. The failure log is kept.
- Main/interop types and strict changed E2E/worker types passed after the repair.
- Actual installed Edge 155.0.4283.45, compiled browser engine: final scenario
  passed in 5.5 seconds (9.0 seconds including runner). It exercised atomic folder
  and root metadata writes, collision names and their later rename, root tag
  isolation, nested paths, stale-revision rejection, a retained deleted record,
  an unassigned future label and a 280,000-byte folder attachment. After a real
  browser restart, the original Passkey key and credential still signed with
  counter zero; attachment hashes and unrelated metadata were unchanged.
  Persisted block scanning found none of the synthetic plaintext sentinels.
- Production build, bundled-engine provenance and static security audit passed:
  219 runtime commands, 24 manager-only project commands, and the dedicated
  nearby manager port. The new test fixture commands are not product RPCs.
- Final Edge teardown deleted its owned profile. The audit-profile directory was
  empty before the run. Earlier cleanup reclaimed 24.641 GiB; no additional
  cache reclamation is claimed here. The separately blocked Rust incremental
  deletion remains recorded in `.artifacts/content-attachments-cache-cleanup.json`.

Commands:

```text
npx vitest run src/nearby src/providers/mdbx2/content-metadata.test.ts src/providers/mdbx2/content-attachments.test.ts src/providers/mdbx2/content-write.test.ts --maxWorkers=2
npx vitest run src/nearby/native-source.test.ts src/nearby/native-metadata.test.ts src/nearby/native-records.test.ts --maxWorkers=2
npm run build
npx tsc -p .artifacts/nearby-native-catalog-e2e.tsconfig.json --pretty false
node scripts/security-audit.mjs
npx playwright test tests/e2e/nearby-native-catalog.spec.ts --workers=1 --output=.artifacts/nearby-native-catalog-closeout-edge
```

Local evidence: `.artifacts/nearby-native-catalog-{unit-final,final-regression}.log`,
`nearby-native-catalog-title-red.log`, `nearby-native-catalog-closeout-*.log`,
and the final Edge run's `isolated/evidence.json`. This is affected-scope testing,
not another full extension suite or Android application acceptance run. Native
sources and the compiled engine were unchanged during this block.

## Remaining integration

Complete native object/label/relation/asset adoption, origin archive restoration,
deleted-content policy reconciliation and durable receipt adoption/recovery.
Then generalize the local-only coordinator, preferences, pending bindings and
service methods. MDBX selection must remain unavailable until that path is safe.
The nearby UI/scheduler, current Android/F-Droid bidirectional acceptance and
direct OneDrive/backend matrix remain separate unfinished work. No Android,
personal browser, account or vault was modified; no new release was published.
