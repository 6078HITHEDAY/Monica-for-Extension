# Android 1.0.318 wallet section order

Android baseline: ordinary `1.0.318` at `83664b96995d3d4ba7ecc6ad705b6716ac594431`. `BankCardData` and `DocumentData` now include `editorSectionOrder: List<String>`. Android sources were inspected, not modified or rebuilt in this batch.

The extension previously retained this field only inside an existing source envelope. Its item projection omitted it, so copying a wallet to a fresh MDBX/Android ZIP or a document to a fresh KDBX lost the order. Five regression cases failed before the fix.

Later on the same day, [wallet editor ordering and local sync overlays](rounded-controls-and-wallet-editor-318.md) were implemented and tested. The codec-stage statements below describe the earlier checkpoint; the linked report records current UI validation and remaining gaps.

Both wallet item models, the shared SecureItem codec and the Android backup codec now carry the exact string list. Missing values stay missing; empty lists, duplicate keys and unknown future section keys are preserved without filtering. Unrelated edits preserve the original nested payload. The current wallet editor already preserves unedited item properties; this change does not implement section reordering in the extension UI.

Malformed order data is retained in a read-only item when importing extension JSON, Android ZIP or MDBX. It is not silently converted to an empty list. Existing wallet values, credential IDs, Passkey keys and zero-counter behavior are unchanged.

Validation on 2026-10-09:

- Seven new tests exercise source-free MDBX transfer, Android record and actual ZIP write/read, document KDBX field codecs, legacy/empty/future values and malformed input preservation.
- All 112 affected tests across six files pass. Both TypeScript configurations, production build, extension-page asset verification and `git diff --check` pass.
- Logs: `.artifacts/wallet-order-318/tests.log` and `build.log`.
- Local `dist` is rebuilt, still `0.1.37` with unreleased changes. `dist/background.js` SHA-256: `111edef56d9a06679c222676b77d2176c61fec6e434dcb20d1b07efb5314693f`.

Limits: this is codec/transfer regression evidence, not a new Android application or browser UI acceptance run. Android's Bitwarden upload has no order carrier and only retains the existing device-local order when downloading. Fresh bank-card KDBX writes use labelled fields rather than `MonicaItemData`; their order transport is still unsupported. These paths and extension order controls remain open, so full wallet or Android parity is not claimed.
