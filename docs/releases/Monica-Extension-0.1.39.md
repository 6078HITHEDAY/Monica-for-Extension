# Monica for Extension 0.1.39 Preview

## 中文

本版收尾已完成的安全与同步恢复改动，继续供用户试用和反馈。0.1.38 的内置 MDBX、Passkey／自动填充、Steam 令牌、设置与生成器改进继续保留，详见[上一阶段说明](Monica-Extension-0.1.38.md)。

- **恢复保护**：修复恢复便携备份后，旧同步回执错误阻止新设备后续修改的问题；保留项目身份、附件和原 Passkey 密钥，不重建现有凭据或改变签名计数策略。
- **同步后台**：补齐锁定、会话过期、关闭管理页和设置变更时的传输取消；保存加密内容前再次检查会话。内部本地接收支持独立／空文件夹、嵌套路径、根标签和空删除标记，重启与往返保留原身份。
- **构建安全**：可选字体生成工具 fonttools 更新至 4.60.2，修复已确认的 varLib 任意文件写入与 XML 注入漏洞。插件和正常构建不依赖 Python，现有字体文件保持不变。

**仍在开发**：附近同步尚无插件界面或自动同步入口；完整 MDBX 接收、文件夹／根元数据落库、来源归档，以及当前 Android/F-Droid、真实 OneDrive 与跨后端矩阵仍未全部验收。本版为 Preview，不宣称完整 Android 对齐或稳定版全量发布门禁通过。

下载 `monica-extension-0.1.39.zip` 并解压。已有用户在**原加载目录**完整更新文件后，在 Chrome／Edge 扩展管理页点击“重新加载”，再刷新需要自动填充或 Passkey 的网页；无需删除原扩展。

内置 MDBX 无需另装组件。Windows Hello、旧助手管理的 MDBX 工作副本继续使用[已发布的可选 Windows Host 0.1.3](https://github.com/Monica-Pass/Monica-for-Extension/releases/tag/v0.1.38)，本版未改动助手。GitHub 发布不代表浏览器商店已更新。

附 SHA-256 校验文件、依赖清单与源码提交证据。[验证范围](../verification/release-0.1.39.md) · [反馈 Bug](https://github.com/Monica-Pass/Monica-for-Extension/issues/new?template=bug.yml)。反馈请提供版本、浏览器、密码源和复现步骤；不要上传真实密码、Passkey 私钥或密码库。安全问题按 [SECURITY.md](https://github.com/Monica-Pass/Monica-for-Extension/blob/main/SECURITY.md) 私下报告。

## English

This stage closes the completed security and sync-recovery changes for testing and feedback. The built-in MDBX, Passkey/autofill, Steam, settings and generator improvements from 0.1.38 remain available; see the [previous stage](Monica-Extension-0.1.38.md).

- **Restore protection**: fix old sync receipts incorrectly blocking subsequent edits after portable-backup restore. Preserve item identities, attachments and original Passkey keys without recreating credentials or changing the signing-counter policy.
- **Sync backend**: cancel transfers on lock, session expiry, manager closure and preference changes, checking the session again before encrypted commits. Internal local adoption now retains standalone/empty folders, nested paths, root tags and empty tombstones through restart and reciprocal updates.
- **Build security**: update optional fonttools to 4.60.2 for the confirmed varLib arbitrary-file-write/XML-injection advisory. Python is not used by the extension or its normal build; shipped font files are unchanged.

**Still in development**: there is no extension nearby UI or automatic-sync entry point. Complete MDBX adoption, native folder/root metadata, archived origins and the current Android/F-Droid, real OneDrive and cross-backend acceptance matrices remain unfinished. This Preview does not claim full Android parity or completion of the full stable-release gate.

Extract `monica-extension-0.1.39.zip`. Existing users should replace files in the **same loaded directory**, reload the extension in Chrome/Edge, then refresh autofill/Passkey pages. Do not uninstall the existing extension to upgrade.

Built-in MDBX needs no helper. Windows Hello and existing native-managed working copies continue using the [previously released optional Windows Host 0.1.3](https://github.com/Monica-Pass/Monica-for-Extension/releases/tag/v0.1.38); no helper changes are included here. GitHub publication does not update browser stores.

SHA-256 sidecars, dependency inventory and source-commit evidence are included. [Verification scope](../verification/release-0.1.39.md) · [Report bugs](https://github.com/Monica-Pass/Monica-for-Extension/issues/new?template=bug.yml). Provide versions, backend and reproduction steps, never real passwords, private keys or vaults. Report security issues privately following [SECURITY.md](https://github.com/Monica-Pass/Monica-for-Extension/blob/main/SECURITY.md).
