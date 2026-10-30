# 浏览器插件安全审查 — 2026-10-10

本轮针对 Monica 浏览器插件的密码库保护、自动填充、Passkey、同步凭据、诊断及供应链进行了代码审查和可复现测试。发现并修复设备密钥隔离与诊断泄露问题，同时缩短明文字节缓冲区存活时间、更新存在已知漏洞的开发依赖。

这不是独立第三方审计或“绝对安全”认证，也不代表完成 Android 应用的全面安全审查。本轮未修改 Android 产品代码、用户 Chrome 配置或真实密码库，未对真实用户账户执行攻击测试。验收仅使用合成密码库和隔离的已安装 Edge。当前开发版本仍为 0.1.37；更新本地 `dist`，未发布新版本。

## 已复现并修复的问题

### 设备密钥对内容脚本暴露

旧实现把设备密钥以原始 Base64 值保存在 `chrome.storage.local`，而这一存储默认允许扩展的内容脚本访问。通过实际 Edge 的 CDP 在扩展隔离世界中执行测试，确认旧代码可以读取该密钥；同次测试中 session 访问与完整密码库命令均被拒绝。

这是受限内容脚本与可信后台之间的隔离缺口，影响设备密钥模式。没有证明普通网页 JavaScript 能直接读取该存储，也没有构造网页到受限世界的完整漏洞利用链，不能据此声称已经发生用户密码泄露。

修复位于 `src/security/vault-device-key.ts`：

- 新密钥存入扩展源的 `monica-extension-device-keys` IndexedDB；网页及内容脚本使用的源不能访问该数据库。
- 后台启动时迁移全部旧密钥，包括中断操作留下的孤立记录。
- 原始密钥按原 ID 写入，事务成功提交后才删除旧副本；不重新生成密钥，不重写原密码库密文。
- 清理重试保留已经提交的私有副本，即使旧存储副本被修改，也不会覆盖已迁移密钥。

真实浏览器验收覆盖：创建与读取设备密钥库、内容脚本不可见设备密钥及其数据库、受限 session/完整密码库访问拒绝、旧布局重启迁移、迁移后原密码仍可读，以及私有副本已提交而旧副本被篡改时的重启恢复。

兼容性限制：旧构建只认识原存储位置，不能直接读取迁移后的设备密钥库。需要回退时，应先用新版准备密码保护的备份，并确认目标版本支持恢复；不要直接在已迁移配置上降级。新位置改善扩展内部隔离，不提供抵御整个浏览器配置被窃取的主密码级保护。

复现日志：`.artifacts/security-key-isolation-red2-20261010.log`。修复验收：`.artifacts/security-review-final-edge-20261010.log`。

### 诊断错误残留密码或 token

复现两种情况：带引号的 JSON 密码、包含空格的口令和提供方特有密钥名绕过旧脱敏；解密后的损坏 maFile 被原生 `JSON.parse` 拒绝时，错误消息携带一段解密原文。

修复位于 `src/providers/provider-diagnostics.ts` 与 `src/core/lossless-json.ts`：先完整脱敏带引号的值，覆盖常见 token/secret/private-key 字段，再执行其他脱敏；无损 JSON 解析仅对语法错误返回不含原文的通用消息，保留不支持浏览器特性的原有错误。

真实 Bitwarden 提供方测试用合成损坏附件确认警告不含解密内容，同时保留数字 SteamID 精度及正常 maFile 读取回归。文本脱敏不能识别任意无标签秘密；仍不得主动把原始响应、解密数据或凭据交给日志。

复现日志：`.artifacts/security-diagnostics-red-20261010.log`。初次修复回归：`.artifacts/security-review-fixes-20261010.log`。

### 明文字节缓冲区

`src/security/vault-crypto.ts` 在加密成功或失败后清零编码的明文缓冲区；解密后在解析成功或失败路径清零字节缓冲区，解析失败不回显原文。不改变密码库格式、KDF 参数、随机 IV、密钥、Passkey ID 或刻意保留的零计数策略。

测试捕获传给 Web Crypto 的实际加密输入以及返回的解密缓冲区，验证处理后字节清零、正常状态仍可读取。JavaScript 字符串、状态对象、浏览器内部拷贝和存储硬件残留不受这一清零保证覆盖。

### 开发依赖漏洞

生产依赖初始扫描无已知告警；完整扫描发现 Vitest 4.1.10（含 `@vitest/mocker`，GHSA-82fw-gwwq-j7x9）和 jsdom 开发链中的 undici 7.29.0 存在公告。现锁定 Vitest 4.1.11、undici 7.30.0；同时解析到兼容的测试传递依赖 chai 6.3.0、tinyrainbow 3.2.0，没有生产依赖版本变更。

固定 npm 10.9.2 曾在可选 peer 解析时触发 Arborist `edgesOut` 异常。仅在临时目录使用 legacy-peer 解析生成候选 lock，检查差异后正常执行固定版本的 `npm ci --ignore-scripts` 和 `npm ls --all`，均成功；未永久改变 peer 或安装脚本策略。

