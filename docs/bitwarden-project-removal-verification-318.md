# Bitwarden 项目移除：完整远端核验（2026-10-09）

本批补齐事务引擎的生产远端核验器；**尚未开放管理端成员移除入口，也未完成全部 Android 互通**。扩展仍为 0.1.37，工作树未提交，未发布、推送或打标签。

## 实现与边界

`BitwardenProjectRemovalVerifier` 使用真实客户端重新读取 `/sync` 和成员 `/details`，不依赖通知缓存或管理端传入的摘要：

- 检查单一来源绑定、项目身份、完整成员范围、保留草稿的已同步内容、文件夹和集合引用。另一端新建的同项目成员即使从未进入本地缓存，也会阻止继续删除；相同标题的独立密码和无关回收站记录不会误算为成员。
- 任意活跃登录记录若包含无法读取的字段、冲突/未知版本的项目元数据、缺失组织密钥或损坏结构，就无法证明完整范围，保留待处理状态。解码器新增仅供此流程启用的严格项目元数据检查，普通读取行为不变。
- 删除意图同时冻结被移除记录和保留记录的原始 Cipher 摘要，覆盖内嵌 TOTP、Passkey、未知字段及附件清单。摘要只忽略既有规则允许的修订/删除时间和短期附件下载 URL。保留摘要在加密日志中不可被重试改写。
- 在核验前后重新检查完整成员范围及原生内容；共享附件按完整分页清单检查，并实际下载两边的文件，验证原文大小和 SHA-256。网络、访问及解密的不确定性与明确内容变化分开处理，不能把读取失败当成补偿或删除成功。
- 核验、删除、恢复和回读共用刷新后的会话，避免长耗时附件操作后再次使用过期或已轮换的刷新令牌。删除和恢复仍采用不会自动重放未知结果的客户端方法。

这仍是若干独立服务器请求的核验序列，**没有 Bitwarden 服务端整组原子性或删除 CAS**。最后一次读取之后的并发窗口仍存在，不能声称已消除。

## Passkey 与 TOTP 的处理规则

Android `PasswordViewModel` 项目保存先写剩余行及共享附件，再排队删除被移除的 Cipher。`BitwardenRepository.queueCipherDelete` 操作整条 Cipher；这条保存路径没有内嵌 Passkey 搬迁。`CipherSyncProcessor.syncLoginCipher` 另行处理内嵌 Passkey，`passkeyBindings` 本身不是私钥。

TOTP 属于凭据组：同组多条密码共享 OTP，不同组可使用不同 OTP。它不是整个项目统一覆盖的共享字段。此批核验不移动/替换 OTP；源 Cipher 回收站保留源组 HOTP，存活组保留自己的 TOTP。

保留记录已有的 Passkey 由完整 Cipher 摘要保护；真实测试重新导入回读私钥后签名、验签通过。待移除源记录若含内嵌或历史标记 Passkey，则准备阶段明确停止，原始 Cipher 和凭据保留。**这个门禁不是 Passkey 搬迁完成，也不代表含 Passkey 的移除已支持。**没有改动既有凭据 ID、私钥或 Android 零计数签名设计。

## 实际发现的问题

1. 首批扩充样例给同一个凭据组的不同密码设置了不同 OTP，被现有保存层正确拒绝；改为两个凭据组，同组 OTP 一致。这是验收数据修正，不是放宽产品规则。
2. 第一个真正到达生产附件核验的场景失败：Bitwarden 列表的 `sizeBytes` 是密文信封长度，不能等于明文证明中的文件大小。现在此后端通过认证下载的实际原文大小和摘要判断，仍比较两次来源附件清单；其他后端原有大小比较不变。新增相同密文长度下明文长度/内容被替换的回归。
3. 初期失败运行耗尽了隔离 Vaultwarden 的登录突发配额（HTTP 429）。只重启本任务拥有的合成测试容器一次，保留持久卷和所有账号，再集中运行验收；没有修改服务器限流策略，也没有触及用户账号。

