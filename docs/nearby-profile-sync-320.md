# Portable collection profiles through existing Android metadata

The extension now projects complete native profiles into the existing folder/root record payload, using `monica_native_collection` for versioned metadata and an ordinary asset descriptor for exact binary bytes. No Android wire operation, production source, capability registration or Tiga setting changes.

## Ownership and restoration

- Native folder profiles restore through the atomic profile command introduced in `3279828`. The profile itself stores the bytes; no duplicate attachment is created. Native source assets are read again through the policy/revision-checked profile API when requested, rather than serving the captured plaintext.
- A foreign root's configuration is retained as metadata and its own ordinary attachment. It does not set the shared native root profile or presentation. Attachment ownership remains partitioned by source record, including identical content from different roots.
- The original profile ID, schema/type/capability declarations, hash, device/timestamp/commit provenance, and arbitrary binary payload survive forwarding. The descriptor also retains unknown fields. Native-generated adoption timestamps do not replace the received provenance while profile semantics remain unchanged.
- `device_sync_collection_applied` is a local marker. Unapplied Android metadata/file archives keep their original presentation. After native restoration, actual changes to the native favorite/archive/icon fields become outgoing changes. A missing previously applied native profile fails explicitly.
- Current Android `DeviceNativeMetadataContent` copies unknown payload data, owns attachment mappings and forwards exact file bytes. This implementation uses those existing mechanisms; source inspection is not counted as a new Android application acceptance run.

## Finite native write boundary

The 16 MiB native sync delta limit includes encrypted rows and serialized version snapshots. In the initial real Edge acceptance, combining two independent 1 MiB root archives caused the native transaction to fail; the failed log and trace are retained. Each individual archive subsequently succeeded.

The planner now requests splitting independent records before durable staging whenever a profile archive is present. A profile operation currently accepts one incoming record, at most 1 MiB of copied binary data and a 32 KiB JSON plan. Existing dependency groups are not torn apart, and native write failures are never retried under a different operation ID. Metadata for a supported full 1 MiB profile fits these limits.

This is a conservative restoration boundary, not a claim that every larger combination is impossible natively. Larger profile/file combinations and dependent groups still require a recoverable multi-step restoration strategy. They stop before creating a durable intent. Profiles requiring unavailable capabilities also remain blocked as native folders; foreign-root archives remain passive. Full task 93 and full Wi-Fi closeout remain in progress.

## Acceptance

The real Edge test exercises a full 1 MiB binary profile through native projection, local metadata adoption, JSON state restore, forwarding, native atomic adoption and browser restart. The folder contains a password and an ES256 Passkey; production dependency grouping, scheduling and bounded adoption restore the folder before its contents. The original private key, credential identity, public key, signature and positive counter 19 remain valid. It also verifies stable outgoing metadata, exact bytes, two foreign-root owners sharing content, planner splitting, and deletion of one root without changing the other's profile or bytes. Synthetic isolated profiles only; no user Chrome vault, Android emulator or live account is used.

Consolidated verification on 2026-10-15:

- 288 unit cases across 16 files passed, including nearby synchronization, local adoption/origin security and the content-write boundary.
- Three real Edge scenarios passed: production Wi-Fi coordinator (37.8 seconds), atomic native profile import/write/restart (16.0 seconds), and populated-folder profile forwarding/restoration/root isolation (17.6 seconds). Four owned test profiles were automatically deleted after the run.
- Main, interoperability and strict E2E TypeScript checks passed, as did the production build and source/artifact provenance checks. Security audit passed for 219 runtime commands, 24 manager-only project commands and the dedicated nearby port.
- Evidence is retained under `.artifacts/profile-sync/`, including `unit-final.log`, `edge-final.log`, `edge-final-results/`, `production-final.log`, `security-final.log` and the earlier failed native batch trace. The final E2E evidence records that Android application acceptance was not performed.

The native engine remains the verified build from `3279828`: 6,426,095 bytes, SHA256 `544aafc8177954d0b9bd4c0d673a4569a50bb4c375d9a21b9ef51f5b98e397de`. No Rust source changes or rebuild were needed for this TypeScript integration. The local `dist` includes the integration; public 0.1.39 Preview is unchanged. No push, tag or release was performed.
