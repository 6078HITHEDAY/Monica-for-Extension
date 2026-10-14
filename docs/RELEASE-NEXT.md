# Monica for Extension — 下一版 / Next release

> 0.1.39 阶段改动已归档至[发行说明](releases/Monica-Extension-0.1.39.md)及[验证记录](verification/release-0.1.39.md)。0.1.38 历史记录保持原样。 / The 0.1.39 stage is archived; 0.1.38 historical records are unchanged.

## 中文

- 附近同步现可保留本地项目的原始来源归档，包括原始 JSON／二进制编码、未知格式及历史版本；接收、重启、编辑、便携备份恢复和再次复制均保留原文。修复已有回执遗漏归档的路径，并对仅归档变化的旧快照执行保护检查。归档保持加密且不会自动创建远端连接或启用凭据；此阶段仍无附近同步界面。

完整 Android 对齐仍在开发：附近同步界面与自动调度、完整 MDBX 接收及文件夹／根元数据落库、来源归档的原生还原与不支持类型、跨后端冲突与恢复，以及当前 Android/F-Droid、真实 OneDrive 和跨后端矩阵验收。

## English

- Nearby synchronization now preserves local items’ original source archives, including exact JSON/binary-encoded payloads, unknown formats and historical versions through adoption, restart, edits, portable-backup restore and subsequent local copies. Fixes receipt paths that omitted archives and guards stale snapshots when only archival content changes. Archives remain encrypted and never automatically create remote connections or activate credentials; there is still no nearby UI.

Full Android parity remains in development: nearby UI and automatic scheduling; complete MDBX adoption and native folder/root metadata; native restoration of archived origins and unsupported item types; cross-backend conflict/recovery; and current Android/F-Droid, real OneDrive and cross-backend acceptance.
