# Rounded controls and wallet editing — 2026-10-09

The shared filled text fields and selects now have four 24px corners, no bottom underline, and a complete rounded boundary on focus or validation errors. Their hover layer follows the same shape. Search uses one outer capsule focus ring; its native slotted input no longer inherits the global rectangular outline. Selects reserve their label line, including after reordering and at 200% text size.

Design: [local editable Canvas draft](design/rounded-controls-318.md). The draft uses Canvas textField/select/searchBar components; outlined fields show the intended rounded geometry. Product fields retain their filled surfaces and internal floating labels. Draft JSON and rendered previews are retained alongside the earlier [wallet draft](design/wallet-order-318.md).

The unfinished wallet editor batch is also integrated: card/document supplementary sections can be reordered and edited in nested dialogs. Custom-field reordering retains its value, type and protection flag. Unknown Android section tokens survive editing. Nested Enter cannot accidentally submit the parent form; Escape, Tab, Shift+Tab and restored focus work. Cancelling the main editor discards its draft.

Bitwarden wallets and bank-card KDBX retain this layout locally; layout-only saves do not initiate remote writes or discard queued content edits. Their comparison fingerprints exclude local layout. MDBX, Android ZIP and document KDBX carry the portable order. Sync refreshes preserve a matched local wallet's layout when the incoming record has none.

Validation:

- 88 unit tests passed across the wallet order, transfer codecs, secure-vault queue and both provider suites; the follow-up queue/order/durable-sync run passed 21 tests, including the corrected monica-webdav case.
- Real Microsoft Edge 154.0.4258.62 passed complete card field saving, Markdown note saving and explicit wallet autofill (two existing browser tests).
- The new browser test passed save/restart/reopen/cancel, hidden-field reorder, nested keyboard boundaries, search focus, database selection, and 320px/200% text geometry. Screenshot inspection found and then verified the select-label overlap fix.
- Production build, both TypeScript configurations, icon subset and extension asset checks pass. The existing bundled font environment regenerated two added arrow symbols. `git diff --check` passes.

Evidence: `.artifacts/rounded-wallet-acceptance/` retains the initial missing nested close-button failure and the two passing existing tests. `.artifacts/rounded-wallet-final-labels/` holds the final passing browser test and inspected screenshots. Build log: `.artifacts/rounded-controls-build.log`. Canvas previews: `.codex-tasks/android-interop-315/raw/canvas-rounded318-{0,1}.png`.

`dist` is rebuilt at version 0.1.37 with unreleased changes. Background SHA-256: `270153784e4be2ee0fbc1d61532a0d2e105c24ae709b387883635790704c32aa`. Reload the unpacked extension and refresh its open manager page to use it.

Scope remains incomplete: this is not a new Android runtime/remote-account acceptance or full cross-client parity. Current Android `editorSectionOrder` governs wallet editors; it does not require reordering card/document detail sections. Follow-up document display and lossless custom-field editing acceptance is recorded in [document fields](document-field-parity-318.md). Backend gaps remain. The pending Android KDBX password-project authorization is unanswered; no Android source, emulator, remote account, tag or release was changed. Previously rejected cleanup was not retried; acceptance profiles remain.
