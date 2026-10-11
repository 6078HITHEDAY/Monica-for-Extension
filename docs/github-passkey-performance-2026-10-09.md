# GitHub Passkey and interaction latency fixes — unreleased

The user reported delayed button/Passkey/autofill responses and GitHub displaying `Authentication failed.` when using a Bitwarden Passkey. This patch updates the unpacked local build. It does not replace the published 0.1.37 package or claim completion of Android parity.

## Reproduced failures and fixes

1. GitHub's `@github/webauthn-json` assigns `credential.toJSON` after `navigator.credentials.get/create`. Monica defined it as non-writable, causing a strict-mode `TypeError` before serialization. Both new regression cases failed on the original response builder and pass with a writable/configurable method. The adapter was extracted into `src/passkey/credential-response.ts` so the actual browser response builder is tested.
2. Clicking Passkey while a password form is populated can also trigger asynchronous password capture. The save prompt removed the active Passkey prompt, cancelling the ceremony. The Chromium Bitwarden/GitHub fixture reproduced the cancellation. Save prompt rendering now yields while a WebAuthn request is active; the same populated-form scenario completes verification and signing.
3. Background reads repeatedly decoded, parsed and migrated the same full vault. An in-memory snapshot now reuses an already authenticated envelope only within the same unexpired session, checking its complete ciphertext, IV, cipher/version, KDF, timestamp and session identity/key. Returned values are independent clones. Writes invalidate it; locking, expiry, invalid sessions and Chrome session-change events discard it. An invalidated in-flight decryption cannot repopulate the cache or return its result. No plaintext is persisted by this cache.
4. Read projections avoid copying unrelated passwords/source records/journals into Passkey discovery and small settings/provider queries. Post-verification identity and ownership checks share a single fresh snapshot. List rendering reuses group sizes and grouping; pagination no longer builds display stacks when stacking is disabled.

Existing credential IDs, keys, zero counters, historical positive-counter synchronization, user verification, origin/document checks, and the encrypted storage/sync formats are unchanged. Argon2id parameters were not reduced. Positive-counter credentials still require durable remote confirmation; network latency in that path remains relevant.

GitHub's public serializer was inspected on 2026-10-08 at:
<https://github.githubassets.com/assets/d0k-caaa4c15767df08c.js>
The `rr` module's `get` and `create` wrappers assign `toJSON`; the local browser regression implements the same assignment and binary-field projection. This is a synthetic account/Bitwarden service with independent signature verification, not a login to the user's real GitHub account.

## Measurements

`scripts/interaction-performance-probe.mjs` measures inside Chromium, excluding Playwright's serialization of vault responses. It uses an isolated profile, 10,000 synthetic logins and one synthetic local Passkey, with automatic remote sync disabled. Website operations are measured from focus/confirmation until menu insertion, field input, prompt insertion or the returned assertion. User decision time is excluded. Passkey timing uses UV discouraged to isolate extension processing; the separate GitHub fixture requires real master-password verification.

The baseline is the unchanged published ZIP, SHA-256 `0eeea06fb603d26b92ff6b2aca9eb14e538c9571d486a499827755c1f0e66cff`. Before/after runs were sequential on this machine. These are local samples, not universal latency guarantees.

| Website interaction | Published 0.1.37 | Patched build |
| --- | ---: | ---: |
| Focus to inline suggestions | 385.5 ms | 212.8 ms |
| Confirm to password field update | 163.7 ms | 81.5 ms |
| Request to Passkey selection prompt | 306.2 ms | 120.1 ms |
| Confirm to returned Passkey assertion | 1065.2 ms | 447.0 ms |

Raw records: `.artifacts/performance/final-before-10000.json`, `final-after-10000.json`, plus their worker CPU profiles. Earlier `interaction-before-*` measurements included test transport overhead and must not be cited as runtime latency. Early manager comparisons also varied with machine load; final sequential samples did not establish a clear manager rendering improvement before the last pagination/grouping optimization. No broad "all UI lag fixed" claim is made.

```powershell
npm run build
node scripts/interaction-performance-probe.mjs --extension D:/Monica-perf-baseline-0137 --items 10000 --output .artifacts/performance/final-before-10000.json
node scripts/interaction-performance-probe.mjs --items 10000 --output .artifacts/performance/final-after-10000.json
```

The probe benchmarks filling and Passkeys independently by removing the filled form before the Passkey phase. The populated-form overlap is tested separately in `passkey-bitwarden-counter.spec.ts` (`github-json`). Profiles contain synthetic data only and their paths are recorded in successful reports.

## Validation

- User acceptance, 2026-10-09: after reloading the unpacked extension and refreshing GitHub, the user confirmed that their previously failing Bitwarden Passkey successfully logs in and that buttons/autofill respond normally ("能登录，响应正常"). This is real-account feedback, separate from the synthetic browser tests and local timing samples below. It does not establish a latency guarantee for every vault or website.
- Full unit suite: 249 files / 2,631 tests passed. After tightening the in-flight cache invalidation guard, the 92 affected vault, usage and response-adapter tests passed again.
- Production build and TypeScript checks passed, including extension-page asset checks.
- Browser regression: all 26 tests passed across `passkey-bitwarden-counter.spec.ts`, `inline-autofill.spec.ts` and `locked-autofill.spec.ts` (output `D:/Monica-performance-regression`). This includes GitHub serialization after a populated password form, independent signature/ID/user-handle/RP/UV/zero-counter checks, offline use, positive-history commit/failure/cancellation/regression paths, scoped OTP fills, browser restarts, and locked grants/revocation. Historical unrelated E2E failures from the preview release are not treated as passed by this patch.
- After the last manager grouping/pagination change, the production build passed and all three `performance.spec.ts` browser tests passed, including search, pagination, deletion, filling, eight-language pagination controls, detached component cleanup and icon rendering (`D:/Monica-manager-performance-regression`). Total targeted browser coverage: 29 passing tests.
- Runtime security audit passed for 212 commands, including 24 manager-only password project commands. `git diff --check` passed.

To use the updated unpacked build, reload Monica in Chrome's extensions page and refresh existing GitHub/website tabs so their injected scripts are replaced. The local `dist` remains version 0.1.37 with these unreleased fixes; the published ZIP/tag remain intact.

Cleanup limitation: a guarded removal of the 16 explicitly listed synthetic `D:/Monica-perf-<timestamp>` / `D:/Monica-github-<timestamp>` profiles was rejected by automatic command approval (`blocked by policy`). No deletion was executed and no freed-space claim is made. The earlier native build-cache cleanup is also still uncompleted. Existing user browser profiles were not accessed.
