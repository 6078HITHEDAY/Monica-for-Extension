# PR 13 integration and Wi-Fi result verification

Integrated upstream `ce3d0b929836aa04f99a867e8732e8844e9a695b` (PR #13) with the 22 local commits following `10c972b` and the pending Wi-Fi work preserved in checkpoint `4018cca`. Both histories remain intact. The six pre-existing untracked design files were excluded. Android source and its unrelated local changes were not modified. No push, tag or release was performed.

## Integration decisions

- Keep one `wifi-sync` settings entry and `NearbySyncSettings.vue`, including local/MDBX source selection, guarded recovery, setup downloads and QR/link switching. Remove the duplicate contributor page. Use the contributor's role selection, remembered private-address discovery, normalized error codes and native progress labels.
- Keep the local manager client's readiness and request timeouts, immediate cancellation, and rejection of pending calls. Preserve the background close reason even if a request was awaiting readiness when the connection ended.
- Keep Android-compatible discovery advertisements and both `.gitattributes` rules. Combine locale keys and release notes. Retain the contributor's list-layout batching, lazy tile menus, popup-page preservation and CI/Edge gating changes.
- Pairing is explicitly distinct from synchronization. Real sync timestamps and revisions are saved only after the native `completed` phase confirms the peer's authenticated save receipt. Peer rejection or timeout cannot display a successful result.
- The completion dialog displays locally processed record counts, saved/deleted outcomes and at most 100 bounded titles/type labels. It contains no passwords, payloads, keys or attachment bytes. Outgoing transfer is shown as peer-confirmed; the protocol does not provide an exact list of remote database changes.

## Validation

- 283 tests across 16 nearby/preferences files passed; another 86 owner/local-adoption/metadata/origin tests passed. This covers receipt timing, rejected saves, discovery identity filtering, role selection, close/cancel behavior and preservation of prior recovery boundaries.
- The new native Android-advertisement UDP test passed. Rebuilt the debug communication helper and the bundled browser engine with the pinned toolchains. Production build, source/artifact provenance and four-page asset validation passed; the existing large-chunk warning remains.
- Security audit passed for 219 runtime commands, including the dedicated nearby manager port. Strict TypeScript checking passed for the changed E2E files.
- Nine distinct browser scenarios passed: Chromium missing-helper/settings persistence; local Canvas; Edge missing-helper setup; actual two-profile Edge QR/link pairing, discovery, transfer, result display and cancel/reconnect; and five wallet/OTP/Steam tile scenarios. The initial transfer test sent discovery before the listener was ready; it now waits for native `waiting`, then passed twice. No mock transport was used for the transfer.
- Verified pairing transfers no vault items. Receiving one synthetic login displays one saved item and its title, while its password is absent from the dialog. Inspected the settled dialog and narrow-page screenshots. The Canvas uses a project-specific local link and separate frame coordinates.
- Installer negative checks reject an invalid extension ID and mismatched checksum before creating installation output. Updated the previously configured Chrome communication component from the rebuilt bundle; installed SHA256 is `932ca4a95344902841828a67e7cfaf33cb31a88154eb57bd1b512ba87b49d65d`. No user vault was opened or read. Temporary Edge registrations were restored and test profiles removed by the existing lifecycle fixture.

Logs and synthetic screenshots remain local under `.artifacts/pr13-*`. The editable design is linked from [the design record](../design/nearby-pairing-320.md).

## Remaining acceptance boundary

The user previously confirmed that QR pairing works on the real phone. This integration has not been confirmed against that phone's reported first-sync failure. Android still needs its Sync now/manual window because the browser helper does not publish Android's mDNS presence service. Both pages should remain open and sync should be initiated on Android as instructed by the browser. This is not a claim of complete automatic Android/F-Droid interoperability or a release approval.