失败日志及目录均保留在 `.artifacts/bw-project-verification-*`、`.tmp/bw-project-verification-318/`。

## 验收

- 核验、附件、加密日志及解码器定向测试：4 文件、93 项通过。
- 相关 Bitwarden 和项目删除回归：29 文件、397 项通过，26.36 秒；日志 `.artifacts/bw-project-verification-regression.log`。
- 真实 Vaultwarden 1.37.3：9 项全部通过，总运行 24.39 秒；日志 `.artifacts/bw-project-verification-live-final.log`。
- 共享刷新会话的最终定向测试：2 文件、39 项通过，`.artifacts/bw-project-verification-session-tests.log`；真实删除响应丢失和保留 Passkey 复验 2 项通过，`.artifacts/bw-project-verification-shared-session-live.log`。令牌轮换注入属于单元测试，真实服务复验未主动使令牌过期。
- 两套 TypeScript、生产构建、234 字体图标及本地页面资源检查通过，`.artifacts/bw-project-verification-build.log`。运行时审计通过：212 个命令、24 个仅管理端项目命令。当前 `dist` 已更新，版本仍为 0.1.37。

集中验收目录均位于 `.tmp/bw-project-verification-318/`：

| 场景 | 目录 | 结果 |
| --- | --- | --- |
| 两个来源删除、共享附件及两个组的 OTP 保留 | `complete-82Pog7` | committed |
| 删除响应丢失、加密库重启 | `delete-loss-YSjlrd` | committed，无重复删除 |
| 来源密码并发变化 | `concurrent-source-x5Yqgn` | restored，保留最新密码 |
| 保留成员备注并发变化 | `concurrent-target-uBPIfq` | restored，保留最新备注 |
| 删除窗口增加来源附件 | `attachment-window-6Xy6Zt` | restored，保留新附件 |
| 补偿恢复响应丢失、加密库重启 | `restore-loss-gKKShN` | restored，无重复恢复 |
| 删除窗口新建同项目成员 | `new-member-WZ2N7W` | restored，4 条记录保留 |
| 保留成员含实际 ES256 Passkey | `retained-credentials-Kh7DIU` | 回读密钥签名/验签通过，ID/密钥/零计数一致 |
| 被移除源含实际 Passkey | `source-passkey-80qLvF` | 准备阶段停止，全部源仍存活，ID/密钥/零计数一致 |

这些场景调用真实加密、HTTP、附件下载和事务日志；新 provider 回读仍使用同一合成会话，不宣称独立重新登录、Android 系统 Credential Manager 或网页 RP 验收。本批未启动 Android 虚拟机、未修改 Android 产品代码。

最终共用会话复验目录为 `delete-loss-LzDszM`、`retained-credentials-9MLqze`。本任务启动的测试容器与 Docker 已停止，持久卷和失败证据保留；未重试此前被拒绝的缓存/配置目录清理。源码、`dist` 与证据摘要记录在 `.artifacts/bw-project-verification-manifest.json`。

## 后续必需工作

1. 接入持有来源操作队列的完整准备协调器，将剩余成员同步、幂等附件复制、当前绑定检查和上述核验组合起来。原始 Bitwarden 附件列表仍表示密文大小，准备复制适配必须提供真实原文大小，不能直接套用通用准备器。
2. 完成被移除源内嵌 Passkey 的持久保留流程及关联子项的一致性处理；保持凭据 ID、密钥和既有计数策略。
3. 把权威远端记录、本地登录/OTP/Passkey 投影、源封装和队列清理放在同一次加密保存；补偿后进入取消/重新审阅，结果不明的再次恢复需要明确决策。
4. 接入运行时自动恢复和 UI，再通过本地 M3E Canvas 更新设计并进行实际 Edge/Android 验收。普通同步门禁和当前 UI 禁用仍保留。

完整互通目标继续进行。真实 OneDrive OAuth/账号验收、Android KDBX 分组修复授权、其余后端与类型的实际往返矩阵仍是独立未完成项。
