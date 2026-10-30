# New editor groups — 2026-10-21

Version: 1.0.101, unreleased.

The generic wallet/note/OTP editor offered all six storage kinds in a single create selector. This allowed creating a bank card and switching to a note or standalone OTP. Pass templates were in a second selector. The credential editor also lacked native API token switching.

The create-only wallet selector now combines supported wallet kinds and pass templates, in Android order, retaining the extension's existing payment-account support. Notes and OTP have no cross-group selector. Card subtype is visible in primary fields; new cards default to DEBIT, with existing card types unchanged. Existing-edit projection preservation and unknown template handling remain intact.

Credential creation shares a seven-option selector. Native tokens continue using ApiTokenEditor and ApiTokenItem rather than login custom fields. Switching shares title, notes, favorite and compatible target; token-specific fields and credential drafts remain separate. Wallet-specific drafts are also separate for each kind/template. Drafts are held in memory for the active create flow, discarded on close/lock, and never written by switching alone.

Local editable M3E Canvas source and share URL: `docs/design/editor-groups-20261021.m3e.json` and `docs/design/editor-groups-20261021-url.txt`. Loaded at `http://127.0.0.1:5186/?project=extension-editor-groups-20261021` using its saved fragment, verified actual fields and inspected its rendered screenshot before UI implementation. Screenshots stay local.

Validation uses synthetic records and isolated installed Microsoft Edge profiles. Chrome and personal browser profiles were not opened; no Android emulator was used.

- `npm run build:firefox`: TypeScript checks and Chromium/Firefox build/asset verification pass.
- Core API token, edited projection and wallet content-order unit tests: 17 pass.
- `editor-groups.spec.ts`, `wallet-create.spec.ts`, `android321-fields.spec.ts`, `wallet-content-order.spec.ts`: 8 Edge tests pass. Cover exact group boundaries, wallet switching/draft isolation, saving after switching, card subtype persistence, separate note/OTP editors, credential/native-token round trips, cancellation, wallet pass restart persistence, 420px layout, fallback picker, existing Android fields and unknown metadata preservation.
- `api-token.spec.ts` and targeted `m3e-interactions.spec.ts`: another 7 distinct Edge tests pass for native-token save/edit/lock, 320px enlarged text, primary create actions, nested drafts, fallback picker and keyboard selection in both motion modes. Total: 15 distinct Edge application tests.
- Workflow validation passes; required Edge core acceptance includes the group and wallet-create regressions.

This verifies extension editing of Android-compatible data. It does not claim a new live Android transfer test. No commit, push, tag or release was created.

Final build: d1cce8ff4170e622a000; dist and dist-firefox are current. Security audit, synchronized language catalogs and git diff whitespace checks pass.

Follow-up: payment-account creation was subsequently hidden at the user’s request; see [hide-payment-20261021.md](hide-payment-20261021.md). Existing records retain compatibility.
