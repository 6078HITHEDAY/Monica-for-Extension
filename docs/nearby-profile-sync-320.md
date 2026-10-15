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

The planner splits independent records before durable staging whenever a profile archive is present. Larger single metadata records now use a [recoverable sequence](nearby-write-anchor-320.md): initial collection/tag changes, bounded file writes, profile/presentation, and finally ownership metadata or trash. The complete sequence is encrypted before its first write. Each step retains its operation identity and derives its revision from the preceding receipt; only the final step publishes the acknowledgement. Deletion and rename budgets also account for retained native file bytes.

Each step is limited to 1 MiB of binary content and a 32 KiB JSON plan, with at most 68 steps and the existing aggregate asset/journal limits. A 1 MiB profile plus separate 1 MiB ordinary file is now supported, including interruption after the first commit, actual browser restart and automatic completion. Whole password/dependency groups are not torn apart. An older engine lacking any capability needed by a later step is rejected before any intent is persisted. Normal native mutations and cloud sync are blocked while that source has a pending sequence, including aliases for the same vault.

These are conservative bounds, not a claim that larger individual files cannot ever fit natively. Individual files above the step limit, larger metadata plans, coupled dependency groups and profiles requiring additional capabilities still need further work. A genuine intervening native edit leaves the remaining sequence intact and cannot be silently rebased; conflict-resolution recovery remains outstanding. Full task 93 and full Wi-Fi closeout remain in progress.

## Acceptance

The real Edge test exercises a full 1 MiB binary profile through native projection, local metadata adoption, JSON state restore, forwarding, native atomic adoption and browser restart. The folder contains a password and an ES256 Passkey; production dependency grouping, scheduling and bounded adoption restore the folder before its contents. The original private key, credential identity, public key, signature and positive counter 19 remain valid. It also verifies stable outgoing metadata, exact bytes, two foreign-root owners sharing content, planner splitting, and deletion of one root without changing the other's profile or bytes. Synthetic isolated profiles only; no user Chrome vault, Android emulator or live account is used.

Consolidated verification on 2026-10-15:

- 288 unit cases across 16 files passed, including nearby synchronization, local adoption/origin security and the content-write boundary.
- Three real Edge scenarios passed: production Wi-Fi coordinator (37.8 seconds), atomic native profile import/write/restart (16.0 seconds), and populated-folder profile forwarding/restoration/root isolation (17.6 seconds). Four owned test profiles were automatically deleted after the run.
- Main, interoperability and strict E2E TypeScript checks passed, as did the production build and source/artifact provenance checks. Security audit passed for 219 runtime commands, 24 manager-only project commands and the dedicated nearby port.
- Evidence is retained under `.artifacts/profile-sync/`, including `unit-final.log`, `edge-final.log`, `edge-final-results/`, `production-final.log`, `security-final.log` and the earlier failed native batch trace. The final E2E evidence records that Android application acceptance was not performed.

The initial archive integration used the engine from `3279828`. The subsequent continuation boundary `31774ae` rebuilt the engine to 6,438,366 bytes, SHA256 `7f77518a66ff614909136194cda71adac76ffac0c5100ee911d98a3a228a46f6`. The sequence/journal integration adds no further native changes. Local `dist` is updated; public 0.1.39 Preview is unchanged. No push, tag or release was performed.

Sequence acceptance added 311 passing TypeScript cases across 17 files, main/interoperability/strict E2E types, production build and the security audit. The production coordinator passed in 43.8 seconds. The populated-folder scenario passed in 27.8 seconds; an expanded run exercising automatic native-adapter adoption for both foreign roots passed its assertions in 27.6 seconds. It preserves the original password, Passkey key/identity/signature/counter 19, both 1 MiB byte streams, encrypted journal restart recovery, stable forwarding and isolation when purging one source. The last run's global cleanup initially stopped because a transient browser process had no readable command line. A fresh complete process inventory allowed the existing scoped cleanup to remove its one owned profile; no cleanup guard was weakened. Test and cleanup evidence are retained separately under `.artifacts/write-anchor/`.

The first expanded sequence test still executed only the first purge step through its old fixture call and correctly failed projection because an owned asset was then missing. The fixture now uses the actual journal recovery path for the entire purge. Its failure log and trace remain in `sequence-edge.log` and `sequence-edge-results/`.
