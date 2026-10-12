# KeePass sources to Bitwarden — 0.1.37 development

## Native source verification

The Bitwarden batch destination now accepts eligible KeePass sources through the existing source session/working-copy restoration path. An internal provider method authenticates the account/database/entry binding, checks the last synced baseline against both native content and indexed content, and verifies complete native password-project membership. It exposes native evidence only to trusted background code, never a runtime response. Session replacement, lock, history or group revisions invalidate the read.

A fresh KeePass writer field map is compared with every native field before portable Bitwarden encoding. The original field map is never used as a merge base for this proof. Unsupported aliases, conflicting dual Passkey records and unknown nested Passkey JSON therefore stop the transfer instead of silently disappearing. Unknown ordinary custom fields can transfer when their exact name, text, order and protection are represented. PKCS#8 encodings and credential IDs compare by equivalent material; the existing Bitwarden validator independently proves the original public/private key relationship.

The source's native content checkpoint includes fields, metadata, history and binaries. It is rechecked after attachment reads and bound into the existing batch fingerprint. The provider caches native content hashes by live session revision for explicit batch operations. The normal encrypted journal stages the reviewed item and attachment bytes before remote writing, then recovers committed Ciphers/files after browser restart. Sources are retained.

Real-browser integration found three differences between old locally-created rows and their native projections: missing redundant numeric database scope, derived Passkey algorithm labels/empty AAGUID, and explicit TEXT/HIDDEN custom-field types. The reader accepts these only when they have the same authenticated identity or effective meaning. A different explicit database ID, unknown algorithm label, nonempty conflicting AAGUID, changed value or lost protection still fails. It does not loosen the original key, ID, signature counter or field-preservation checks.

## History and unsupported native content

KDBX history contains whole entry snapshots. Native Bitwarden password history contains only a password and timestamp. The adapter accepts historical password values only when every other historical field exactly matches the current field/protection set and the old snapshot has no attachments, nested history or unsupported metadata. It retains native history order and appends distinct existing local password-history rows. Historical notes/field changes, files or unsupported entry settings block the component. The destination is not a full KDBX audit timeline; native times and old attachment-absence states are not represented as entry snapshots. The original KDBX remains intact.

Current tags, custom entry data/icons/colors, URL overrides, nondefault built-in icons, expiry settings, modified Auto-Type settings and disabled quality checks remain explicitly unsupported. Custom field references that cannot be reconstructed also block. Passkey history, unsupported backup/UV/presentation policy, rich fields without a compatible Bitwarden mapping and ambiguous source groups remain blocked. No opaque metadata archive is claimed as Android-compatible native field support.

The related MDBX reader now compares indexed and native projections in both directions, preventing a locally removed optional field from bypassing stale-source detection.

## Verification

- 1,605 tests across 119 related KeePass, MDBX, Bitwarden, Passkey and encrypted batch-service files passed. Focused coverage includes native fields/whitespace/protection, password-only history, unknown nested metadata, dual credentials, stale groups, removal/lock/config changes during file reads and the equivalent-format false blockers.
- Installed Edge opens a newly generated synthetic KDBX through the production manager, makes it the default save destination, registers a non-discoverable Passkey from a website, creates a two-member password project and uploads an attachment through production commands. Selecting one password automatically includes its sibling.
- A truncated successful Bitwarden Cipher POST leaves a durable pending transfer. A full Edge restart recovers exactly three remote Ciphers and preserves every source item. The KeePass source need not be reopened to resume the already staged snapshot.
- A separate fresh Edge profile synchronizes only the synthetic Bitwarden server. It verifies rich password/application/address fields, hidden custom fields, native password history, new project identity and original credential/private-key bytes. The actual WebAuthn assertion has counter zero, requires user verification even when the RP discourages it, and verifies independently against the original registration public key.
- The fresh client lists, reads and releases the copied attachment through production runtime commands. Bytes match the original; independent HMAC/AES verification also checks the uploaded ciphertext. Final KeePass scenario: 21.9s. Existing local (15.6s) and MDBX (20.9s) scenarios passed on the same build; the temporary Native Messaging registration was restored.
- Project types, production build, strict E2E types and the 217-command output security audit passed. Original `dist` is updated. Evidence is local under `.artifacts/keepass-bitwarden-source-*20261012*` and `.artifacts/keepass-bitwarden-other-sources-edge-20261012*`.

Earlier browser failures and diagnostics are retained locally. They exposed native/index representation differences; regression tests still reject actual changes. No thresholds were relaxed. Tests use synthetic data and isolated installed Edge profiles. This is local-KDBX-to-synthetic-Bitwarden acceptance, not live cloud or current Android acceptance.

## Remaining scope

Legacy WebDAV native-source conversion into Bitwarden, remaining unsupported rich fields/history across backends, durable foreign-source deletion, actual OneDrive/current Android/F-Droid/system Credential Manager acceptance, nearby transport and per-recipient Passkey consent remain open. No Android edits/builds/device actions, real accounts, user Chrome access, release, push or tag are included.
