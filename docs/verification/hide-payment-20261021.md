# Hide payment creation — 2026-10-21

Version remains 1.0.101, unreleased.

Removed payment-account from the shared split-menu/full-picker create catalogue and the create-only wallet selector. Its record model, provider codecs, filters, detail and editing are preserved. Contextual primary actions use bank-card creation when existing payment-account records are filtered, including the wallet and full-vault views, so the hidden type is not recreated through a filter-dependent action.

The updated local M3E Canvas is saved as `docs/design/hide-payment-20261021.m3e.json`, with a project-isolated share URL in `docs/design/hide-payment-20261021-url.txt`. Actual Canvas rendering was loaded and inspected before implementation. Previous design sketches remain available locally.

Verification uses synthetic records and isolated installed Edge profiles. The editor-groups and wallet-create acceptance checks require exactly six wallet choices and no payment-account entry in the split menu or fallback picker. A legacy payment record is imported, displayed, edited and saved, asserting all original fields remain intact. Both wallet-filter and full-vault-filter primary-create paths must open a bank-card editor. Keyboard End/ArrowUp behavior follows the new last visible menu item. No real Android transfer is claimed by this UI-only change.

No commit, push, tag or release; no Chrome/personal profiles or Android emulator used.

Results: 6 Edge acceptance tests passed; local Canvas loaded and inspected. Build/typecheck, Chromium/Firefox asset verification, security audit, workflow validation and whitespace checks passed. Current dist/dist-firefox build: f1433b593039657d517b (1.0.101).
