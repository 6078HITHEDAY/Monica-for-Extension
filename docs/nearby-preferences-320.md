# Encrypted nearby identity and peer preferences

Internal foundation, 2026-10-15; extension development version 0.1.37. No production coordinator or nearby settings entry point is enabled by this block.

The encrypted vault now retains a stable device identity, native replica storage identity/key, local provider selection, direction, interval, exact Android signed-Long settings/request counters and up to eight paired devices. Preference creation defaults to automatic networking disabled and performs no networking. Public projections explicitly omit replica secrets, storage handles and pairing keys.

Preference changes use a current vault session and a saved compare-and-set epoch. Forgetting a peer invalidates outstanding results, including pending enrollment. Existing peer keys cannot be silently replaced, synchronization history cannot regress, and lost persisted replies recover through the saved state. Source snapshot hashes include the epoch so later setting changes invalidate pending application adoption. Receiving a remote interval uses Android's version/writer order and cannot re-enable automatic sync. The native wire projection preserves counters beyond JavaScript's safe integer range through lossless JSON.

Saved preferences are validated during vault migration/decryption. Unknown versions, malformed keys/counters, duplicate identities and invalid fields stop loading without overwriting or silently resetting encrypted trust. Portable backup restoration keeps vault content and content receipts but removes the old device identity, replica credentials and peer trust. Explicit reinitialization creates a new disabled identity, avoiding two installations impersonating the same nearby replica. Ordinary browser/service restarts preserve the existing identity.

## Validation

- 230 distinct tests across eleven affected files passed: the initial broad run passed 229 tests, followed by 29 targeted tests after adding the source-epoch guard and remote empty-name compatibility. Coverage includes concurrent initialization, encryption, stored-reply loss, restart, stale writes, lock, quota failure, backup restoration, invalid trust state, exact Long values, peer key/history protection and forgetting.
- Real installed Edge 155.0.4283.45, final two-case run: local content adoption 8.6 seconds and identity/trust 8.4 seconds. The new harness uses real Native Messaging and Noise pairing between two isolated empty vaults, persists actual pairing results, deliberately loses a persisted trust response, closes both browsers/native processes, then reconnects with saved trust and completes acknowledgement. Another authenticated connection attempts to save after the user forgets its peer and is rejected. Automatic sync remains disabled, with no page errors. Native Messaging registration is restored.
- The existing content acceptance remains green: six records, a 600,000-byte file, original Passkey signature/counter and project links survive persisted-reply loss, restart and later-edit replay.
- Project/interop and strict affected E2E types passed; normal release build and bundled-engine provenance passed. Runtime security audit remains at 219 commands; no new runtime command exposes preferences or pairing secrets. Existing bundle-size warnings remain.

Evidence: `.artifacts/nearby-preferences-20261015/final/nearby-preferences-encrypt-13548-d-reject-stale-resurrection/evidence.json` and the adjacent local-adoption evidence. Logs under `.artifacts/`: `nearby-preferences-regression-20261015.log`, `nearby-preferences-final-focused-20261015.log`, `nearby-preferences-edge-final-20261015.log`, `nearby-preferences-release-build-20261015.log`.

Failures retained: an incorrectly transcribed synthetic key failed canonical-key validation and was replaced with generated test bytes; the initial empty-vault browser test attempted acknowledgement before native replica merge and was correctly rejected, then fixed to merge/check no pending records before acknowledgement. A test-only access to a union's password field failed TypeScript and was changed to a structural assertion. The final compatibility check accepts an empty remote device name, matching the native protocol, while local display names must remain nonblank.

## Baseline and remaining work

Read-only Android baseline: `c791b28f3a39b814c5dde28f51f2eeb3349322e1`, development 1.0.320. Clean source hashes under `Monica for Android/app/src/main/java/takagi/ru/monica/lansync/`:

| File | SHA-256 |
| --- | --- |
| DeviceSyncPreferences.kt | 0427c23bc3a6c89e756784fb9c0bb224b3b4c840d27dcc915055994f77adb605 |
| DeviceSyncCoordinator.kt | 31b2ff925c14ce885d13eaed070e0cf838e3201d8c55480b2df70ea3f4cf6c6e |

The production coordinator still must own the dedicated transport, enforce authenticated progress/content adoption before remembering a peer, bind source/session/recipient consent, cancel sessions on setting changes and lock, and handle full catalogs and pagination. The saved-state transition API is internal; an `enrollment` flag supplied by an arbitrary UI is not proof of authentication and must never become a runtime command. This block's harness uses authenticated native progress but is not production orchestration or Android application acceptance.

Only the current local adapter can be selected. MDBX source/catalog selection, folder/root metadata adoption, archival local-source records, conflict/restore flows and Canvas-designed UI remain open, as do current Android/F-Droid and direct OneDrive/backend acceptance. No Android operations, user Chrome/accounts/vaults, publication or cache deletion occurred.
