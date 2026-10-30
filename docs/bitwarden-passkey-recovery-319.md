# Bitwarden Passkey portability and interrupted-create recovery

Date: 2026-10-12. Extension 0.1.37 development build. Baseline: `21f8a13`.

This completes a prerequisite for Bitwarden batch destinations. It does **not** enable the destination UI, implement cross-account Cipher migration, or complete Android parity.

## Reproduced failures

- The native FIDO2 encoder accepted explicit `backupEligible=false`, although Bitwarden cannot carry that immutable registration property. Current Android `PasskeyMapper` and `PasskeyCipherUpdate` refuse the same transfer. Synthetic create and preserved-parent update tests failed before the fix; source objects remained available.
- After the server committed a create but its response was lost, UUID credential IDs and Base64URL PKCS#8 keys failed recovery. The original fingerprint compared strings against the decoder's canonical forms. The canonical control passed; the two equivalent representations failed with an unknown-result conflict.
- Actual Edge against a loopback HTTP server repeated the first POST after a pooled connection closed before any response headers. The two server records contained identical encrypted payloads, including random IVs. POST transport retries are already disabled at the application layer. Exact-once HTTP creation cannot be promised without server support.
- Ambiguous create recovery omitted the still-pending local item from the provider result. Encrypted-vault adoption consequently added a misleading remote-deletion conflict. A new service-level regression reproduced the same two-conflict result before the fix.

## Changes and preservation rules

- Validate explicit backup eligibility, ES256 key material and unsigned 32-bit counters before creating a folder, restoring a Cipher, marking a create as attempted, or encoding an upload. Valid zero and positive counters remain unchanged. Removing a restricted credential from a parent remains possible without exporting it.
- New durable receipts explicitly use fingerprint version 2. Credential IDs and private-key encodings are normalized for comparison only; stored source identities and key material are not rewritten by the fingerprint. The legacy digest remains available for old receipts.
- An old attempted receipt can use canonical comparison only if the unchanged local item first reproduces its original digest. A later local edit cannot substitute for the original intent. Missing matches, duplicate matches and different private keys preserve the operation and conflict without another create.
- Keep blocked local creates in the merge result, avoiding the false deletion warning.
- Validate receipt versions and include the version in intent identity. Unknown or malformed recovery receipts stop loading instead of being silently filtered out. The encrypted envelope is retained. Legacy absence of the receipt collection and existing version-1 receipts remain supported.
- No signing-policy change, key regeneration, ID replacement, duplicate deletion or Android source change.

## Acceptance

- **495 tests in 32 files passed** in the final consolidated Bitwarden, encrypted-vault, migration and Passkey ownership run. Cases cover current and legacy receipts, UUID/Base64URL recovery, post-attempt edits, ambiguity, missing results, changed keys, invalid counters, native siblings and preserved parent content.
- **Two installed-Edge scenarios passed** against the final production `dist` with isolated synthetic profiles and actual loopback HTTP. A truncated response body recovered all three committed representations after full browser restart. Headerless disconnection reproduced one duplicated HTTP create; recovery retained its ambiguity while recovering the other two. Neither scenario issued another create after restart. The restricted source was never uploaded.
- **Five actual browser WebAuthn assertions** after restart verified independently against the original public keys. Credential bytes, private-key bytes and zero counters were checked. Synthetic relying-party pages were intercepted; no real account or user Chrome profile was used.
- Production build, project TypeScript, standalone E2E TypeScript and the **215-command security-output audit passed**. Original `dist` updated. Standard bundle-size warnings remain.

Evidence lives in ignored `.artifacts/bitwarden-portable-*-20261012.log`. Final runs are `consolidated-final`, `build-final`, `edge-final`, `e2e-types-final` and `audit-final`. Initial failed runs are retained as failures, including the additional ambiguity regression. The pre-fix ambiguity browser trace was copied to `.artifacts/bitwarden-portable-ambiguity-before-fix-20261012.zip` before rerunning. An early E2E type command needed PowerShell comma arguments quoted; the corrected command passed. An attempted post-start fetch observer did not intercept the provider's previously bound fetch and was removed; it supplies no request-count evidence.

## Remaining interoperability work

Bitwarden batch destination preparation/runtime/UI, complete shared-Cipher and authenticated attachment handling, durable foreign-source moves, the remaining rich-field/backend matrix, real direct OneDrive acceptance, current ordinary/F-Droid cross-end acceptance, and nearby-device transport/recipient consent remain open. This run used a synthetic HTTP server, not a live Bitwarden service or Android runtime.
