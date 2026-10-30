# Moving local projects into Bitwarden

The existing batch transfer dialog now accepts **Move** for eligible local records targeting Bitwarden. Password projects, supported SSO graphs, portable Passkeys, password history and local attachments use the same authenticated target conversion and recovery path as copying. Remote-backed sources still require Copy until their durable deletion transactions are integrated.

## Commit and recovery guarantees

Move selection follows incoming SSO/note dependencies as well as outgoing dependencies and complete password groups. An unsupported member blocks its whole connected component. Passkeys with matching or ambiguous local binding metadata remain at the source until those relationships can also be migrated. Remote references and local records retaining native origin payloads cannot be treated as ordinary local items.

A move requires the existing explicit confirmation before its first write. New moves use version 2 batch receipts, while existing version 1 copy receipts retain their copy semantics. Receipt validation checks the requested action, every planned/effective action, confirmation requirement and final result. A staged, already-confirmed move can resume after restart without turning it into a fresh operation.

The target Ciphers and attachments are created and verified using the existing encrypted journal. Local sources remain present throughout network work. After a fresh complete target readback, the encrypted-vault mutation lock protects a final recheck of source hashes, files, bindings and complete dependency membership. Sources, local attachment ownership, origin metadata and locked-autofill grants are removed in the **same encrypted write** that adopts the full target graph and marks the move completed.

An aborted local write leaves the source and pending journal intact. A successful write with a lost reply is already complete; replay reads the receipt without creating Ciphers or removing anything again. A source edit, deletion, new dependent or binding change stops final adoption and retains the source state and target receipts. An explicit “keep both and finish as a copy” resolution for that last case is still outstanding; recovery must not bypass the original snapshot check.

## Verification

- The full unit run covered 3,330 tests in 284 files. 3,301 passed initially; all 29 failures were missing new translation keys in the six offline language catalogs. After completing those translations, both affected suites passed all 42 tests. Other tested source code was unchanged afterward except the visual warning color. There are no unresolved unit failures.
- Added coverage checks atomic source removal/adoption, storage abort and lost-reply recovery, unchanged copy behavior, incoming SSO expansion, initial confirmation, source edits/deletion/rebinding, new dependencies, ambiguous Passkey binding metadata and receipt-version/action integrity. A retained red case exposed missing binding identity being accepted; it now blocks deletion.
- Installed Edge uses a synthetic website to register a real Passkey, creates a two-member local password project and uploads a local attachment through production commands. The actual dialog selects Move, expands the project and requires confirmation. The first successful Bitwarden POST response is deliberately truncated. Before closing the browser, every source still matches its original snapshot.
- Full browser restart resumes the staged request and finishes exactly three Ciphers. Sources disappear only after complete verification, their old local attachment listing is unavailable, and repeated execution returns the same completed move with no extra creates. A fresh independent client verifies project membership, rich fields, history, private-key/credential bytes and zero counter; its WebAuthn assertion verifies against the original registration public key. Production attachment read and independent HMAC/AES checks match the original bytes.
- Five scenarios passed on the same final build: local copy 16.5s, local move 17.7s, MDBX copy 24.5s, KeePass copy 21.3s and legacy WebDAV copy 26.5s. Temporary Native Messaging registration was restored. The MDBX fixture is historical synthetic evidence, not current Android acceptance.
- Project types, strict standalone E2E types, production build and the 217-command output security audit passed. Original `dist` remains at development version 0.1.37 and contains this build.
- Existing compact M3E layout and confirmation controls are reused. The local Canvas was updated and its single-page preview inspected. Actual desktop and 375px screenshots were inspected; the warning text now uses the surface text color for readable dark-mode contrast, and the narrow dialog has no horizontal overflow. New instructions are included in English and all six offline locale catalogs.

Local evidence: `.artifacts/bitwarden-local-move-*20261012*`. The initial browser failure was an incorrect selector for a custom radio component; the final test clicks its actual visible label. Local editable design and share link: `docs/design/bitwarden-local-move-319.m3e.json` and `docs/design/bitwarden-local-move-319.md`. Screenshots and these new design artifacts remain local.

## Remaining scope

This closes the local-source-to-Bitwarden move path. Durable remote-source deletion, explicit resolution of a move whose source changed after staging, remaining rich-field/association mappings, current Android/F-Droid/system Credential Manager and live OneDrive acceptance, nearby transport and per-recipient consent remain open. No Android edits/build/device operations, real accounts, user Chrome access, publication or cache deletion were performed.
