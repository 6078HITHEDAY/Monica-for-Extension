# Monica for Extension 0.1.38 Preview

## 中文

本版先交付已经完成的浏览器插件改进，供用户试用和反馈；完整 Android 对齐继续开发。

- **MDBX 引擎内置**：直接新建 Sky 密码库、导入／导出完整备份、重启后解锁及 WebDAV 同步，无需额外安装数据库组件。修复上传已成功但响应丢失、附件下载中断和重启恢复的问题。
- **Passkey 与自动填充**：改进 Bitwarden／KeePass 凭据识别、登录、用户验证、能力标注和缓存，减少重复查询；保留原凭据 ID、密钥、零计数及已有正计数。补齐密码项目选择、HOTP 使用记录和锁定取消保护。
- **Steam 令牌**：修复部分密码库中的 Steam 投影、标准 Bitwarden 加密 maFile 附件及大整数 SteamID 解析；缺少可用密钥的条目明确显示状态。
- **传输与恢复**：本地库、MDBX、KeePass 和 Bitwarden 个人库提供更多完整项目、附件、字段及历史保留路径；无法无损转换的内容会在预览中阻止。部分跨库移动支持中断恢复和“保留两端，完成复制”。
- **使用体验**：设置项按直接操作与二级页面整理，卡片更紧凑，去掉重复聚焦包边；修复长度滑块点击、刚打开锁定页的临时连接错误，以及自动填充开关保存时丢失键盘焦点。
- **安全**：设备密钥迁入扩展来源隔离的 IndexedDB，完善诊断脱敏、加密写入大小限制与恢复回执保护。发布时生产依赖审计为零已知漏洞；具体范围见验证记录。

**仍在开发**：附近设备同步已有内部传输与恢复基础，尚未开放插件界面；当前 Android/F-Droid 全矩阵、真实 OneDrive 登录／刷新与往返、所有后端之间的无损迁移仍未全部验收。本版是 Preview，不宣称完整稳定版发布门禁或全部跨端互通已经通过。

下载 `monica-extension-0.1.38.zip` 并解压，在 Chrome／Edge 扩展管理页开启开发者模式后加载。已有安装请在**原加载目录**完整更新文件，再点击“重新加载”；不要为升级删除原扩展。更新后刷新需要自动填充或 Passkey 的网页。

内置 MDBX 不需要本机助手。Windows Hello、已有助手管理的 MDBX 工作副本等原生功能，可另外下载 `monica-mdbx2-host-windows-x64-0.1.3.zip` 并遵循包内 README。旧助手工作副本不会自动迁移或删除。升级前保留可用的加密备份；已迁移的设备密钥配置不支持直接降级到旧版。GitHub 下载包不代表 Chrome／Edge 商店已更新。

每个 ZIP 附 SHA-256 校验文件；插件还附依赖清单和源码提交证据。[全部阶段改动](Monica-Extension-0.1.38-changelog.md) · [验证范围](../verification/release-0.1.38.md) · [反馈 Bug](https://github.com/Monica-Pass/Monica-for-Extension/issues/new?template=bug.yml)。反馈请提供版本、浏览器、密码源与复现步骤，不要上传真实密码、Passkey 私钥或密码库；安全问题按 [SECURITY.md](https://github.com/Monica-Pass/Monica-for-Extension/blob/main/SECURITY.md) 私下报告。

## English

This preview delivers the completed browser-extension stage for testing and feedback while full Android parity remains in development.

- **Built-in MDBX**: create Sky vaults, import/export complete backups, unlock after restart and synchronize over WebDAV without installing a database helper. Recover successful uploads with lost replies and interrupted attachment downloads.
- **Passkeys and autofill**: improve Bitwarden/KeePass recognition, authentication, verification, compatibility labels and caching. Preserve credential IDs, original keys, zero counters and positive history. Improve password-project selection, HOTP usage persistence and lock cancellation.
- **Steam**: fix missing projections, standard Bitwarden encrypted maFile attachments and precise SteamID handling; unavailable keys have an explicit state.
- **Transfer and recovery**: expand complete project, attachment, field and history paths for local vaults, MDBX, KeePass and personal Bitwarden vaults. Unrepresentable content is blocked in preview. Supported moves recover interruptions and can explicitly retain both copies.
- **Interaction**: compact settings with direct controls where appropriate, fewer nested pages and duplicate focus outlines; fix generator track clicks, transient lock-page startup errors and keyboard focus loss while saving the inline-autofill switch.
- **Security**: isolate device keys in extension-origin IndexedDB and improve diagnostic redaction, encrypted-write size limits and durable recovery receipts. Production dependencies have no known advisories at release review time; see the verification scope.

**Still in development:** nearby synchronization has internal transport/recovery support but no extension UI. The full current Android/F-Droid matrix, real OneDrive sign-in/refresh/round trips and lossless migration between every backend are not accepted yet. This Preview does not claim completion of the full stable-release gate or universal interoperability.

Extract `monica-extension-0.1.38.zip` and load it in Chrome/Edge developer mode. Existing users should replace files in the **same loaded directory** and reload the extension, then refresh sign-in pages. Do not uninstall the existing extension to upgrade.

Built-in MDBX needs no helper. Windows Hello and existing helper-managed MDBX working copies can use the optional `monica-mdbx2-host-windows-x64-0.1.3.zip`; follow its README. Existing native working copies are not automatically migrated or deleted. Keep a usable encrypted backup before upgrading; migrated device-key profiles do not support direct downgrade to older builds. This GitHub download does not update browser stores.

ZIPs include SHA-256 sidecars; the extension also includes dependency and source-commit evidence. [Stage changes](Monica-Extension-0.1.38-changelog.md) · [Verification scope](../verification/release-0.1.38.md) · [Report bugs](https://github.com/Monica-Pass/Monica-for-Extension/issues/new?template=bug.yml). Include versions, backend and reproduction steps, never real passwords, private keys or vaults. Report security issues privately following [SECURITY.md](https://github.com/Monica-Pass/Monica-for-Extension/blob/main/SECURITY.md).
