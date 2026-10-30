# Bitwarden move recovery: keep sources and finish copying

Local and MDBX moves can stop after destination writes when the sources have changed. The pending transfer now offers an explicit “Keep both and finish copying” choice, with an unchecked confirmation explaining that the destination receives the version from the original preview. Current source contents, local attachments and pending mutations are retained; sources subsequently deleted by the user are not restored.

## Persistence and deletion safety

- The manager-only `BITWARDEN_KEEP_BOTH_TRANSFER` command saves the choice under the encrypted vault mutation lock, bound to the current unlock session and original target account. Source and target provider queues serialize it with an ongoing move. Unconfirmed, expired-session, mismatched-target, cancelled and completed requests are rejected.
- Version 4 batch records retain the original request, request hash, plan, prepared Ciphers, files and deterministic identities. A versioned resolution records the original batch version and confirmation time. Only this transition can create v4; ordinary staging rejects it. Versions 1–3 retain their original semantics. Older extension builds reject v4 instead of ignoring the choice and executing a move; downgrading a vault containing these records is not supported.
- The decision is saved before any additional destination work. An unsuccessful save leaves the old decision in place. A lost successful reply is recovered from the encrypted record, and repeated confirmation does not rewrite it. Ordinary resume follows the stored copy decision even when its original request still says move.
- The source hash/dependency deletion checks are bypassed only for the effective copy outcome, which removes no source items or ownership metadata. Final destination Ciphers, attachments, folder identities and SSO relationships still require authenticated complete readback before atomic adoption. The result and displayed recovery plan report copy, while the immutable request keeps its original identity.
- Native groups must have neither deletion intents nor receipts. A missing reply or an “unknown” native operation lookup does not prove that deletion cannot still commit. The choice therefore refuses all already-authorized native deletion, including an intent without a receipt. Existing native recovery remains unchanged, and native deletion entry points explicitly reject v4.
- Pending summaries expose only the reviewed request/plan and `canKeepBoth`/`keptBoth` flags. They do not expose journal snapshots or key material. The interface reloads the saved summary after a lost choice response and discards the obsolete displayed move plan.

## Validation

All tests use synthetic vaults and isolated installed Edge profiles. No user browser profile, real account, Android source, build or device was used.

- Full unit suite: **3,398 tests in 286 files passed**. Fourteen new cases exercise partial destination writes, source edits and queued mutations, user deletion, later attachments, failed saves, lost successful replies, outages, repeated decisions, target rebinding, stale unlock sessions while waiting for the native source queue, native intents with and without a committed deletion, malformed/downgraded journals, invalid direct staging, and tampered destination readback. After the final UI-only refinement, 33 locale/sender-policy tests passed again.
- Production build, project and interop types, strict types for the changed unit/E2E tests, and the **218-command security audit** passed. `dist` contains the final 0.1.37 production build.
- Installed **Edge 155.0.4283.45**: four final-build scenarios passed, covering original local and MDBX moves plus keep-both recovery from each source. The new scenarios register a real browser Passkey, create a two-password project and attachment, lose the first successful Cipher response, edit a source, confirm that the old move refuses to complete, explicitly save the copy decision through the UI, sustain a destination outage, close and reopen the browser, and resume the original request. Exactly three Ciphers remain, the current source edit and attachment survive, and native source objects remain readable.
- An independent fresh client checks the rich fields, project identities, original credential/private-key bytes and zero counter, verifies a WebAuthn assertion against the original registration public key, and reads/decrypts the original attachment. The new privileged command is also refused from the real popup page. Both native registry registrations were restored.
- The 375-pixel confirmation page was inspected. Opening keep-both confirmation hides the original move/resume actions, requires an initially unchecked checkbox, and does not overflow horizontally. Editable local M3E Canvas files and their share link are retained in `docs/design/bitwarden-keep-both-319.*`; screenshots remain local.

Final keep-both preview times were 226 ms for local and 379 ms for MDBX. These are small synthetic fixtures, not large-vault performance claims. The earlier intermittent chooser delay remains a separate follow-up.

Evidence:

- `.artifacts/bitwarden-keep-both-full-unit-20261012.log`
- `.artifacts/bitwarden-keep-both-ui-final-20261012.log`
- `.artifacts/bitwarden-keep-both-build-final-20261012.log`
- `.artifacts/bitwarden-keep-both-types-final-20261012.log`
- `.artifacts/bitwarden-keep-both-security-final-20261012.log`
- `.artifacts/bitwarden-keep-both-edge-final-20261012` and its sibling `.log`

Earlier evidence is preserved. The first native keep-both E2E attempt expected the generic changed-source error, while actual native conversion correctly rejected the edited password earlier; only that fixture expectation changed. The final four scenarios passed without widening timeouts. Screenshot review also found and fixed the competing original move button before the final build.

## Remaining scope

This resolves pending moves before native deletion authorization. Resolution or compensation after native deletion authorization, other backend moves, the complete field/history/association matrix, current Android/F-Droid and system Credential Manager acceptance, live direct OneDrive acceptance, and nearby transport with per-recipient consent remain open. This change does not alter Android, credential IDs, private keys or signing counters.
