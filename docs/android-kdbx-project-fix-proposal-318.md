# Android KDBX password project import proposal

This proposal has not changed Android product sources. Current ordinary Android baseline: `83664b96995d3d4ba7ecc6ad705b6716ac594431` (`1.0.318`, versionCode 12).

## Confirmed problem

`PasswordViewModel.upsertKeePassEntries` imports each password and its custom fields, but neither the `existing.copy` nor the new `PasswordEntry` path projects `monica.content.credential.projectId` into `passwordGroupId`. The current source still has this omission. Earlier real Android instrumentation demonstrated three passwords in one project plus an independent singleton becoming four projects after a fresh KDBX import. See [the original runtime evidence](keepass-project-credentials-317.md).

## Proposed change

Within that import transaction, extract exactly one `monica.content.credential` field, validate it with the existing `ProjectCredentialGroup.parse`, and use its supported project UUID in both the insert and update paths:

```kotlin
val importedProjectId = item.customFields
    .singleOrNull { it.title == ProjectCredentialGroup.FIELD }
    ?.value?.let(ProjectCredentialGroup::parse)?.projectId

// existing.copy(...)
passwordGroupId = importedProjectId ?: existing.passwordGroupId,

// PasswordEntry(...), for a fresh row
passwordGroupId = importedProjectId,
```

No title/account matching, new UUID generation, credential metadata rewriting, Passkey changes, schema migration or key/counter changes are needed. `passwordProjectKey()` already includes the KeePass database ID, so identical project UUIDs in different databases remain isolated. Legacy Room-only grouping remains unchanged if no supported source identity exists. Removal of a portable grouping marker is a separate lifecycle case: do not infer destructive ungrouping merely from absent or unreadable metadata.

## Acceptance before declaring the repair complete

- Current Android unit cases for valid, changed, duplicate, absent, malformed and future metadata; preserve legacy grouping and source bytes.
- Rerun the existing `ExtensionKeePassProjectInteropTest` against the current application: fresh database import restores one three-password project and an independent singleton.
- Add an existing-row refresh with a changed supported project ID; check both paths retain original KDBX entry UUIDs, passwords, OTP, notes, rich fields and exact custom-field metadata.
- Import the extension-edited KDBX back into Android and inspect its project editor; repeat with the same project ID in a second database to verify isolation.
- Keep deletion, unknown metadata and Passkey regression evidence separate. Do not claim full KDBX lifecycle parity from the grouping test.

## Scope authorization

The current [task specification](../.codex-tasks/android-interop-315/SPEC.md) limits Android modifications to the previously authorized Passkey defects: “Other Android changes remain outside this authorization.” This password-project import fix requires expanding that scope. If authorized, apply and verify it in ordinary Android and F-Droid while preserving their source differences. Ordinary notes remain in unreleased 1.0.318; released F-Droid 1.0.318 notes and `25.txt` remain untouched, with any new F-Droid entry recorded for the next unreleased version.
