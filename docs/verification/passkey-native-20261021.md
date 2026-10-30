# Passkey 登录切换系统验证器

日期：2026-10-21。扩展版本保持 0.1.48，改动未提交或推送。

## 行为

- 登录弹窗底部提供「使用 Windows/浏览器验证器」，保留 Monica 账户选择、继续登录及原有键盘操作。创建 Passkey 弹窗不增加此按钮。
- Monica 锁定时也可直接切换，无需先打开解锁或身份验证窗口。
- 切换复用既有 `PASSKEY_DISMISS` 流程，结束后台候选请求后，通过既有 `NotSupportedError` 通道交回 MAIN 中保存的原生 `navigator.credentials.get`。使用网站原始 options，保留 RP、challenge、allowCredentials、transports、UV 和 AbortSignal。
- 普通取消继续返回 NotAllowedError，网站中止继续返回 AbortError，不触发系统登录。交接期间收到中止时优先保留中止原因。后台已有提交结果时沿用现有完成回执，不额外发起系统请求。
- 系统入口仅接受可信用户操作；操作中禁用按钮，防止重复提交。七种非中文语言已补齐入口和说明翻译。

## 验证结果

- `npx vitest run src/content/passkey-prompt.test.ts src/passkey/interception-policy.test.ts src/i18n/runtime.test.ts --maxWorkers=2 --testTimeout=30000`：3 个文件、44 项测试通过。
- `npm run check`：通过。
- `npm run build`：通过；已更新用户加载的 dist，包含标准资源、页面及本机助手库存验证。
- `npx playwright test tests/e2e/passkey-native.spec.ts tests/e2e/passkey.spec.ts tests/e2e/passkey-unlock.spec.ts`：已安装 Microsoft Edge 中 11 项通过，耗时 2.1 分钟。
- 新增两项 Edge 场景分别覆盖锁定／未锁定。使用 CDP 虚拟 WebAuthn 验证器完成真正的浏览器原生认证，核对一次原生断言事件、一次交接、凭据 ID、clientData challenge／origin、必需 UV 标志以及签名有效性。Monica 的 useCount、signCount 和 lastUsedAt 不变；锁定状态保持。
- 两项新场景均验证取消弹窗、交接前 abort、交接后通过原始 signal abort；取消和中止不产生额外原生断言。原有 ES256／RSA 创建和登录、Bitwarden 凭据、锁定／导航／超时取消及提交一致性回归均通过。
- `git diff --check`：通过。

## 界面与限制

本地 M3E Canvas 使用独立项目 `extension-passkey-native-20261021`。可编辑 JSON、分享链接、草图预览和实际 Edge 截图保留在本地 `docs/design/passkey-native*`，不纳入提交。已检查实际登录弹窗和锁定弹窗渲染。

系统验证器可提供 Windows Hello、手机扫码和安全密钥等方式，具体选项由 Edge、Windows、网站参数及设备能力决定。测试使用虚拟 WebAuthn 验证器，不代表实体 Windows Hello、生物识别、实体安全密钥或手机扫描系统二维码已实测。

本轮未使用 Android 公共虚拟机。Android 附近同步互通的待测状态仍见 `android321-extension-20261021.md`，需等用户明确释放虚拟机后再继续。
