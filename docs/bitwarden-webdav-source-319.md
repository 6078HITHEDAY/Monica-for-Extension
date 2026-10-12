# Legacy Monica WebDAV sources into Bitwarden

Eligible records from Monica Android ZIP snapshots can now be copied through the existing Bitwarden batch dialog. The source reader validates the original archive, password-project membership, native fields, password history and portable attachments before preparing the encrypted recoverable transfer. Sources are retained; this does not implement foreign-source moves.

## Source integrity and bounded work

The internal provider reader obtains a read-only snapshot matching the synchronized filename and ETag. It never creates a missing source directory. Strong ETags use conditional GET; weak-to-strong transitions use the existing read-only equivalence policy. After download and decryption, the latest filename, URL, ETag, size and modification time are checked again. The exact downloaded archive hash joins the reviewed transfer fingerprint. A later execution fetches and checks a fresh snapshot before staging.

One promise caches the immutable archive per account and batch state, including failed loads. Members and attachments reuse that document instead of downloading a full vault for each item. Lock or connection changes invalidate the operation. Archive buffers are cleared after parsing; tests include stored ZIP entries to prove retained records and attachment bytes do not alias the cleared buffers. The parsed document remains only in the weakly keyed batch cache, without a new persistent plaintext store.

Native and indexed projections are compared in both directions. A fresh Android record serialization proves original fields are represented without merging the original raw object back into the result. Complete password-project membership is checked against the archive and index. Password-history rows must have unambiguous owners, represented passwords and valid timestamps; unknown row properties stop the component. Epoch-zero history is preserved.

Portable attachment manifests must have supported structure, unique ownership and IDs, and a complete decodable file list. Every file is size/SHA-256 checked. Valid empty attachments remain files with the empty-content hash. The extension writer's redundant attachment ID is accepted only when it equals the ID derived from the payload path; conflicting IDs and unsupported attributes stop copying. Encrypted backup content, rather than a filename suffix, authorizes portable private keys and attachments.

Missing or weak validators do not prove that a remote server cannot change immediately after a read. Execution copies the verified, staged snapshot; exact archive hashes detect differences between review and staging. The source is never overwritten or deleted by this operation.

## Verification

- 846 related tests in 60 WebDAV, Bitwarden, Passkey and encrypted batch-service files passed, including 37 focused source/snapshot cases. Coverage includes unknown raw/history/file fields, incomplete project membership, revision or binding changes, lock during download, ETag/list changes, failed-load reuse, malformed metadata, empty files and exact attachment bytes.
- Installed Edge uses an isolated profile, production extension pages/runtime and real loopback WebDAV/Bitwarden HTTP. A website first registers a real Passkey. A synthetic encrypted Android backup containing that exact credential is then imported through normal WebDAV sync. The test creates a rich two-member password project and uploads its attachment through production commands.
- Legacy Monica WebDAV is not a direct WebAuthn registration destination. The fixture explicitly performs the encrypted-backup import; it does not claim direct registration to WebDAV. MDBX/KeePass/Bitwarden registration behavior is unchanged.
- Selecting one password expands to its sibling, plus the selected Passkey: three destination Ciphers. A successful Cipher POST response is deliberately truncated. Full Edge restart resumes the encrypted journal and creates exactly three Ciphers, without replaying the already successful create.
- A separate fresh Edge installation synchronizes only Bitwarden. Password/application/contact/address fields, duplicate hidden fields, password history and new project identities are retained. Credential ID and private-key bytes are unchanged. A real WebAuthn assertion verifies against the original registration SPKI, with counter zero and user verification even when the RP discourages it.
- Fresh-client attachment listing, reading and release return the original bytes. Independent HMAC/AES verification checks the uploaded Bitwarden ciphertext. Every source item and every encrypted WebDAV archive byte remain unchanged during copying. The recorded HTTP sequence proves exactly one full download for review and one for execution, with no source writes or recovery download. WebDAV scenario: 17.4 seconds.
- Project types, strict E2E types, production build and the 217-command output security audit passed. Original `dist` is updated at development version 0.1.37.
- Existing local, MDBX and KeePass scenarios also passed on the same final build (30.0s, 38.3s and 23.4s respectively). The MDBX test uses the previously verified synthetic historical fixture, not new Android acceptance. Temporary Native Messaging registration was restored successfully.

Evidence remains local under `.artifacts/webdav-bitwarden-*20261012*`. Earlier failed browser runs are retained: one exposed the unsupported direct-registration assumption in the fixture; another exposed the redundant attachment-ID false blocker in the new reader. No validation threshold was relaxed. Tests use synthetic credentials and isolated installed Edge profiles, not user Chrome or cloud accounts.

## Remaining scope

Unsupported native fields/history/associations continue to block the whole affected component. This copies item content and supported password history, not the complete Android backup, generator history or database audit timeline. Native source archives remain intact. Actual OneDrive/current Android/F-Droid/system Credential Manager acceptance, the remaining rich-field/backend matrix, durable foreign moves, nearby transport and per-recipient Passkey consent remain open. Android's latest nearby-sync policy separately skips nonzero-counter credentials; this block does not change counters or apply nearby-specific policy to Bitwarden copies.
