# Bitwarden email verification follow-up

Date: 2026-10-31. Extension 1.0.102, local unreleased changes on
`codex/bitwarden-email-login-followup-20261031`, based on main `258b792`.
Source build identity: `1abf4effe2ff7c8831ff`.

The user confirms that login still fails after submitting an email verification
code. The exact error, server region and installed build have not yet been
provided. This investigation therefore does not establish the cause of that
specific official-account failure.

## Reproduced defect

The previous login dialog cleared `newDeviceOtp` when the server returned a
two-factor challenge, and submitted it only while the device-code field was
visible. A subsequent two-factor request consequently omitted the device code.
The reverse challenge order also cleared the available two-factor providers,
omitting the selected provider on the following device-verification request.

The locally available official Bitwarden browser implementation retains the
password-token request between these steps: `PasswordLoginStrategy`
`logInNewDeviceVerification` sets `tokenRequest.newDeviceOtp`, while
`PasswordTokenRequest.toIdentityToken` includes it alongside the two-factor
fields. Monica now keeps both factors within the same dialog attempt. A server
returning the provider list again after an incorrect code preserves the selected
method and shows a fixed translated rejection message.

A synthetic service requiring both factors reproduced the original defect in
actual Microsoft Edge: the third token request had a null `newDeviceOtp` where
the expected synthetic value was present on the preceding request. The same
browser regression passes after the change. This validates state continuity,
not the real cloud server's policy for every account.

## Security boundaries

- Codes stay in the current form and are not added to provider configuration or
  persistent extension storage. Browser tests inspect storage after connection.
- Changing the server, email or master password clears both codes and challenge
  metadata. Closing/reopening the dialog also clears them; the existing whole
  vault lock cleanup continues clearing the form.
- Device identifiers, password derivation, vault encryption and server URL
  routing are unchanged. Authentication still requires an authenticated server
  response and successful vault-key decryption before saving the provider.
- Errors use fixed translations in English and all six external language
  catalogs, with Simplified Chinese as the source language. Arbitrary server
  messages and real credentials are not added to logs.

## Verification

- 653 Bitwarden provider tests passed. The combined 681-test provider/language
  run initially had one failure for the new untranslated UI literal; after
  adding the translations, the complete 28-test language suite passed.
- Final actual Edge run: **7 passed, 57.2 seconds**, using installed `msedge.exe`
  and isolated profiles. Covers the existing device-code login, wrong email
  two-factor code followed by a correct retry, preservation of the selected
  email method, both challenge orders, password/server/email invalidation,
  cancel/reopen, stable device identity and absence of codes in local storage.
- Full extension build passed: TypeScript and interop checks, bundling,
  native/WASM provenance and four extension-page asset inventories.
- Security audit passed: 225 runtime commands, including 24 manager-only
  project commands. `git diff --check` passed.

Early test attempts failed before reaching the intended assertion: bundled
Chromium returned an unsuccessful vault-setup result, and the first Edge fixture
used a string option value for a numeric Material option. The fixture was
corrected to choose the visible email label. Neither is counted as the product
negative control. An intermediate final Edge run had six passes and one failure
while closing the context and archiving its trace (unexpected byte count and
truncated ZIP). Test-source indentation had been edited during that run; its
contribution to the archive failure was not separately proven. The final seven
tests were rerun with unchanged source and all passed, including cleanup.

Logs remain in the workspace's `.codex-tmp/`:

- `extension-bitwarden-followup-red-edge.log`
- `extension-bitwarden-followup-tests.log`
- `extension-bitwarden-followup-i18n.log`
- `extension-bitwarden-followup-final-build.log`
- `extension-bitwarden-followup-final-edge.log` (intermediate cleanup failure)
- `extension-bitwarden-followup-final-edge-rerun.log` (final seven passes)
- `extension-bitwarden-followup-security.log`

Synthetic browser profiles were removed by the existing test lifecycle. No real
Bitwarden account, mailbox, CAPTCHA or reporting-device login was exercised.
No remote push, publication, version change or package delivery was performed.

## Continued authentication response verification

The official Bitwarden server at `2028f0a5cc9d8ab8ff8475029085f29f81483598`
returns `UserDecryptionOptions.MasterPasswordUnlock` with `Salt`, `Kdf` and
`MasterKeyEncryptedUserKey`. The earlier client only read the legacy top-level
`Key`. The 15-case regression failed against that implementation (local
`extension-bitwarden-unlock-red.log`); the updated password and SSO flows accept
Pascal/camel casing and both PBKDF2 and Argon2id, preserving the salt bytes and
master-password whitespace. Malformed metadata, excessive KDF work and a wrong
MAC fail without retrying a valid legacy key.

Two additional tests reproduced a cached UI/background compatibility check
allowing Bitwarden password/code requests after the worker build changed. These
commands now force the existing read-only build probe before sending secrets;
the authentication requests themselves are never replayed. The initial combined
run passed 713 tests and failed these two tests; after the fix, all 34 targeted
response/runtime tests passed. The real-account report remains unconfirmed.
