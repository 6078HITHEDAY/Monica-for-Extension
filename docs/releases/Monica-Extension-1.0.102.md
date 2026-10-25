# Monica for Extension 1.0.102

2026-10-25 · 标签 / Tag: `v1.0.102`

## 中文

- 修复自动填充后使用原密码登录仍弹出“更新 Monica 中的密码”的问题。提交密码与同网站、同账号已存密码完全一致时不再提示或写入；密码确实变化时继续显示更新提示，空格与大小写变化也按真实变化处理。
- 修改后又恢复原密码时清理旧的更新候选，避免刷新或导航后重新弹出。多个同名记录中已有相同密码时不重复提示；不同账号复用相同密码仍可正常保存。
- 新增独立“导入与导出”设置页：导入先预览，再新增本地副本；每次导出重新验证身份。
- 文件迁移支持 Monica ZIP、KeePass KDBX、Monica/Bitwarden 明文 JSON、多种 CSV、Aegis、Stratum、OTP URI 和 Steam maFile，并显示格式范围和跳过数量。支持 Aegis、Stratum 加密备份导入；它们的导出为明文。
- 修复 Bitwarden 明文 JSON 导入后成为只读记录的问题，支持登录、笔记、卡片、身份和 SSH 项目在本地编辑与删除。
- 已使用公共 Android 虚拟机验证 ZIP/KDBX 双向迁移，以及 CSV、Aegis、Stratum、OTP URI、Steam maFile 的 Android 实际读取。详细范围见[导入导出验证](../import-export-20261023.md)。

安装或升级：下载 `monica-extension-1.0.102.zip`，解压至固定目录，在 Chrome/Edge 扩展管理页开启开发者模式并加载该目录。升级时保留原目录和扩展 ID，覆盖文件后重新加载扩展，再刷新已打开的网页，使新的内容脚本生效。无需卸载扩展或重新导入密码库。

支持 Chrome/Edge 128+。Firefox 独立构建仍按[Firefox 说明](../FIREFOX.md)使用，永久安装需 Mozilla 签名，本次公开附件不包含未签名 XPI。配套 Windows 本机助手未变更，已有用户无需因本次密码提示修复重新安装助手。

## English

- Fixed the update-password prompt appearing after signing in with an unchanged Monica-autofilled password. Submitting the exact password already stored for the same site and account now stays silent and does not write a record. Actual changes, including whitespace or case changes, still prompt for an update.
- Clear stale update candidates when an edited password is reverted, preventing the prompt from returning after reload or navigation. An exact match among same-username records stays silent; a different account reusing the same password can still be saved.
- Added a dedicated Import and export settings page with previews, independent local imports and fresh authentication for every export.
- File migration supports Monica ZIP, KeePass KDBX, plaintext Monica/Bitwarden JSON, common CSV formats, Aegis, Stratum, OTP URIs and Steam maFiles, with format scope and skipped-item counts. Encrypted Aegis and Stratum backups can be imported; their exports are plaintext.
- Fixed plaintext Bitwarden JSON becoming read-only records; imported logins, notes, cards, identities and SSH items can be edited and deleted locally.
- Verified ZIP/KDBX round trips with the shared Android emulator and actual Android reads of CSV, Aegis, Stratum, OTP URI and Steam maFile exports. See the [import/export verification](../import-export-20261023.md) for scope.

Install or upgrade: extract `monica-extension-1.0.102.zip` to a permanent directory and load it in Chrome/Edge developer mode. To upgrade, keep the existing directory and extension ID, replace its files, reload the extension, then refresh open websites so the new content scripts take effect. Uninstalling or reimporting the vault is unnecessary.

Chrome/Edge 128+ are supported. Firefox remains a separate build with Mozilla signing required for permanent installation; this release does not attach an unsigned XPI. The optional Windows native helper is unchanged and does not need to be reinstalled for this password-prompt fix.
