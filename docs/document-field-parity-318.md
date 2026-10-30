# Document detail and custom-field editing — 2026-10-09

Document details now expose the stored prefix/title, username and structured address, including the third address line. Distinct address addressee/company/email/phone values remain separate from the person's primary fields. Each row retains the existing copy action; identifier values remain hidden until revealed. Section headings use the active language.

Editing one custom-field value previously normalized every sibling's type/protection and discarded legacy unnamed rows. The editor now tracks each source occurrence by draft identity, preserving duplicate names, unknown properties and absent type metadata through editing and reordering. Explicit type changes still update protection. New nonempty unnamed fields and erased existing names reject saving while preserving the draft; untouched empty new rows are ignored. Card-face previews accept unfinished drafts, so save validation cannot throw during rendering.

Design: [local editable Canvas](design/document-fields-318.md), with the saved `document-fields-318.m3e.json`. Its rendered preview is `.codex-tasks/android-interop-315/raw/canvas-document-fields318.png`. The design uses actual continuous listItem groups and copy actions. Current Android `editorSectionOrder` is an editor setting; this change makes no claim that document/card detail sections must follow it.

Validation:

- Both defects were reproduced in actual Microsoft Edge against the earlier `dist`: missing prefix/address rows and custom sibling metadata/unnamed data loss. Failure evidence remains in `.artifacts/document-parity-before/`.
- The affected core, codec and localization run passed 41 tests. After separating preview and save validation, the two core files passed all six tests again.
- Final production build, both TypeScript configurations, icon subset and extension-page asset checks passed: `.artifacts/document-fields-build.log`.
- Actual installed Microsoft Edge **154.0.4258.62**, headed, with two isolated synthetic profiles: `document-field-parity.spec.ts` passed both scenarios in 12.7 seconds. Details, clipboard readback, reveal, 320px geometry, one-field editing, duplicate reorder, exact untouched fields, reload/reopen, rejected unnamed save, draft retention, cancel and zero page errors are checked. `.artifacts/document-parity-final-save.log` and `.artifacts/document-parity-final-save/` contain the result and runtime provenance.
- Desktop/address/320px final screenshots were inspected. Existing wallet save/autofill and order/keyboard scenarios also passed in the preceding `.artifacts/document-parity-after/` run. They were not rerun after the preview-only validation change.

Two intermediate failures are retained: the clipboard test initially lacked permission/waiting for copy completion; the extended validation scenario then exposed a real render-time exception, fixed by restricting validation to save. Neither failed run is counted as final acceptance.

Reproduce the browser acceptance after building:

```powershell
npx playwright test tests/e2e/document-field-parity.spec.ts --output=.artifacts/document-parity-review
```

The current unpacked `dist` includes these unreleased fixes and remains version **0.1.37**. No Android source, database, Passkey key/ID/counter, release/tag or real remote account was changed. This batch proves extension UI and source-value preservation with synthetic records, not a new Android application or cloud roundtrip. Full parity remains incomplete.

## Password project follow-up

The same audit reproduced a separate password-form bug: editing one ordinary custom field filtered out existing rows whose name and value were both empty, including their protection/future metadata. Whole-form preservation already handled unrelated title edits, but could not preserve such rows after another member of the array changed.

`App.vue` now registers source occurrences with the shared editor and serializes them before the existing GPG/API metadata updates. Password forms use a verbatim mode because they expose a protection checkbox rather than the wallet type selector. No extra wallet type metadata is materialized. New unnamed values reject saving with the localized error while preserving the draft. Explicit deletion remains possible.

`login-custom-field-preservation.spec.ts` reproduces the loss in `.artifacts/login-fields-before-project/`, then passes against the patched build. Its synthetic three-password project plus independent sentinel verifies the selected custom-field edit, empty-source metadata, duplicate-name siblings, original passwords/project identities, reload/reopen, rejected new unnamed value, unchanged stored records and cancel. The initial fixture accidentally selected the same-title independent row; that setup failure remains in `.artifacts/login-fields-before/` and is not counted as product evidence.

Final consolidated verification: **37 tests / six core and manager files**, production build, both TypeScript configurations, icon/assets and diff checks pass. **Three actual Edge 154.0.4258.62 scenarios pass in 20.8 seconds**: both document cases plus the password project case, with zero page errors. Logs: `.artifacts/login-fields-unit-after.log`, `.artifacts/login-fields-build.log`, `.artifacts/login-document-fields-final.log`; screenshots/profiles/build fingerprints: `.artifacts/login-document-fields-final/`. The two raw-password-mode unit failures are retained in `.artifacts/login-fields-unit-before.log`.

This follow-up changes source preservation and validation in the existing password controls, without a new layout. It does not establish new Android application, Native Host or remote backend acceptance. The existing [current password audit](password-field-audit-316.md) retains those separate outstanding requirements.
