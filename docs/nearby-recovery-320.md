# Wi-Fi receive recovery checkpoint — 2026-10-16

The extension now distinguishes an uncertain save from a proven conflict and can finish an already-staged receive without a peer connection. Android sources and its wire protocol are unchanged. This is a recovery checkpoint, not full Wi-Fi parity or a release.

## Data and authorization

- New multi-step journals retain each confirmed write, its exact binary inputs and commit receipt until the final operation succeeds. Remaining plus completed data share the existing 68-step, 90 MiB encoded-asset and 8 MiB plan budgets. Intermediate steps never acknowledge the received record.
- A native stale-revision rejection after earlier progress durably marks `native-sequence-conflict`. It retains the exact pending operation/revision, remaining writes, completed inputs and prior acknowledgements. No fresh live revision replaces the original guard.
- Legacy journals still load, but cannot recreate inputs already removed by an older version. The UI explicitly describes remaining-only retention.
- The manager port accepts only a bounded status query or a server-issued pending operation ID. It returns counters and retention/conflict flags, never payloads, binary data, wire clocks, native handles or keys. Existing document ownership, session, cancellation, lock and source checks apply.
- Offline recovery goes through the real coordinator and native adapter without opening a replica, discovering peers, starting a listener or sending an acknowledgement. Successful content receipts remain durable for subsequent ordinary synchronization. A changed operation ID is rejected before writing.
- Pending receives suppress automatic retry loops. Manual retry preserves native policy/revision checks. Ordinary edits/cloud sync remain blocked while a sequence needs recovery.

## Interface

The compact section reports completed/remaining steps, distinguishes current versus legacy retention, and provides “Check and resume receiving” and “Handle later”. Closing or locking the manager clears its view without deleting the encrypted journal. Chinese, English and all six optional language catalogs include the new text. Two previously missing nearby labels were also added.

[Editable local M3E Canvas](design/nearby-recovery-320.md). The saved JSON passes the local editor and its actual rendering was inspected. Production settings were inspected at 420 px using a synthetic encrypted conflict journal; input bytes and operation IDs are absent from the rendered page. Screenshots and test profiles are not committed.

## Verification

- 348 TypeScript tests across 17 files pass: journal persistence/restart, retained bytes, stale/wrong-operation retries, source guards, offline coordinator behavior, manager redaction/validation and all locale catalogs.
- Main/interoperability types and strict E2E types pass. Production build/provenance and security audit pass (219 runtime commands, 24 manager-only project commands and the dedicated nearby port).
- Real Edge native/profile scenario passes in 31.5 s: 1 MiB profile plus 1 MiB file, original password and ES256 Passkey identity/key/signature/counter 19, local forwarding, independent foreign roots, owner-specific purge and actual browser restart. The normal coordinator recovers a staged receive with no LAN calls. A later receive pauses after a binary commit, a real native password edit occurs, then repeated recovery across restart retains both the edit and all completed binary inputs without acknowledging that record.
- Production recovery UI passes in 6.3 s with current/legacy encrypted journals, cancellation/reconnection, lock removal and narrow rendering. It opens the portrait “More” navigation before selecting settings. Native execution is covered separately above; the UI fixture does not claim a real conflict merge. Ordinary production Wi-Fi pairing, discovery, bidirectional item synchronization and cancellation also pass in 15.5 s using actual Native Messaging.
- Local Canvas rendering passes after correcting missing `icon: null` values in the saved document.

Evidence is in `.artifacts/nearby-recovery/`: `unit-complete.log`, `edge-final.log`, `edge-final-results`, `ui-verified.log`, `ui-verified-results`, `ui-final.log` (ordinary Wi-Fi pass), `canvas-final.log`, `canvas-final-results`, `build-final.log`, `security-final.log`, `e2e-types-verified.log`.

Initial failures are retained: the expanded native fixture incorrectly expected all acknowledgements to be empty, despite earlier successful receives; it now verifies the existing receipt set stays unchanged. The first Canvas document lacked required nullable icon fields. Consolidated locale tests exposed missing optional-catalog entries and two existing untranslated nearby labels; all were repaired. No safety assertions or native guards were relaxed.

The first UI run passed, but subsequent runs waited for a hidden settings button on a 420 px portrait layout. Diagnostic DOM evidence proved initialization completed with no script errors and the sidebar was `inert`/`aria-hidden`. Native-backend initialization hypotheses were disproved; the fixture now follows the real “More → Settings” interaction instead of relying on initial responsive-layout timing. A valid isolated browser vault backs startup status checks. Temporary diagnostic instrumentation was removed; diagnostic artifacts and all failed runs remain local.

## Remaining work

An actual intervening-edit conflict is retained and clearly reported, but cannot yet be merged or safely discarded from this UI. Complete retained inputs now provide a basis for that subsequent implementation; repeatedly pressing retry cannot resolve a genuinely changed revision. Large single files, coupled groups, unsupported-capability profile archives and broader Android/F-Droid, multicast and backend acceptance remain outside this completed checkpoint. Native engine sources/WASM were not rebuilt. No Android/AVD operations, user-browser access, outgoing chat messages, push, tag or release occurred.
