# Monica for Extension 1.0.103

2026-10-31 · 标签 / Tag: `v1.0.103` · Windows x64 可选助手 / Optional helper: `0.1.5`

## 中文

- 首次使用可直接打开独立 MDBX、完整 MDBX ZIP 备份和 KeePass KDBX。MDBX 在独立工作副本上升级，保留原文件；扩展保护与数据库解锁分别设置。注册期间取消、锁定或日志写入失败时保留已接入副本，解锁后核验归属再重试。
- 修复 Bitwarden 首次登录各次请求使用不同设备标识，以及新设备邮件验证与两步验证接续时丢失验证码的问题。登录、邮件验证与 SSO 共用持久化设备标识，保留已连接账号原有标识；两种验证按任意顺序出现均保留当前登录状态。拒绝验证码后保留所选验证方式并明确提示，更换密码、账号、服务器或关闭弹窗会清除旧验证码。
- Bitwarden 登录增加美国、欧洲和自托管服务器选择，保留自托管地址草稿，请求期间锁定邮箱和服务器输入。密码与 SSO 登录兼容新版嵌套密钥响应，按服务端原始盐值和 KDF 解密，无效参数或密钥校验失败仍拒绝连接。改进密码错误、新设备验证码错误及已知客户端兼容拒绝提示；不回显凭据或任意服务端正文。登录、发送邮件验证码及首次数据库导入前检查页面与后台构建是否一致。
- 登录项附带的动态验证码同时显示在“动态验证码”。没有显式网址且标题为有效主机名的登录项参与网站匹配，已有网址及禁止匹配规则仍优先。
- 合入社区贡献：修复 Vivaldi 工具栏弹窗尺寸，MDBX 批量移动按目标分组复用冲突扫描，新增通过 OneDrive 连接与增量同步 MDBX。上传后核对实际内容，锁库或取消登录会中止请求。
- 修复旧版遗留本地只读导入项目无法删除的问题，支持移入回收站、恢复及确认清空；原始内容保留到永久删除。远端未知类型继续由原密码源管理，新 Bitwarden 明文 JSON 导入仍转换为本地可编辑项目。
- 本地同步增加实际网络接口的定向广播发现，改善电脑连接手机热点后无法通过组播发现设备的情况，保留设备身份验证与加密传输。此改动包含在可选 Windows 本机助手 0.1.5 中。
- Windows Hello 不可用时提示检查 Windows 本机通行密钥保存设置，提供公开 HRESULT、WebAuthn 错误名及 API 版本。创建与验证请求改用 JSON 序列化，保留本机平台验证器和强制用户验证。
- 更新 Vite、Vitest、Undici 和字体构建 Brotli 依赖，修复已知依赖漏洞。

安装或升级：下载 `monica-extension-1.0.103.zip`，解压至固定目录，在 Chrome/Edge 扩展管理页开启开发者模式并加载该目录。升级时保留原目录和扩展 ID，覆盖文件后重新加载扩展，再刷新已打开的网页，无需卸载扩展或重新导入密码库。

普通 MDBX 新建、导入、读取、编辑和保存使用扩展内置 WASM，无需外部组件。Wi-Fi 同步及部分本机能力使用**可选** Windows x64 助手 `monica-mdbx2-host-windows-x64-0.1.5.zip`；使用这些能力的用户可更新助手，安装方法见包内 README。旧 Native Host 工作副本保留原后端，迁移需明确操作。每个 ZIP 均附带 SHA-256 校验文件。

支持 Chrome/Edge 128+。Firefox 独立未签名构建保留在 CI artifact，永久安装需 Mozilla 签名，见 [Firefox 说明](../FIREFOX.md)，本次公开附件不含未签名 XPI。Bitwarden 合成服务及实际 Edge 回归已通过，反馈账号的官方云端登录、原 Windows Hello 故障设备和真实 OneDrive 账号互通仍待确认。验证范围见[发布检查记录](../verification/release-1.0.103.md)。

## English

- First run can open standalone MDBX files, complete MDBX ZIP backups and KeePass KDBX databases. MDBX upgrades use independent working copies and preserve source files; extension protection and database unlock remain separate. Cancellation, locks and journal failures during registration preserve attached copies until ownership can be checked and retried after unlock.
- Fixed changing device identifiers across initial Bitwarden requests and lost verification state when new-device email verification and two-step verification occur in either order. Login, email verification and SSO reuse a persistent installation identifier while preserving existing connected-account identifiers. Rejected codes retain the selected method and show an explicit error; changing the password, account or server, or closing the dialog clears previous codes.
- Added US, EU and self-hosted Bitwarden server choices, retaining custom-address drafts and disabling email/server inputs during requests. Password and SSO login accept newer nested unlock metadata, using the exact server salt and KDF while rejecting invalid parameters or failed key authentication. Improved invalid-password, new-device-code and known client-compatibility errors without echoing credentials or arbitrary server responses. Login, email-code sending and first-run database import check that the page and background build agree.
- Login-attached OTPs also appear under authenticators. A valid hostname title can match websites when no explicit URL exists; explicit URLs and never-match rules retain priority.
- Integrated community fixes for Vivaldi toolbar popup sizing and per-collection MDBX move conflict scans, plus OneDrive connection and incremental synchronization for MDBX. Uploads verify stored content, and locking or cancelling login aborts requests.
- Old local readonly imports can now be moved to trash, restored and explicitly purged, preserving their original payload until permanent deletion. Unknown remote records remain managed by their source; new plaintext Bitwarden JSON imports continue to become editable local items.
- Native LAN synchronization probes directed broadcasts from actual local interfaces, helping discover devices when connected to phone hotspots that filter multicast. Device authentication and encrypted transport remain required. This change is included in the optional Windows helper 0.1.5.
- Unavailable Windows Hello errors explain the Windows setting for saving passkeys on this device and include public HRESULT, WebAuthn error name and API version diagnostics. Creation and assertion client data use JSON serialization; the local platform authenticator and required user verification remain enforced.
- Updated Vite, Vitest, Undici and the Brotli font-build dependency to address known dependency vulnerabilities.

Install or upgrade: extract `monica-extension-1.0.103.zip` to a permanent directory and load it in Chrome/Edge developer mode. To upgrade, keep the existing directory and extension ID, replace its files, reload the extension and refresh open websites. Uninstalling or reimporting the vault is unnecessary.

Ordinary MDBX creation, import, reads, edits and saves use bundled WASM and need no external component. Wi-Fi sync and some native abilities use the **optional** Windows x64 helper `monica-mdbx2-host-windows-x64-0.1.5.zip`; users of these abilities can update it using the README inside the package. Existing Native Host working copies retain their backend until explicitly migrated. Each ZIP includes a SHA-256 sidecar.

Chrome/Edge 128+ are supported. The separate unsigned Firefox build remains a CI artifact; permanent installation requires Mozilla signing. See [Firefox instructions](../FIREFOX.md); this release does not attach an unsigned XPI. Synthetic Bitwarden service and actual Edge regressions pass, while the reporting official-cloud account, original Windows Hello device and real OneDrive-account interoperability still need confirmation. See [release verification](../verification/release-1.0.103.md) for the tested scope.
