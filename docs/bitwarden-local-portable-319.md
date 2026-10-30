# Local records to Bitwarden — 0.1.37 development

## Changes

Normal browser-created ES256 Passkeys previously failed the batch resource round trip: Bitwarden's native FIDO2 format stores PKCS#8 but not a separate SPKI public key, transports, or explicit backup flags. The old comparison treated these missing fields as data loss even when their effective native meaning was identical.

The resource validator now imports the staged private key as a non-extractable CryptoKey and signs a random 32-byte local challenge. When the source contains SPKI, it verifies the signature with that original public key before accepting native public-key omission. This is a local integrity proof, not a WebAuthn ceremony; it does not reserve, advance or rewrite counters. Invalid keys and mismatched public keys fail before any remote mutation with a field-name-only error. Temporary DER and signature byte buffers are cleared. This extra work occurs during batch preview/revalidation, not password listing or autofill.

Implicit native BE/BS=true and the software `internal` transport compare equivalently to explicit defaults. Fresh native Bitwarden imports now set `userVerificationRequired=true`, matching the current Android PasskeyMapper. Existing explicit local UV preferences survive normal rebase; an absent preference inherits the remote requirement. Local UV=false, explicit BS=false, custom transports/AAGUIDs/icons or a distinct Passkey title remain blocked rather than claiming exact representation. BE=false remains refused by the existing upload guard. Private-key PEM, standard Base64 and Base64URL compare by their original DER bytes.

The default password subtype now compares equivalently to native Login with no special subtype. Text/hidden custom-field labels compare through their effective native protection while all other attributes/types remain checked. An explicitly unlinked OTP (`boundTotpItemId=""`) is no longer mistaken for absent legacy auto-link behavior.

## Field evidence

| Local source | Result |
| --- | --- |
| Browser-created ES256 Passkey, original SPKI/PKCS#8, count 0 | Pass: real registration, interrupted copy, restart and fresh-client login |
| Original counters 19 and 4294967295 | Pass: byte-preserving round trip and independent signatures; no policy change |
| Public/private key mismatch or malformed SPKI | Blocked before writing |
| Explicit BE=false; unrepresentable BS/UV/transport/presentation metadata | Blocked with original source retained |
| Password, username, application, email/phone, street/city/state/postcode/country | Pass: unit round trip and fresh-client HTTP sync |
| Duplicate hidden fields and text/hidden type representations | Pass: order, values and effective protection retained |
| URL matching rules, password history, bindings and custom-icon metadata | Pass: exact unit round trip; URLs/history also fresh-client sync |
| Credit-card fields embedded in passwords, barcode JSON, Steam raw JSON and bound-note links | Blocked: this portable Login route has no complete compatible mapping |
| Explicitly unlinked OTP | Blocked instead of permitting legacy rebinding |

These blocked rich fields are limitations of this portable batch route, not claims that the original records or native backend features are unusable. The transfer recovery marker remains an additional protected native custom field. No new metadata archive is presented as interoperable field support. Extension icon transport is not yet consumed by Android's Bitwarden mapper.

## Verification

- 604 related tests in 46 files passed, including 26 new portable-resource cases. The final corrected test fixtures passed all 26 again. Coverage includes original counters, mismatched keys, PEM/Base64URL, hidden-field semantics and unsupported data refusal.
- Installed Microsoft Edge acceptance creates a Passkey through the production webpage/extension prompt, then copies it and a rich password using the real manager dialog and loopback HTTP. A truncated successful POST response leaves a pending transfer; a full browser restart recovers exactly two remote Ciphers and preserves the original local Passkey.
- A second, independent Edge profile starts with a fresh extension vault and synchronizes only the synthetic Bitwarden account. The imported credential completes the production WebAuthn login path with explicit password verification even when the RP discourages UV. Node independently verifies its assertion against the original registration public key. Private-key bytes, credential bytes and zero counter match. Address/application fields, duplicate hidden fields and password history also match.
- The existing native Bitwarden graph/folder recovery scenario passed with two full restarts and two independent signatures (original counters 0 and 19).
- A third installed Edge regression passed the existing positive-counter native login path, including its confirmed remote counter update from 4 to 5. Installed Edge version: 155.0.4283.45. Final scenario durations were 11.1s (native graph), 22.7s (local copy/fresh client), and 10.3s (existing positive-counter login).
- Project types, production build, strict standalone E2E types and the 217-command output security audit passed. Original `dist` was rebuilt from the final production code.

Evidence is local in `.artifacts/bitwarden-portable-*20261012.log` and Playwright output. The first E2E attempt incorrectly expected only user fields and omitted the intentional protected transfer marker; the corrected assertion verifies both original fields and the exact operation marker. Initial type checks caught test-only field typing and WebCrypto ArrayBuffer generic declarations; these were corrected without changing crypto behavior. No test thresholds were relaxed.

## Remaining scope

Current Android mapper source was inspected read-only; this block does not claim new Android or system Credential Manager acceptance. Subsequent [MDBX source integration](bitwarden-mdbx-source-319.md) and [KeePass source integration](bitwarden-keepass-source-319.md) provide native verification for eligible records. Legacy WebDAV native-source conversion, remaining unsupported native fields/history, complete rich-field/backend coverage, durable foreign moves, direct OneDrive/current Android cross-client acceptance, nearby transport and recipient consent remain open. No Android edits, real accounts, user Chrome access, release, push or tag are included.