最终全量 `npm audit --json`：245 个依赖条目，0 个已知漏洞告警。该结果仅反映当前公告数据库，不证明依赖没有未知漏洞。证据：`.artifacts/security-dependency-locked-install-20261010.log`、`.artifacts/security-review-peer-tree-20261010.log`、`.artifacts/security-review-final-dependencies-20261010.json`。

## 已检查的安全边界

| 边界 | 本轮证据与结论 |
| --- | --- |
| 密码库加密 | Argon2id 64 MiB、3 次迭代、32 字节盐；AES-256-GCM 认证加密；导入 KDF 和长度限制；旧数据/错误口令回归 |
| 后台授权 | 默认拒绝的消息策略；212 类运行时命令、其中 24 类项目管理命令；受限内容脚本不能读取完整密码库或可信 session |
| 自动填充 | 实际浏览器拒绝 HTTP 捕获/填充、非活动标签页填充、确认后导航以及跨源 iframe 重用顶层匹配 |
| Passkey | 检查 RP/origin、原标签页/文档绑定、用户验证与取消；原凭据、密钥、备份标记和计数语义由回归保护 |
| 同步传输 | 检查 Bitwarden/WebDAV HTTPS、拒绝重定向、响应大小与路径限制；附件先验 MAC 再解密 |
| OneDrive | 检查 PKCE/state、精确回调、令牌端点与下载域名限制；签名下载地址不携带账号 Bearer |
| 锁定 | 取消待处理敏感请求、同步与解码缓存；明确区分用户主动授权的锁定填充投影 |
| DOM 与构建产物 | 审查动态文本输出及静态模板；产物扫描未发现测试秘密、源映射或明文测试密码库 |
| Native bridge | 审查消息长度、路径与源边界，运行锁定版本/覆盖文件校验；本轮未执行完整 Rust 编译、测试或原生桥渗透测试 |
| 供应链 | 固定 Node/npm、245 项官方源 SHA-512 lock、5 份固定 SHA workflow 和 native pin 校验通过；外部 GitHub 账户/分支设置未重新认证 |

## 验收记录

- 首轮 41 文件、529 项安全测试：515 通过，14 项触及默认 5 秒超时。随后顺序复跑涉及的 3 个高开销加密状态文件，140/140 通过，没有放宽超时或断言。保留 `.artifacts/security-review-baseline-20261010.log` 和 `.artifacts/security-review-isolated-retry-20261010.log`；不把首轮失败隐藏为全绿。
- 修复后的第一轮 Edge：8/8 通过，包含设备密钥隔离/迁移、6 项网页边界场景及安全确认交互；日志 `.artifacts/security-review-edge-20261010.log`。
- 最终构建后的增强 Edge：2/2 通过，覆盖设备数据库源隔离、已提交密钥不被旧副本覆盖，以及标准 Bitwarden maFile 失败重试后生成 Steam 验证码。与前述场景有重叠，不叠加为 10 个独立案例；日志 `.artifacts/security-review-final-edge-20261010.log`。
- 最终生产构建（项目 TypeScript、图标、扩展页面引用）通过；独立 E2E TypeScript 检查通过。E2E 最初使用了未声明的 CDP `removeAllListeners`，已改为明确注册/移除该测试自己的监听器；没有类型断言绕过。
- 最终供应链与产物审计通过：`.artifacts/security-review-final-supply-chain-20261010.log`、`.artifacts/security-review-final-output-audit-20261010.log`。构建：`.artifacts/security-review-final-build-20261010.log`。
- Vitest 4.1.11 最终顺序回归：58 文件、794/794 通过（140.82 秒），覆盖安全服务、后台消息、填充策略、Passkey、诊断、Steam、无损 JSON、OneDrive 和 WebDAV；日志 `.artifacts/security-review-final-regression-20261010.log`。

## 剩余风险与使用建议

1. **当前主密码最低仍为 4 字符。** 这是现有兼容策略，并非推荐安全强度。短或可猜的密码容易被离线猜测，Argon2id 不能弥补低熵。建议使用较长、独立、随机的主密码或随机多词口令；本轮没有强制更改用户原密码。
2. **设备密钥模式依赖浏览器与系统保护。** 密钥仍在浏览器配置内；恶意软件拿到配置或控制浏览器进程时，不能认为密码库有独立主密码保护。
3. **锁定填充是明确的例外。** 用户主动授权的少量用户名/密码在单独的设备加密缓存中保留，允许锁定时填充。它不包含完整库、OTP 种子或 Passkey 私钥，但不能宣称“锁定后所有密码均不可用”。
4. **已填入网页或复制到剪贴板的秘密受目标环境约束。** 正确站点被攻陷、操作系统或浏览器被控制、恶意扩展更新等不由本轮测试排除。
5. **未完成独立审计、形式化验证或全平台渗透测试。** 没有发现经本轮验证路径可直接利用的网页到完整密码库绕过，不等于整个产品不存在未知漏洞。Android 全面对齐与其他既存任务仍未完成。

本地使用需要在浏览器扩展管理页重新加载 Monica，并刷新使用自动填充/Passkey 的页面。没有自动操作用户 Chrome。更多威胁模型见 [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md)，安全报告渠道见 [SECURITY.md](../SECURITY.md)。
