# 附近同步增量发送与历史删除确认验证

日期：2026-10-20。开发版本保持 0.1.48。本次修改尚未提交或推送。

## 结论与事故复现

已用两个隔离 Edge 密码库及真实 Native Messaging / Noise 传输复现同类误删：先同步一个正确 TOTP；发送端改成错误密钥、删除并清空，模拟旧构建没有保留编号；重新开启「只同步新增和修改」再同步。修复前，接收端正确密钥仍为 `JBSWY3DPEHPK3PXP`，但 `deleted` 从预期的 `false` 变成 `true`。全部数据为测试合成数据。

已证实的代码机制：漏扫已绑定项目会使共享引擎合成 tombstone；导出包含副本历史 tombstone。原开关只替换当前能识别的删除项目，无法覆盖已经丢失编号或此前生成的删除记录。

用户确认使用本地库，但不确定清空回收站发生时间。因此，这一机制已复现，用户手机事故具体属于旧版清空、已有 tombstone 还是其他扫描漏项，仍无法根据现有证据唯一判定。没有读取用户真实密码库或密钥。

## 最终行为

- 默认开启「只同步新增和修改」。保留原有本地回收站、保留编号、附件与接收采纳逻辑。
- 扩展原生助手在导出边界检查完整待发送副本。默认过滤删除记录、指向它们的别名及其独占附件引用，仅重封装发送副本，不修改本地副本内容、时钟、绑定或共享 Rust 引擎。
- 若发现历史删除，准备阶段进入待确认状态。弹窗显示数量、目标设备和影响，提供「跳过删除，继续同步」「本次包含删除」「取消同步」。选择前不连接或发送。
- 「包含」只影响本次发送，不关闭设置开关；后续同步仍重新检查和询问。同步结果会明确显示这次包含了多少条历史删除。
- Passkey 确认与删除确认相互独立；任一未完成均不能发送。修改源数据、锁定、取消或失效确认不能绕过保护。
- 旧助手不支持导出策略或未返回策略确认时，停止发送并提示更新本机通信组件。仅重载扩展不足以启用新保护。
- 对端的删除仍按原接收方向处理；此开关控制本机发送，不用于恢复已经被对端删除的数据。

## 验证记录

所有浏览器验收使用 Windows 已安装 Edge 155.0.4283.62。未启动、连接或使用 Android 虚拟机。

| 验证 | 实际结果 |
| --- | --- |
| `npx vitest run --maxWorkers=4 --testTimeout=30000` | 323 文件、4152 测试通过（随后增加三个确认边界用例，另以定向测试验证） |
| `npx vitest run src/nearby/local-coordinator.test.ts src/background/nearby-owner.test.ts src/i18n/runtime.test.ts --maxWorkers=4 --testTimeout=30000` | 最后定向运行 3 文件、112 测试通过，含新增边界用例及语言键一致性 |
| `cargo test --locked --manifest-path native/mdbx2-host/Cargo.toml` | 113 通过，0 失败；包含过滤、原副本不变、别名链、附件引用、错误密钥拒绝及 JSON 精度验证 |
| `cargo clippy --locked --manifest-path native/mdbx2-host/Cargo.toml --all-targets -- -D warnings` | 通过 |
| `npm run build:mdbx2-host:debug` 及 release 构建 | 通过；真实 Edge 传输使用本次 debug 构建 |
| `npm run build:mdbx2-browser` | 固定 Rust 1.97.0 / Emscripten 4.0.18 构建通过，重建源码库存对应产物 |
| `npm run build` | 完整通过，含 TypeScript、原生组件打包、浏览器 MDBX 库存校验及全部页面资源检查；保留既有大 chunk 提示 |
| `node scripts/verify-mdbx2-host.mjs` | 来源与 overlay 校验通过，共享引擎未修改 |
| `git diff --check` | 通过 |

Edge 两个套件共 10 个不同场景均已验证通过：新增四个真实传输场景（当前保留编号、旧版清空、历史 tombstone、明确包含删除），原有配对与收发恢复、300 项分页恢复，以及真实管理页中的助手缺失提示和弹窗三个选项。

完整首轮 6 通过、4 失败：旧分页用例固定假设 A 监听，另三个弹窗用例在窄屏点击了隐藏的桌面导航按钮。测试调整为按真实设备 ID 选择监听方、从桌面导航进入后缩窄至 420px；四个失败场景补跑全部通过。另对 420px 弹窗等待原生动画完成后截图检查，文字与三个按钮完整可见。弹窗 UI 用例使用合成管理端口响应，真实传输语义由独立的双 Edge / 原生助手用例验证。

原始日志与测试证据保留在用户临时目录：`monica-nearby-before-fix`、`monica-nearby-after-fix`、`monica-nearby-final-edge`、`monica-nearby-final-rerun`、`monica-nearby-dialog-final` 及对应 `.txt`。测试临时 Edge 注册已恢复，测试浏览器已关闭。

## 使用与剩余验证

`dist` 已由标准 `npm run build` 更新，设置页所用 Windows Wi-Fi 安装组件包含本次 release 原生助手。没有替换用户已安装助手、永久修改浏览器注册或触碰签名私钥；测试使用的临时 Edge 注册已恢复。实际使用需重新加载扩展，并通过 Wi-Fi 设置更新本机通信组件；旧助手会停止发送并提示更新。

2026-10-21 续验：用户明确释放公共 AVD 后，修正连接角色的普通版真实 JNI/Noise/数据库互通已通过。扩展与 Android 合成库完成 450 条新增密码和 19 轮内容交换；手机正确 TOTP 在插件改坏密钥并清空回收站后保持活动，历史删除的未选择阻断、取消、跳过、明确包含均已验证。另发现并修复扩展 MDBX 接收恢复时错误提前确认采纳的问题，详见 [同步压力验证](nearby-sync-stress-20261021.md)。实体手机、用户手机回收站恢复与真实账户数据仍未验收。手机端如需恢复，应从手机自身回收站恢复正确验证器，避免从含错误密钥的扩展回灌。

本地 Canvas JSON、分享链接和截图保留于 `docs/design/nearby-delete-review*`，未提交；此文档不嵌入这些本地图片。Android 与共享 vendored Rust 源码未修改。
