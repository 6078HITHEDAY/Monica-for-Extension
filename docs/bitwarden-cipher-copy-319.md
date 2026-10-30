# Bitwarden full-Cipher copy preparation and recovery

Date: 2026-10-12. Extension development version: **0.1.37**, unreleased. This is the persistent execution foundation for the Bitwarden batch destination. No new runtime command or destination UI is enabled by this block.

## Scope and preservation

A native Cipher is one copy unit: login, OTP, every FIDO2 sibling, duplicate custom fields, password history, archive state and opaque native fields travel together. Selection expands native siblings and project/SSO/note dependencies to a fixed point, bounded at 200 items. Provider identity is part of native membership; equal titles or Cipher IDs on different accounts do not establish a group.

Preparation authenticates and re-encrypts all supported encrypted fields under a **new per-Cipher key** wrapped by the destination account key. It never wraps the source account-wide key as a destination item key. Legacy Ciphers and modern per-item keys are supported. Known schema aliases are normalized; collisions and unsupported encryption formats are refused. Unknown field names, binary values, ordered arrays, empty/false/zero values and lossless large numeric text are retained. Copied password projects require a fresh shared project identity. Cross-record SSO/note/OTP links are refused until the enclosing graph planner can rebind them.

Original credential IDs, private-key bytes and valid counters are preserved. Explicitly non-backup-eligible, unusable or metadata-only Passkeys are rejected. The Android zero-counter policy is unchanged. This does not establish that Android can use a credential previously registered with a server that demands positive counters.

## Durable execution

- Immutable preparation, file plaintext, SHA-256 proofs and progress are stored **inside the encrypted vault**. Attachment names and operation markers are not standalone plaintext settings. Structural readers reject unknown/corrupt receipts rather than dropping them.
- Validate all file manifests and decrypted bytes before any remote mutation. Limit each Cipher's file preparation to 512 files / 16 MiB, and payload JSON to 8 MiB with bounded depth/node count.
- Persist `attempted` before the single application-level create request. Recovery scans authenticated records, including trash and organizations. Missing, edited, unreadable or ambiguous results preserve the operation and stop another create. Browsers may transparently replay a headerless HTTP failure; the marker scan handles ambiguity, and cannot promise server-side exactly-once creation.
- Require the expected remote ID, encrypted content proof, operation/source marker and complete FIDO2 identity list on readback.
- Use the existing production attachment upload journal and deterministic per-file operation IDs. Download each file again, authenticate it, and compare its plaintext name, length and SHA-256. Persist a separate encrypted per-file receipt, so eviction from the lower attachment journal cannot cause a verified file to be uploaded again.
- Read the Cipher again after all uploads and require the exact attachment ID set. A later peer edit or missing file prevents verification. Failed readbacks clear temporary plaintext buffers.
- Enforce legal forward transitions and revision compare-and-swap. Completed identities are retained; verified replay performs no network request or vault rewrite. This is a **per-Cipher proof**, not whole-batch adoption or permission to delete a source.
- Bind each execution store to the original unlock session and target account. Lock/unlock, account/key reconfiguration, or a stale pre-attempt source stops the old execution. Source edits after an uncertain create are retained while recovering the originally reviewed copy.
- Production remote access uses `BitwardenClient.createCipherOnce`, authenticated downloads, and the durable upload service. Rotating tokens use compare-and-swap and only update token fields, retaining newer tokens and unrelated account settings. Organization keys used for discovery are disposed after execution.

## Verification

**1,080 tests in 77 files passed** in the final consolidated encrypted-vault, Bitwarden, migration, local-transfer and Passkey run (`--maxWorkers=4`). This includes 56 tests in the new crypto/selection/service files. Coverage includes native types 1–5, independent source/destination keys, two FIDO2 siblings, lossless numeric data, tampered proofs, malformed manifests, byte/name/length mismatch, unknown creates, duplicate/edited/deleted copies, response loss, stale sources, lock/reconfiguration, encrypted receipt validation and token refresh races.

**Installed Microsoft Edge 155.0.4283.45** passed the production-module browser harness with an isolated profile and real loopback HTTP. The harness exercises real IndexedDB and WebCrypto; it is not a batch UI acceptance and is not bundled into `dist`.

1. Abort the IndexedDB attempt transaction; no remote create occurs and the preparation stays intact.
2. Commit a remote Cipher, truncate its response body, and close the browser completely.
3. Reopen and unlock the encrypted vault; discover the existing Cipher without another create. Lose an actual file-upload response, authenticate its stored bytes, then simulate loss of the reply after the first encrypted per-file receipt commits.
4. Close and restart Edge again. Resume from that receipt and upload only the remaining file. Final server state contains **one Cipher and two attachments**. Source items remain unchanged and unadopted.
5. Both copied Passkeys sign in the browser, and Node independently verifies both assertions against the original public keys. Their counters remain **0 and 19**. Independently authenticate/decrypt both Bitwarden type-2 binary attachments and check the exact four-byte inputs. Unknown encrypted native data survives.

Project and strict standalone E2E TypeScript checks, production build, extension-page verification and the **215-command security-output audit passed**. Original `dist` was rebuilt. Existing bundle-size warnings remain.

Logs are local and ignored: `.artifacts/bitwarden-copy-*-20261012.log`. The first unlimited-worker consolidated run had three 5-second test timeouts and one incorrectly named link fixture; the bounded-worker final run passed unchanged production timeout settings. The first browser fixture incorrectly required a same-origin Vaultwarden attachment URL to omit authentication; it was corrected to the existing same-origin API policy. Earlier test harness issues (nested service queue read, generic decryption error wording, PowerShell argument quoting and standalone TypeScript Buffer types) were corrected; failed runs are not counted as passes.

## Remaining work

Connect the complete batch planner, graph rebinding, folders, portable foreign-source mapping, manager-only runtime commands and the destination/recovery UI. Final fresh provider readback must atomically adopt the entire batch and completion record. No source deletion is implemented here. Marker presentation and editing also belong to the UI/runtime integration. Actual Bitwarden/Vaultwarden service acceptance, direct OneDrive/current Android/F-Droid consumption, foreign-source moves, the remaining rich-field matrix and nearby-device transport/recipient consent remain separate unfinished scope.

No Android source/build/device operation, user Chrome profile, real account, subagent, outgoing thread message, push, tag, release or cache-deletion retry was used in this block.
