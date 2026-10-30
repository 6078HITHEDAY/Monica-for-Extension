# Revision evidence for resumable native writes

Large collection profiles and ordinary files can exceed the native 16 MiB serialized transaction limit together, even when each separate write fits. A resumable sequence must not continue against a freshly read live revision after a lost response: another client may have edited the vault during the interruption.

The extension now has a read-only `content.write.anchor` boundary. It returns the complete, bounded branch identity/name/head inputs to the existing native write-revision hash. Native reads verify the hash and the revision before/after enumeration. The client independently verifies the encoding, snapshots its input, and predicts only the change to the unique `main` head caused by a confirmed content-write receipt. Every other branch remains part of the guard. Duplicate non-main branch names retain their distinct identities; ambiguous main branches stop explicitly.

Replaying an exact operation after restart yields its original commit receipt. Combining that receipt with the saved pre-write anchor reconstructs the next expected revision without accepting subsequent edits. The existing native transaction rejects the predicted revision when another edit has intervened. No revision policy, transaction limit, capability grant, native schema, vendor overlay or Android protocol is changed. Older engines advertise no anchor capability and cannot be used for this continuation path.

Acceptance on 2026-10-15:

- 126 TypeScript cases across anchor, content-write, native client and backend routing passed.
- Two native anchor tests passed, including exact receipt replay, stale continuation rejection, unchanged user edits, locked access and read-only behavior. Clippy and the debug Host build passed.
- Real Edge import/profile/restart/continuation passed in 25.1 seconds. A 1 MiB opaque profile and a 1 MiB ordinary file were written in separate bounded steps across restart. Original objects remained unchanged, file bytes matched, and a subsequent user edit survived both replay and a rejected continuation. The owned browser profile was removed automatically.
- Main/interoperability/strict E2E types, production build, artifact provenance and the security audit passed. Logs and browser evidence remain under `.artifacts/write-anchor/`.

The boundary was committed as `31774ae`. The following integration connects the metadata planner, native adapter and encrypted journal: all step IDs and plans are retained before the first mutation, advancing the journal never acknowledges partial work, and final acknowledgements are saved only after the last receipt. Unknown outcomes and cancellation retain the exact unfinished step. A stale continuation after earlier commits is preserved for recovery rather than being discarded. The full acceptance and remaining limits are recorded in [the profile sync report](nearby-profile-sync-320.md).

The current native engine is 6,438,366 bytes with SHA256 `7f77518a66ff614909136194cda71adac76ffac0c5100ee911d98a3a228a46f6`. The planner/journal integration required no additional native rebuild. Task 93 and full Wi-Fi/Android parity remain incomplete. No Android application test, user Chrome access, push, tag or release was performed.
