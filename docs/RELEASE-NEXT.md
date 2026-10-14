# Monica for Extension — 下一版 / Next release

> 0.1.39 阶段改动已归档至[发行说明](releases/Monica-Extension-0.1.39.md)及[验证记录](verification/release-0.1.39.md)。0.1.38 历史记录保持原样。 / The 0.1.39 stage is archived; 0.1.38 historical records are unchanged.

## 中文

- MDBX 同步底层补齐文件夹及条目附件目录，保留附件归属、内容摘要与删除记录；分块读取前后检查数据库版本，并校验完整内容摘要，避免同步中途修改导致新旧数据混用。继续执行 Power 与已删除内容的访问限制。此项仍是附近同步的底层准备，尚未完成 Wi-Fi 同步入口。

- MDBX 同步底层新增整笔内容接收：密码项目、文件夹、标签、关系及附件可在同一受版本保护的事务内保存，支持附件单独更新、冲突拒绝和重启后恢复原提交回执。保留 Passkey 原密钥、凭据 ID 与计数，不把连接中断误报为未写入。此项仍是附近同步的底层准备，Wi-Fi 同步入口与完整原生接收流程尚未完成。

- MDBX 同步底层补齐受内容版本保护的标签、关联和关系分页读取；保留未关联标签与删除标记，活动内容分块校验摘要并保留原始数值精度。延续 Power 权限、删除内容不可披露及安全审计策略。此项是附近同步的底层准备，尚未提供可用的 Wi-Fi 同步入口。

- 附近同步现可保留本地项目的原始来源归档，包括原始 JSON／二进制编码、未知格式及历史版本；接收、重启、编辑、便携备份恢复和再次复制均保留原文。修复已有回执遗漏归档的路径，并对仅归档变化的旧快照执行保护检查。归档保持加密且不会自动创建远端连接或启用凭据；此阶段仍无附近同步界面。

完整 Android 对齐仍在开发：附近同步界面与自动调度、完整 MDBX 接收及文件夹／根元数据落库、来源归档的原生还原与不支持类型、跨后端冲突与恢复，以及当前 Android/F-Droid、真实 OneDrive 和跨后端矩阵验收。

## English

- MDBX synchronization groundwork now catalogs folder-owned and object-owned attachments with their owners, content hashes and tombstones. Chunked downloads verify the complete hash and database revision to reject concurrent changes. Existing Power and deleted-content restrictions remain enforced; the Wi-Fi synchronization entry point is still in development.

- MDBX synchronization groundwork now supports atomic adoption of objects, folders, labels, relations and attachments under a revision guard, including attachment-only updates, conflict rejection and durable receipt recovery after restart. Original Passkey keys, credential IDs and counters are retained; interrupted connections are not treated as proof that nothing was written. The nearby UI and complete native adoption flow remain in development.

- MDBX synchronization groundwork now includes revision-bound, paged label, assignment and relation reads, retaining unassigned labels and tombstone metadata. Active payload chunks are hash-checked without rounding native numbers. Power restrictions, deleted-content denial and security auditing remain intact. This is a prerequisite for nearby synchronization, not a usable Wi-Fi synchronization entry point.

- Nearby synchronization now preserves local items’ original source archives, including exact JSON/binary-encoded payloads, unknown formats and historical versions through adoption, restart, edits, portable-backup restore and subsequent local copies. Fixes receipt paths that omitted archives and guards stale snapshots when only archival content changes. Archives remain encrypted and never automatically create remote connections or activate credentials; there is still no nearby UI.

Full Android parity remains in development: nearby UI and automatic scheduling; complete MDBX adoption and native folder/root metadata; native restoration of archived origins and unsupported item types; cross-backend conflict/recovery; and current Android/F-Droid, real OneDrive and cross-backend acceptance.
