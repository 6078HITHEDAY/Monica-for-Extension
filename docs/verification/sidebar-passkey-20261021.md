# CLI 独立导航与 Passkey 验证窗口（2026-10-21）

## 变更

- 「CLI 内容管理」移至侧栏「插件」分组的独立入口，具有当前页选中状态。移除设置页内的重复入口；CLI 页隐藏扩展密码库的搜索与新增操作，使用自己的管理控件。离开页面继续销毁本机 CLI 会话。
- Passkey 主密码验证窗口复用扩展的主题偏好，支持所选配色、明暗模式、跟随系统和其他扩展窗口的实时设置变化。
- 去掉网站信息的卡片包裹和表单外框，保留直接排列的网站信息、密码标签、单个填充式输入框和底部操作。焦点使用输入底线和标签颜色强调；错误提示、密码清理和原有身份校验不变。

## 设计

使用本地 `http://127.0.0.1:5186/` M3E Canvas 制作并检查双画面草图。可编辑源文件及地址分别保存在本地 `docs/design/sidebar-passkey-20261021.m3e.json` 和 `docs/design/sidebar-passkey-20261021-url.txt`。草图与真实 Edge 截图仅留本地。

## 验证

- `npm run build` 通过，包含 TypeScript、图标检查、生产构建及扩展页面资源检查。
- `npm test -- --run src/cli/native-client.test.ts src/content/passkey-prompt.test.ts src/passkey/user-verification.test.ts src/i18n/runtime.test.ts src/commercial-acceptance.test.ts`：5 文件、59 项通过。
- 实际安装版 Edge：`MONICA_CLI_INTEROP=1 npx playwright test tests/e2e/cli-management.spec.ts tests/e2e/passkey-unlock.spec.ts`：3 项通过，约 1.5 分钟。
- CLI 流程从独立侧栏入口进入并检查选中状态，完成实际数据库新增、编辑、授权撤销、并发版本冲突和离页/切换标签锁定。
- Passkey 流程检查全部 6 套配色 × 2 种明暗模式，验证独立窗口实际按钮颜色；检查明确选择的亮色优先于系统暗色、跟随系统切换、打开期间实时修改设置，以及浏览器重启后偏好保留。
- 真实 RSA 注册与登录继续成功；错误密码保持锁定。Escape、原请求中止、导航、超时和重新锁定仍取消操作，不发生签名。320px 窗口无横向溢出，已检查实际渲染截图。
- 临时 Edge 测试配置已清理；CLI Native Messaging 注册已恢复。仅使用合成数据库和凭据，没有使用 Android 虚拟机。

CLI 本机证据位于 `%TEMP%/monica-cli-edge-Rd83nh/`，测试输出位于 `%TEMP%/monica-sidebar-passkey-20261021/edge-results/`。`native-host-evidence.json` 记录清理后的 `restored: true`。

未提交、推送或发布。
