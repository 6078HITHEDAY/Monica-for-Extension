# Monica Extension 下一版 / Next release

> 未发布 / Unreleased；版本号待定 / Version pending

## 中文

- 修复首次 Bitwarden 登录各次请求生成不同设备标识，导致新设备验证码无法通过的问题；登录、邮件验证与 SSO 共用持久化设备标识，保留已连接账号原有标识。
- Bitwarden 登录增加美国、欧洲和自托管服务器选择，保留自托管地址草稿；更换服务器或邮箱后清除上一次验证状态，请求期间锁定这两项输入。
- 本地同步增加实际网络接口的定向广播发现，改善电脑连接手机热点后无法通过组播查找设备的情况；保留原有设备身份验证与加密传输。
- 改进 Bitwarden 登录失败提示：兼容自部署服务省略句号的密码错误响应，区分新设备验证码错误及已知客户端兼容拒绝，避免所有情况仅显示 HTTP 400。新设备验证同时识别标准错误描述；错误提示不回显凭据或任意服务端正文。

## English

- Fixed changing device identifiers between initial Bitwarden login requests, which could prevent new-device code verification. Login, email verification and SSO reuse a persistent installation identifier while preserving existing connected-account identifiers.
- Added US, EU and self-hosted Bitwarden server choices, retaining custom-address drafts. Changing the server or email clears previous verification state, and both fields are disabled while requests are pending.
- Native LAN synchronization also probes directed broadcasts from actual local interfaces, helping discover devices when connected to a phone hotspot that filters multicast. Device authentication and encrypted transport remain required.
- Improved Bitwarden sign-in errors: recognize self-hosted invalid-password messages without a final period, distinguish invalid new-device codes and known client compatibility rejections, and recognize device challenges from the standard error description. Errors do not echo credentials or arbitrary server response text.
