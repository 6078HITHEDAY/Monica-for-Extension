# Nearby content mapping and encrypted local adoption

Status: internal integration foundation, 2026-10-15. Extension development version remains 0.1.37. Nearby synchronization is **not available in the production manager UI**. No Android application acceptance is claimed by this block.

## Implementation

The application codec maps Android's fourteen nearby entry types, legacy password/secure-item envelopes, rich password projects, history, API-token companion labels and exact JSON numbers. Folder and vault-root metadata are recognized without pretending they are ordinary item upserts. Native catalog inconsistencies fail explicitly. Unknown business fields remain alongside the editor projection; known local routing fields are removed from export. The timestamp adapter checks parsed date bounds but is not proof of identical Android date parsing.

Passkey processing verifies original private/public key correspondence for ES256, Ed25519, RS256 and PS256, deriving only a missing public cache. It never creates replacement credentials. Incoming metadata cannot change the credential identity or user handle, remove an existing portable key, reduce counters/high-water marks, or conflict with known backup eligibility. Deliberate zero counters remain zero. Recipient/session-bound review considers equivalent positive-counter copies and rejects stale confirmations. Positive-counter export exclusion is still enforced by the existing Native Host. Only recognized device references may become metadata-only records; corrupt portable keys fail instead.

The local adapter captures actual editor items and attachments, excluding external-provider entries. It stores received items, verified complete attachment bytes, original wire data, editor baselines and recovery acknowledgements in one encrypted vault transaction. Note, SSO and OTP references resolve after all batch items are staged. Invalid clocks, stale source hashes, unresolved references, pending local mutations, corrupt assets or lock changes prevent partial persistence and acknowledgement. Exact retry uses the saved acknowledgement without overwriting subsequent edits, including after a browser restart and loss of remote scratch files.

Review found an API-token re-export defect: edited metadata was compared against old companion labels before being updated. The local editor now applies its intentional metadata/favorite changes first, retains unknown companion fields and other labels, and leaves source labels untouched. Native catalog inconsistency checks remain strict.

## Source baseline

Read-only Android source baseline: `Monica-main` HEAD `c791b28f3a39b814c5dde28f51f2eeb3349322e1`, development 1.0.320. These files under `Monica for Android/app/src/main/java/takagi/ru/monica/lansync/` were clean when inspected:

| File | Raw SHA-256 |
| --- | --- |
| DeviceVaultShape.kt | 8e8c250776e563316bb461f2490f55825bad5a9f2ba68462266437f82caa4d02 |
| DevicePasswordShape.kt | 90a501763103c7db01ab356e093a8f5d9123ebE192b25451e07b912ef42f7276 |
| DevicePasskeyShape.kt | 5559eed0bc2f0609a0496034774bc9c3451229ea13b3bfd606952f2c5f152378 |
| DevicePasskeySyncConsent.kt | 4d0d5045d9ec8aac06901857c2ea6b75ce50758215d1cc7300dce831f8689f61 |

No Android source, build, emulator or device was changed. No Rust source or executable was rebuilt in this block. Native replica pagination deliberately retains lexicographic cursor order; the adapter stages a complete batch before resolving its references.

## Validation

- 203 distinct affected tests across nine files passed before final review; the final API-token edit repair passed 74 tests across five files (including 12 additional API-token regression tests). Total: 215 distinct tests across ten files.
- Normal extension build, project/interop types and strict types for the new browser harness passed. Bundled-engine provenance and extension page checks passed. Existing bundle-size warnings remain.
- Runtime security audit passed with 219 commands; no new UI/runtime command exposes the internal adoption API.
- Real installed Edge 155.0.4283.45: source-bundled integration harness using actual Native Messaging, Noise TCP transfer and `SecureVaultService` encrypted IndexedDB. Six records and a 600,000-byte file arrived, the persisted reply was deliberately lost, and the receiving browser/native process restarted. Complete project links, original private/credential/public bytes, zero counter, attachment hash and actual signature verification survived. A saved acknowledgement then cleared native pending state without rewriting the encrypted envelope or overwriting a later edit. A separate positive-counter credential remained at the source at 19. No page errors. Temporary Native Messaging registration was restored.

Evidence: `.artifacts/nearby-local-adoption-20261015/catalog-final/nearby-local-adoption-near-3439b-keys-before-acknowledgement/evidence.json`. Logs: `nearby-local-adoption-regression-20261015.log`, `nearby-local-adoption-final-focused-20261015.log`, `nearby-local-adoption-review-regression-20261015.log`, `nearby-local-adoption-review-build-20261015.log` under `.artifacts/`.

Earlier harness failures remain recorded: missing production crypto-stub alias, missing WASM CSP permission and unsupported `dependency_order` request were corrected in the harness. An icon scanner false positive on a literal JSON schema key was avoided using the existing schema constant. Final strict E2E type invocation required quoting PowerShell comma-separated arguments; the corrected invocation passed.

## Remaining work

This block does not provide the production coordinator, manager settings or consent UI. Subsequent encrypted identity/trust/preferences work is recorded in [nearby-preferences-320.md](nearby-preferences-320.md). Complete native MDBX catalog/attachment adoption, folder/root metadata adoption, multipage/dependency orchestration, archived local-source adapters and conflict/restore flows remain unfinished. Current local application batches are bounded to 200 records and 512 supplied assets and retain existing local attachment limits. Missing dependencies or unsupported archival origins reject the entire operation rather than acknowledging lost content.

Current Android/F-Droid application interoperability and the broader direct-OneDrive/backend matrix remain separate acceptance work. Do not treat this internal harness as production UI or current Android acceptance.
