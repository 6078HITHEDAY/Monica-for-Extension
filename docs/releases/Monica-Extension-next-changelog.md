# Monica Extension 下一版 / Next release

> 未发布 / Unreleased；版本号待定 / Version pending

## 中文

- 更新 Vite、Vitest、Undici 与字体构建 Brotli 依赖，修复已知依赖漏洞。
- 首次使用可打开独立 MDBX、完整 MDBX ZIP 备份和 KeePass KDBX；MDBX 在独立工作副本上升级，原文件保留。插件保护与数据库解锁分别设置。注册期间取消、日志写入失败或锁定时保留已接入副本，解锁后核验归属再重试。
- 登录项附带的动态验证码同时显示在“动态验证码”；没有显式网址且标题为有效主机名的登录项参与网站匹配，已有网址规则及禁止匹配规则仍优先。
- Bitwarden 密码与 SSO 登录兼容新版嵌套密钥响应，按服务端原始盐值和 KDF 解密；无效参数或密钥校验失败仍拒绝连接。Bitwarden 登录、发送邮件验证码及首次数据库导入前检查页面与后台构建是否一致。
- 修复 Bitwarden 新设备邮件验证与两步验证接续时丢失验证码的问题；两种验证按任意顺序出现均保留当前登录所需状态。验证码被拒绝后保留所选验证方式并明确提示，更换主密码、账号或服务器及关闭弹窗会清除旧验证码。此修复通过合成服务和实际 Edge 回归，反馈账号的官方云端登录仍待确认。
- 合入社区贡献：修复 Vivaldi 工具栏弹窗尺寸，MDBX 批量移动按目标分组复用冲突扫描，并支持通过 OneDrive 连接与增量同步 MDBX 数据库。OneDrive 上传后核对实际内容，锁库或取消登录会中止请求；真实云账号互通仍需验证。
- 修复旧版遗留本地只读导入项目无法删除的问题：可移入回收站、恢复或确认清空，原始内容保留到永久删除；远端未知类型继续由原密码源管理。新 Bitwarden 明文 JSON 导入仍转换为本地可编辑项目。
- Windows Hello 不可用时提示检查 Windows 本机通行密钥保存设置，并提供公开 HRESULT、WebAuthn 错误名及 API 版本。保留本机平台验证器和强制用户验证；创建与验证请求使用 JSON 序列化并增加回归检查。尚未在反馈设备验证设置开启后的原平台参数。
- 修复首次 Bitwarden 登录各次请求生成不同设备标识，导致新设备验证码无法通过的问题；登录、邮件验证与 SSO 共用持久化设备标识，保留已连接账号原有标识。
- Bitwarden 登录增加美国、欧洲和自托管服务器选择，保留自托管地址草稿；更换服务器或邮箱后清除上一次验证状态，请求期间锁定这两项输入。
- 本地同步增加实际网络接口的定向广播发现，改善电脑连接手机热点后无法通过组播查找设备的情况；保留原有设备身份验证与加密传输。
- 改进 Bitwarden 登录失败提示：兼容自部署服务省略句号的密码错误响应，区分新设备验证码错误及已知客户端兼容拒绝，避免所有情况仅显示 HTTP 400。新设备验证同时识别标准错误描述；错误提示不回显凭据或任意服务端正文。

## English

- Updated Vite, Vitest, Undici and the Brotli font-build dependency to address known dependency vulnerabilities.
- First run can open standalone MDBX files, complete MDBX ZIP backups and KeePass KDBX databases. MDBX upgrades use independent working copies and preserve source files; extension protection and database unlock remain separate. Cancellation, journal failures and locks during registration preserve attached working copies until ownership can be checked and retried.
- Login-attached OTPs also appear under authenticators. A valid hostname title can match websites when no explicit URL exists; explicit URLs and never-match rules retain priority.
- Bitwarden password and SSO login accept newer nested unlock metadata, using the exact server salt and KDF while rejecting invalid parameters or failed key authentication. Bitwarden login, email-code sending and first-run database import check that the page and background build agree.
- Fixed lost verification state when Bitwarden new-device email verification and two-step verification occur in either order. Rejected codes retain the selected verification method and show an explicit error. Changing the password, account or server, or closing the dialog clears previous codes. Synthetic service and actual Edge regressions pass; the reporting account's official-cloud login remains unconfirmed.
- Integrated community fixes for Vivaldi toolbar popup sizing and per-collection MDBX move conflict scans, plus OneDrive connection and incremental synchronization for MDBX databases. Uploads verify stored content, and locking or cancelling login aborts requests. Real cloud-account interoperability remains unverified.
- Old local readonly imports can now be moved to trash, restored, and explicitly purged, preserving their original payload until permanent deletion. Unknown remote records remain managed by their source. New plaintext Bitwarden JSON imports continue to become editable local items.
- Unavailable Windows Hello errors explain the Windows setting for saving passkeys on this device and include public HRESULT, WebAuthn error name and API version diagnostics. The local platform authenticator and required user verification remain enforced. Creation and assertion client data use JSON serialization with regression tests. The original platform parameters with the setting enabled still need testing on the reporting device.
- Fixed changing device identifiers between initial Bitwarden login requests, which could prevent new-device code verification. Login, email verification and SSO reuse a persistent installation identifier while preserving existing connected-account identifiers.
- Added US, EU and self-hosted Bitwarden server choices, retaining custom-address drafts. Changing the server or email clears previous verification state, and both fields are disabled while requests are pending.
- Native LAN synchronization also probes directed broadcasts from actual local interfaces, helping discover devices when connected to a phone hotspot that filters multicast. Device authentication and encrypted transport remain required.
- Improved Bitwarden sign-in errors: recognize self-hosted invalid-password messages without a final period, distinguish invalid new-device codes and known client compatibility rejections, and recognize device challenges from the standard error description. Errors do not echo credentials or arbitrary server response text.
