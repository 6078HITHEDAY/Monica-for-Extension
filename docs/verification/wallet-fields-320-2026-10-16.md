# Android 1.0.320 profile fields — bounded extension acceptance

Completed on 2026-10-16 against extension baseline `e6da2e8`. This separately authorized field stage does not reopen the frozen Wi-Fi goal. Public version remains **0.1.39 Preview**; no push, tag or release was performed.

Android references: ordinary `74118c2a6f28fbb9ec8a674ab62b0c81385aedb5`, F-Droid `14e02f8f2cd1ba0a2a940a5258b686d75bda08b9`; `SecureItemModels.kt` and Android's `docs/verification/wallet-profile-fields-20261016.md`. No Android source or Passkey implementation was changed.

## Scope and behavior

- Standalone addresses: independent first/middle/last names, third address line, district and home/work email/phone.
- Identity documents: district and home/work contacts alongside existing independent names and third address line.
- Cards: independent cardholder first/middle/last names; embedded billing-address editor includes third line and district.
- Existing additional-content sections hold optional fields, with separate detail labels. Full names and their parts are never split or combined. Default and home/work contacts remain independent.
- JSON import, Monica item data, Android ZIP backup and MDBX object codecs preserve these fields. Encrypted KDBX create/edit/reopen and encrypted Bitwarden encoding/decoding preserve values and explicit clearing. A legacy Bitwarden identity without `monica_full_name` retains its matching local full name, including cached pulls; an explicit empty value clears it. Managed custom fields are not duplicated in the user-defined list.
- Web filling respects focused form/root, autocomplete section, shipping/billing and contact qualifiers, and repeated groups. Ambiguous unfocused groups remain untouched. Incompatible tel/email controls cannot receive name values. Combined addresses use separators for single-line inputs and newlines for textareas. Selects require a unique enabled match; controls added dynamically are found on the next explicit invocation.

## Validation

| Check | Result |
| --- | --- |
| Targeted Vitest batch | 13 files, 274 tests passed |
| Production build | TypeScript, icon font, Vite, workers and extension page checks passed; existing large-chunk warning remains |
| E2E TypeScript | Both wallet spec files passed strict checking |
| Installed Edge, production `dist` | 3 scenarios passed: new-field editors and scoped filling, existing wallet popup filling, existing card/note editing |
| Local M3E Canvas | Editable design rendered and actual address/card/identity dialogs inspected |
| Production dependency audit | 0 reported vulnerabilities |
| `scripts/security-audit.mjs` | Passed: runtime trust boundaries, production output and locale catalogs |

All browser data was synthetic, HTTPS pages were intercepted locally, and isolated Edge profiles were closed and removed by the existing test lifecycle. User Chrome, accounts and vaults were not used. No native engine rebuild or Android emulator was needed.

Local evidence: `.artifacts/wallet-fields/{unit-final.log,build-final.log,e2e.log,visual.log,npm-audit.log,security-audit.log}` and synthetic screenshots under its `e2e`/`visual` directories. Screenshots and browser profiles are not committed. The [editable Canvas](../design/wallet-fields-320.md) and JSON remain available locally and in the source documentation.

## Limits

- KDBX card billing addresses retain Android's existing formatted-text representation, including the new third-line/district text. Structured JSON roundtripping for that particular field is not claimed. Standalone address and identity records retain their complete Monica JSON representation.
- Phone country code, national number and extension use parsed phone data. Area/local/prefix/suffix splitting is limited to unambiguous US/Canadian NANP numbers; other variable-length area codes are skipped.
- Backend checks exercise real encrypted KDBX files and Bitwarden codecs/provider logic with synthetic transport responses. This stage does not claim live Bitwarden/OneDrive/WebDAV account testing or a new Android device acceptance run.
- Security checks cover the changed field routes and existing automated gates, and are not a guarantee that the whole application has no vulnerabilities. Previously documented Wi-Fi and broader cross-backend limitations remain deferred.
