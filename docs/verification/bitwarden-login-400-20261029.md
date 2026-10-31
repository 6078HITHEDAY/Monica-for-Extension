# Bitwarden 登录 HTTP 400 排查（2026-10-29）

## 中文

用户报告最新版扩展连接官方 bitwarden.com 返回 HTTP 400，同账号可以登录官方网页。所提供的请求头确认请求经过本机代理，且发送了 `Bitwarden-Client-Version: 2026.7.0`，但没有响应正文，因此尚未确定该次拒绝的原因。HTTP 400 与连接超时应分别判断。

使用合成账号，在实际 Microsoft Edge 156（无界面模式）与本机自部署 Vaultwarden 1.37.3 中验证。服务使用公开 Alpine AMD64 镜像中的静态二进制，下载层均校验 SHA-256；仅监听回环地址，使用独立测试数据目录，没有使用用户账号。

实测发现 Vaultwarden 的密码错误消息是 `Username or password is incorrect. Try again`，没有官方文本末尾的句号。原先严格匹配导致其被显示为通用 HTTP 400，现兼容两种文案。补充识别新设备验证的 `error_description`、新设备验证码无效、客户端版本拒绝、版本头缺失及设备信息缺失；使用固定提示，不回显任意响应文本或凭据。登录参数、密码派生、服务器版本头及密文格式保持现有协议。

验证结果：

- 87 项针对登录、传输与离线语言目录的测试通过；新增 8 项登录回归。
- 扩展完整构建通过，包括类型检查与打包资产验证。
- Edge 中错误密码收到 HTTP 400 并显示明确提示；正确密码（含首尾空格）收到 HTTP 200，连接成功。
- 使用实际 UI 同步，条目正常显示并解密，刷新后仍可读取。
- 独立服务端读取确认原条目密文未变化；未发现页面脚本错误。

实测脚本与原始证据保留在工作区 `.codex-tmp/cloud-errors-323/`，截图仅在本地。自部署测试不能证明官方服务上的这次 HTTP 400 已解决，也未覆盖官方 CAPTCHA、账户策略与邮件验证的真实账号流程。

## English

The reported official bitwarden.com login returns HTTP 400 while the same account works on the official website. Request headers confirm a local proxy and client version 2026.7.0; the response body was unavailable, so the specific rejection remains unconfirmed.

Actual Microsoft Edge 156, running headlessly, was tested against an isolated local Vaultwarden 1.37.3 service using synthetic credentials. The static binary came from SHA-256-verified public OCI image layers. No user account or data was used.

Vaultwarden's invalid-password message omits the official message's final period, causing the previous exact match to fall back to a generic HTTP 400. Both forms now produce an actionable message. Known device verification and client compatibility errors also use fixed safe messages, without echoing arbitrary response text or credentials.

All 87 focused tests and the complete extension build passed. Real Edge UI login, sync, decryption and reload passed; incorrect credentials produced HTTP 400 and correct credentials produced HTTP 200. Independent server readback confirmed unchanged original ciphertext. This does not establish the cause or resolution of the user's official-cloud rejection.
