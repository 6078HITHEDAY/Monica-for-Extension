# Integration security follow-up

Date: 2026-10-31. Version remains 1.0.102, unreleased.

## Historical secret-scan attribution

The initial push of the new integration branch caused TruffleHog 3.95.9 to scan
its entire history. Run 41199016942 failed with 9 verified and 26 unverified
findings. The pull-request difference scan passed. That initial failed run is
retained; a later passing difference scan does not establish a clean history.

A local full-history run of the same pinned scanner produced 9 verified and 28
unverified findings. Detector/network differences account for the count changing;
the local scan was for attribution and did not use `--fail`. Every reported
source was inspected without printing candidate secrets:

- All nine Lob results are Rust test function identifiers in vendored MDBX
  test modules, not string credentials or runtime configuration. Each match
  occurs on a `fn ...() {` declaration. The scanner's verified label does not
  establish that these source identifiers are usable credentials.
- Twelve service-token results are SHA-256 values in the brand-icon provenance
  inventory. All twelve equal the hashes of their corresponding bundled icons.
- Fifteen URI results are literal synthetic fixture URLs on reserved example
  domains, used for credential stripping, diagnostics and interop assertions.
- One private-key result is the deliberately public TLS fixture used by the
  website-icon E2E server, which binds only to 127.0.0.1. It is not a deployment
  key or a user's credential.

All sources predate this integration. Scanner configuration and detector coverage
were not changed, no broad path exclusions were added, and history was not
rewritten. Full-history scheduled scanning can still flag these known fixtures;
the reviewed attribution is distinct from a zero-findings result. Raw scanner
output stays local under workspace `.codex-tmp/`; this record contains no raw
candidate values.

## Dependency advisories

The repository reported nine open Dependabot advisories across Vite, Vitest's
mocking dependency, Undici and Brotli. The current production npm audit was
clean, but development and font-build dependencies also require updates.

The follow-up pins Vite 8.1.6, Vitest 4.1.12, resolves Undici 7.30.1, and pins
Brotli 1.2.1 in the font-tool requirements. These update build/test tools without
changing the extension version or vault formats.

Lock generation with npm 10.9.2 and 10.9.8 hit an Arborist `edgesOut` exception,
including in an isolated directory. npm 11 generated the lockfile without
disabling peer validation; the project's normal npm 10.9.2 then installed it
successfully with `npm ci --ignore-scripts`. The complete npm audit, including
development dependencies, reports zero vulnerabilities. All supply-chain
checks pass. Isolated installation of Brotli 1.2.1/fontTools 4.60.2 reads the
existing bundled WOFF2 with 410 mapped codepoints and passes a compression
roundtrip. Bundled font assets were not regenerated.

The updated full extension build passes with source build identity
`74ff7189bd356afffed7`; TypeScript/interop, the 244-icon inventory, browser
bundling, worker/native provenance and all four page inventories pass. The
230-command security audit passes. Full Vitest 4.1.12 regression: 347 files,
4,423 tests passed in 193.91 seconds.

The first post-update browser command omitted `MONICA_E2E_EDGE=1`. The shared
launcher therefore used Chromium, where long title-derived profile paths failed
to open IndexedDB (6 passed, 7 failed). This is not Edge acceptance and does not
establish a storage regression. The Edge CLI previously only set the
require-installed-browser flag; it now also sets the existing Edge opt-in flag,
so shared launchers use the installed Edge and its existing short-profile
lifecycle. No application storage or authentication policy changed.

The corrected CLI's final actual Edge run passed all 13 cases in 1.4 minutes
(eight Bitwarden authentication cases and five first-run import cases). All 14
isolated Edge profiles were removed by the existing lifecycle. Logs are
`extension-security-followup-{build,vitest,edge-final,supply-chain}.log` under
workspace `.codex-tmp/`. The reporting official Bitwarden account and Windows
Hello issue #17 remain unverified on their original environments.
