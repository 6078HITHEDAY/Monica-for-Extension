# Monica for Extension — 下一版 / Next release

当前正式版本 / Current stable version: **1.0.101**。

[1.0.101 首个正式版发行说明 / First stable release notes](releases/Monica-Extension-1.0.101.md)

后续新增改动记录在此，下一版版本号尚未切换。已发布说明保留原样。
New changes go here; the next development version has not been selected. Published notes remain unchanged.

## 中文

- 新增独立“导入与导出”设置页：导入先预览，再新增本地副本；每次导出重新验证身份。
- 文件迁移扩展为 Monica ZIP、KeePass KDBX、Monica/Bitwarden 明文 JSON、多种 CSV、Aegis、Stratum、OTP URI 和 Steam maFile；显示格式范围和跳过数量。
- 修复 Bitwarden 明文 JSON 导入后成为只读记录的问题，支持登录、笔记、卡片、身份和 SSH 项目在本地编辑与删除。
- 使用公共 Android 虚拟机验证 ZIP/KDBX 双向迁移及 CSV、Aegis、Stratum、OTP URI、Steam maFile 的 Android 实际读取。

## English

- Added a dedicated Import and export settings page with previews, independent local imports and fresh authentication for every export.
- Expanded file migration to Monica ZIP, KeePass KDBX, plaintext Monica/Bitwarden JSON, common CSV formats, Aegis, Stratum, OTP URIs and Steam maFiles, with format scope and skipped-item counts.
- Fixed plaintext Bitwarden JSON becoming read-only records; imported logins, notes, cards, identities and SSH items can be edited and deleted locally.
- Verified ZIP/KDBX round trips with the shared Android emulator and actual Android reads of CSV, Aegis, Stratum, OTP URI and Steam maFile exports.
