# Bitwarden project removal in the extension runtime

The existing internal removal coordinator is now connected to the manager commands, provider queue and recovery interface. A project belonging to one enabled Bitwarden source can use the existing remove/undo editor flow. Multi-source removal remains unavailable. Full Android/extension parity is still incomplete.

## Runtime and lifecycle

- `PasswordProjectRemovalWorkflow` dispatches Bitwarden to its dedicated coordinator. It preserves the existing same-provider queue and preparation cancellation at the vault write lock. Queued editor requests cannot cross a vault lock/unlock session.
- `BitwardenProjectRemovalRuntime` registers manager operations in the existing provider busy/abort map. Active positive-counter Passkey operations cannot be overlapped. Sync recovery uses the current sync controller without recursively entering the provider queue.
- Ordinary Bitwarden sync first resumes outstanding removals, then rereads the current account and verifies its binding. An unfinished recovery prevents ordinary synchronization. Refreshed tokens are retained.
- The shared Bitwarden cache is invalidated before and after each dedicated attempt, including partial or failed operations. Logout now aborts active provider work and clears that source's cache; existing lock/remove/session-expiry hooks use the same controller registry.
- Account and recovery readers select their data before cloning, avoiding repeated copies of unrelated vault items/source envelopes. They retain the existing encrypted-envelope/session validation and caller isolation.

The queue covers project removal and ordinary synchronization. This batch does not claim a new global queue for every existing folder, Send or attachment operation; remote changes continue to be checked by the transaction's independent source and attachment verifiers.

## Manager interface

- The editor enables removal for a single Bitwarden source and explains that embedded Passkeys are retained as separate items in the same account.
- The pending list shows verified/total copy counts. It does not expose native Cipher IDs, private keys, encrypted payloads or login credentials.
- Authenticated Bitwarden sources show “核对并继续”. Signed-out sources show “重新登录” and open the original Bitwarden account, without requiring an MDBX host.
- Cancellation reports that already created or uncertain independent copies remain in Bitwarden. No copies are silently deleted.
- Restoring/confirmed-restored-but-not-adopted transactions display restoration status. Saved deletion requests cannot be cancelled as preparation.
- All six external locale catalogs include the added messages. The English catalog and public catalog keys match.

The [editable local Canvas design](design/bitwarden-removal-318.md) and [JSON](design/bitwarden-removal-318.m3e.json) were saved before the UI changes. Four single-page Canvas previews were rendered in Edge. Real extension screenshots at desktop and 320px were inspected. Continuous groups retain 24px outer/4px inner corners and 12px outer spacing. Existing rounded search/input work was preserved.

## Evidence

- Initial focused workflow: 18 passing tests. Initial related regression: 8 files / 157 passing tests.
- Final regression: 12 files / 267 passing tests, including service encryption, restoration/adoption, preservation, sender policy and cached-read isolation. `.artifacts/bw-removal-runtime-regression-final.log`.
- Both TypeScript configurations, 234 icons and all 3 extension pages pass; `dist` rebuilt at version 0.1.37. `.artifacts/bw-removal-runtime-build-verified.log`.
- Runtime security audit passes 212 commands / 24 manager-only project commands. `.artifacts/bw-removal-runtime-audit-verified.log`.
- Actual installed Edge with the production MV3 extension and real IndexedDB: direct completion, lost create response followed by manager recovery, preparation cancellation, editor confirmation, and source-specific settings routing. Final-build results: **5 passed in 18.3s**, recorded in `.artifacts/bw-removal-runtime-edge-verified.log`.
- Browser tests use synthetic HTTPS responses supplied by Playwright. They exercise the actual background commands, production client/coordinator and manager UI, but are **not** live Bitwarden/Vaultwarden or Android acceptance.
- On successful paths, two independent remote native Passkeys decode and sign successfully against the original public keys; counters stay `[0,23]`, original local IDs survive, exactly two copies/one source delete occur, and two subsequent ordinary syncs retain both keys. In the cancellation path, the uncertain first copy remains and there is no source deletion.
- Screenshots and browser identities: `.artifacts/bw-removal-edge-verified/`. Prior initial/final browser runs and their evidence are retained.

The first Canvas preview failed because the new top-app-bar item lacked its required `variant`; the draft was corrected. The first security audit after adding English messages rejected missing keys in the public Japanese catalog; all six catalogs were completed, followed by a fresh build/audit. These were not waived.

## Remaining acceptance

Local child usage/edits during the transaction are still conservatively rejected; explicit recovery decisions for these cases and truly ambiguous results remain unfinished. This protects data but can leave an operation pending and prevent ordinary sync until it is resolved. Cancellation copy cleanup/management, whole-transaction real service/Android consumption and the four previously unrun live rollback cases remain open.

The earlier automatic approval rejection of starting the existing Vaultwarden container remains respected; its only stated reason was `blocked by policy`. It was not retried. The previous rejected cache/profile deletions were not retried and no disk savings are claimed. This batch started no Docker service or Android emulator and changed no Android product code, credential IDs, private keys or deliberate zero-counter rules. No release, push, tag or commit was made.

Direct OneDrive real-account OAuth/autosync, the pending Android KDBX grouping decision, WebDAV ZIP concurrency and the overall type/backend/lifecycle matrix remain separate unfinished work. The user's successful GitHub Bitwarden Passkey/login responsiveness acceptance remains valid; this report does not turn that result into blanket parity acceptance.

2026-10-10 更新：冻结删除意图后的本地编辑现可转为持久化补偿与显式冲突；新日志中的 Passkey 本机使用统计不再卡住恢复。325 项相关回归、构建/审计及 7 条不同 Edge 合成 HTTP 流程通过。两种冲突选择后同步和原凭据/副本签名通过。准备期编辑、来源/回执歧义、实际服务/Android 和整体互通仍未完成，见 [本地编辑恢复报告](bitwarden-project-local-recovery-318.md)。
