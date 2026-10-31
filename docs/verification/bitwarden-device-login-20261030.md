# Bitwarden device verification and server selection

Date: 2026-10-30. Extension 1.0.102, unreleased changes.

The referenced report shows a failed new-device email-code login and a server field whose suggestions offered only the US service. It has no server response body. The earlier official-service HTTP 400 investigation is retained separately in `bitwarden-login-400-20261029.md`; neither report is attributed solely to the user's network.

## Reproduced mechanism and changes

Before an account was saved, `BITWARDEN_LOGIN` generated a new device UUID for each request. Email-code and SSO requests also generated their own UUIDs. A device-bound challenge could therefore be issued to one device identifier and submitted from another. A deterministic service fixture binds the synthetic code to the first request's identifier: the previous build fails to connect even with the correct code, while the fixed build connects. This reproduces the identifier mismatch, not the affected user's actual official-account rejection.

`BitwardenDeviceIdentity` stores a non-secret installation UUID in `chrome.storage.local` before making the first request. Concurrent requests share the same initialization; worker restarts read the persisted value. A storage write failure aborts rather than sends an identifier that cannot be reused. Login, email-code and SSO routes use this helper. Connected accounts keep their existing device identifier. No master password, token or code was added to this storage key, and no password derivation or encrypted-vault format changed.

The existing Monica Material form now offers US, EU and self-hosted service choices and an editable server URL. Switching away from a custom URL retains its draft. Changing server or email removes the prior OTP and two-factor challenge; those inputs are disabled during requests. Fixed labels are included in English and the six external UI language catalogs.

## Verification

- Device-identity and client focused tests: 46 passed. The five new identity tests cover concurrent first requests, persisted IDs after restart, legacy account IDs, failed writes and retry.
- Complete Bitwarden provider and i18n regression: **681 tests in 41 files passed**, 70.86 seconds.
- Browser regression first failed against the previous build because a correct device-bound code did not close the login dialog. After the fix it passed. The final test uses the repository's existing `launchTestContext` fixture with `MONICA_E2E_EDGE=1` and `MONICA_E2E_REQUIRE_EDGE=1`; it requires the installed `msedge.exe`, asserts an `Edg/` user agent, and records browser evidence. **One final Edge test passed in 13.8 seconds.** It covers US/EU/custom choices, retained custom URL, wrong code followed by correct code, challenge invalidation on server change and identical device identifiers on all token requests.
- The full extension build passed: TypeScript checks, bundling, native-host and WASM provenance validation, and all four extension-page asset inventories.
- Existing hotspot native changes were recorded in the LAN provenance overlay and reversible patch. The host source inventory now checks explicitly recorded added files and rejects unrecorded source. Negative controls reject both a modified network source and an extra unrecorded source file; the original files were restored. The 37 native LAN tests passed again in 8.70 seconds. See `nearby-hotspot-20261029.md` for the earlier hotspot implementation and remaining physical-network limitation.

Local evidence is retained under the workspace `.codex-tmp/`: `extension-device-id-red.log`, `extension-device-id-tests.log`, `extension-login-regression-tests.log`, `extension-device-id-final-edge.log`, `extension-login-final-build.log` and `extension-hotspot-native-regression.log`. The final Edge browser metadata is under the extension's ignored Playwright `test-results` directory. Synthetic profiles are cleaned by the existing test lifecycle.

The local M3E Canvas project `extension-bitwarden-login-20261030` and the actual extension rendering were checked. Editable JSON, the complete local project URL and screenshots stay in the ignored `docs/design/bitwarden-login-20261030/` directory; no screenshots or real account values are included here.

No real official Bitwarden account or email delivery was exercised. Official CAPTCHA, account policies and actual new-device email verification remain unverified; the identified code defect and server-selection behavior are the validated fixes. No publication, push or installer delivery was performed.
