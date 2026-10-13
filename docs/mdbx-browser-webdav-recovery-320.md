# Bundled MDBX WebDAV recovery — 0.1.37 development

The production extension now passes WebDAV synchronization between two independent installed Edge profiles using its bundled MDBX engine. The server uses actual loopback HTTP; the extension runtime and database engine are unmodified production assets. All credentials, profiles, records and endpoints are synthetic. No Native Host is registered for this scenario.

## Reproduced failures and fixes

1. **Initial upload stored, response lost.** The encrypted account previously received its sync-state handle only after publication completed. Restarting after a lost response could generate another bootstrap and collide with the immutable remote file. The account now retains the prepared state before reading or uploading it, guarded by the current unlocked session and expected account. Recovery publishes the exact original snapshot; changes made after the interrupted attempt travel as increments. An already committed state returns its authenticated status. No stale whole-account update runs after network completion.
2. **Receive interrupted before attachment completion.** A remote segment can apply before its attachments finish. The next sync previously attempted a local publication first, which the engine correctly refused while acknowledgement was pending. Recovery now finds the exact engine-authenticated pending segment, completes its missing attachments and acknowledges it before preparing local output. Unrelated streams are not advanced or blocked during this recovery; a missing pending segment still stops local publication.
3. **Corrupt partial attachment prevents a corrected retry.** The engine correctly rejected changed bytes, but retained the partial file. The coordinator now calls the existing authenticated receive-abort API after a typed rejected write/finalization or its own completed-download integrity failure. This operation only removes the selected transfer's leased partial file and transfer state; it does not delete completed attachments or clear the pending segment acknowledgement. Ordinary network interruption and uncertain runtime responses retain resumable progress. Cleanup failure preserves the original error and still prevents acknowledgement. No automatic replay of the failed sync is added.

No Rust, cryptographic format or protocol changes were required. Credential IDs, private-key bytes, deliberate zero counters and existing positive counters are unchanged.

## Acceptance

Installed Edge **155.0.4283.45**, production `dist`, two independent encrypted extension accounts and browser databases:

| Scenario | Evidence |
| --- | --- |
| Website registers an ES256 Passkey in browser A; browser B later authenticates after synchronization and full restarts | Original credential ID, PKCS8/SPKI and zero counter retained; actual WebAuthn assertion independently verified against the original public key |
| Existing positive-counter fixture | Separate synthetic key and credential retain counter 19 and exact PKCS8/SPKI; restored private-key signature independently verified. This fixture is not claimed as a website registration or positive-counter website login. |
| Rich password project and attachment | Two related accounts; application, contact and address fields; duplicate protected custom fields and credential metadata; original native object IDs; exact 600,000-byte attachment readback |
| Initial bootstrap PUT stored before socket loss; later local object added before retry | Full browser restart; original bootstrap bytes unchanged, remote version remains 1; later object arrives by increment |
| Attachment GET interrupted after sending 300,000 bytes | Pending acknowledgement and active partial transfer retained; full restart |
| Full attachment with final byte changed | Engine rejects it; pending acknowledgement remains, failed partial transfer removed; full restart and corrected original bytes succeed |
| Browser B edits received project; increment PUT stored before socket loss | Full restart and bidirectional readback; exact immutable increment bytes retained, remote version remains 1 |
| Remote files and requests | Every published object retains version 1; all PUTs use `If-None-Match: *`; no fixture master/database passwords, item passwords or original private-key text occur in published files |
| Legacy native account without backend metadata and unavailable helper | Actual encrypted backup restore; native ownership/handle retained through restart; browser UI still creates, reads, exports, unlocks and imports; unavailable legacy source shown independently |

Final expanded WebDAV case passed in **31.8 s**. The mixed legacy/browser UI case passed in **10.6 s**. There were no page errors. The earlier normal lost-reply/truncation scenario passed in 26.3 s before corruption and positive-counter cases were added; that earlier run is not counted as the final expanded acceptance.

438 affected tests across 36 files passed, including recovery ordering, unavailable pending descriptors, cleanup scope, cleanup failure, network/uncertain-reply retention, provider/account guards and WebDAV helpers. Project/interop types, strict types for both changed E2E files, production build, engine provenance, the 219-command security audit and diff whitespace checks passed.

Local final evidence:

- `.artifacts/mdbx-browser-webdav-20261015/corrupt-recovery/mdbx-browser-webdav-bundle-9f27a-t-replies-and-full-restarts/evidence.json`
- `.artifacts/mdbx-browser-webdav-20261015/security-mixed/mdbx-browser-app-productio-2b24d-ut-an-installed-MDBX-helper/evidence.json`
- `.artifacts/mdbx-browser-webdav-corrupt-recovery-20261015.log`
- `.artifacts/mdbx-browser-webdav-final-regression-20261015.log`
- `.artifacts/mdbx-browser-webdav-corrupt-recovery-build-20261015.log`

Failing runs remain available locally, including the original lost-bootstrap response, pending-acknowledgement ordering and poisoned-partial failures. Harness corrections compare source committed fields and native object IDs rather than extension-local projection IDs, and wait for provider persistence before reading the native Passkey object. Assertions for original credentials, counters, files and signatures remain in the final scenario.

## Scope

This completes the bundled engine's local/WebDAV and tested legacy-account coexistence scope. It does not establish current Android/F-Droid application acceptance, direct OneDrive end-to-end acceptance or complete cross-backend parity. Nearby application mapping, consent, adoption and UI remain unfinished. Existing native-helper copies are not automatically migrated. The development `dist` is updated; no Android operations, user Chrome/accounts/vaults, cache deletion, push, tag or release were performed.
