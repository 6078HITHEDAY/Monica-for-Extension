# 旧 mock 管理界面的 Monica Server 路由规划

此清单归档自提交 `0a0a3509cd780b741b004cda992251f4994805cf` 的 `src/lib/api.ts`，用于保留已退役界面的 38 条历史规划参考，未核对服务器实现。

现行扩展的管理页由 `src/runtime/live-vault.ts` 连接加密密码库；实际密码源通信由各 provider adapter 实现。后续服务器集成应依据目标服务器的实际契约进行验证。

| 方法 | 路径 | 原规划说明 |
| --- | --- | --- |
| POST | `/api/v1/auth/register` | Create a Monica Server account without receiving vault secrets. |
| POST | `/api/v1/auth/login` | Issue web console and client tokens. |
| POST | `/api/v1/auth/refresh` | Rotate an access token while keeping device trust state. |
| GET | `/api/v1/me` | Return account, server capabilities, and feature flags. |
| GET | `/api/v1/projects` | List encrypted Monica projects. |
| POST | `/api/v1/projects` | Create a project record for encrypted client data. |
| PATCH | `/api/v1/projects/{projectId}` | Update name, archive state, category, or collection links. |
| DELETE | `/api/v1/projects/{projectId}` | Move a project to the recycle bin. |
| GET | `/api/v1/projects/{projectId}/entries` | List entries such as logins, notes, cards, TOTP, passkeys, SSH keys, and API tokens. |
| POST | `/api/v1/projects/{projectId}/entries` | Add an encrypted entry. |
| GET | `/api/v1/attachments` | List files and image flags. |
| POST | `/api/v1/attachments` | Upload encrypted file content. |
| GET | `/api/v1/attachments/{attachmentId}/download` | Download encrypted attachment bytes for clients. |
| GET | `/api/v1/sends` | List Monica Send objects, access limits, deletion dates, and disabled state. |
| POST | `/api/v1/sends` | Create text or file Send with optional password and access count limit. |
| PATCH | `/api/v1/sends/{sendId}` | Disable, rotate, or update Send policy. |
| GET | `/api/v1/orgs` | List organizations and shared vault spaces. |
| POST | `/api/v1/orgs/{orgId}/members/invite` | Invite members to Monica collections. |
| GET | `/api/v1/orgs/{orgId}/collections` | List collection policy and member counts. |
| PATCH | `/api/v1/orgs/{orgId}/policies/{policyId}` | Enable or disable organization policy. |
| POST | `/api/v1/devices` | Register a client device and start approval if required. |
| PATCH | `/api/v1/devices/{deviceId}/trust` | Approve, revoke, or rename a device. |
| GET | `/api/v1/mdbx/vaults` | List MDBX databases, sync mode, unlock method, and status. |
| POST | `/api/v1/mdbx/vaults/{vaultId}/sync/hello` | Start an MDBX sync session. |
| POST | `/api/v1/mdbx/vaults/{vaultId}/sync/want` | Request missing versions from the server. |
| POST | `/api/v1/mdbx/vaults/{vaultId}/sync/batches` | Upload encrypted version batches. |
| POST | `/api/v1/mdbx/vaults/{vaultId}/snapshots` | Create an encrypted snapshot record. |
| POST | `/api/v1/mdbx/vaults/{vaultId}/snapshots/{snapshotId}/restore` | Queue a snapshot restore. |
| GET | `/api/v1/conflicts` | List project, entry, and attachment conflicts. |
| POST | `/api/v1/conflicts/{conflictId}/resolve` | Save the chosen conflict resolution. |
| GET | `/api/v1/backups` | List encrypted Monica JSON, MDBX files, snapshots, and sync bundles. |
| POST | `/api/v1/backups` | Upload encrypted backup or reserve a scheduled server snapshot. |
| GET | `/api/v1/import-export/jobs` | Track Monica JSON, CSV, Bitwarden, KeePass, Aegis and Markdown jobs. |
| POST | `/api/v1/import-export/jobs` | Start an import or export job. |
| GET | `/api/v1/security/reports` | Store client-side security analysis summaries. |
| GET | `/api/v1/audit` | Return operation log and admin audit events. |
| GET | `/api/v1/admin/diagnostics` | Return service, storage, queue, and mail diagnostics. |
| PATCH | `/api/v1/admin/settings` | Update storage, retention, invite, and session settings. |
