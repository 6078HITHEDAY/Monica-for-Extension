# Bitwarden 源密码 Passkey 保留进度（2026-10-09）

本批完成原生副本计划、复制事务、插件加密库恢复日志与生产客户端准备适配器。**尚未开放含源 Passkey 的项目成员删除**：本地引用迁移、删除前的副本持续核验和完整协调器/运行时接入仍待完成。完整 Android 互通目标继续进行。

当前扩展版本为 0.1.37，HEAD `18dd08d79a5ac454cac5512f85e0dbf55141e395`，修改未提交；未发布、推送、打标签或修改 Android 产品代码。用户已确认 GitHub 的既有 Bitwarden Passkey 登录成功，按钮和自动填充响应正常，这项实机确认继续保留。

## 已实现

- 为源 Cipher 的每个原生 FIDO2 凭据生成一个独立登录 Cipher。保留同账户/组织的加密域与原有包装密钥，不改写凭据 ID、私钥、用户句柄或计数。零计数和正计数均按原值保留。
- 原生 FIDO2 未知字段、密文、JSON 大整数、小数表示与特殊键保留；保留原备注及名称、用户名、URI 上下文。副本不携带原密码、OTP、密码历史或项目分组字段，不覆盖其他密码已有的 Passkey。
- 使用加密的 `monica.passkey-preservation.v1` 字段识别副本。复制前重新由源原生数据推导并校验保存的计划；来源或计划不一致则停止。
- 复制请求发送前先保存 attempted。`createCipherOnce` 禁止传输层重试创建；响应丢失后完整扫描已有副本。找不到未确认副本时停止重试，不把网络不确定性当成创建失败。
- 查询直接使用 `/sync` 与 `/details`，不使用同步缓存。拒绝不完整/带续页标志/冲突别名的列表、不可读候选、重复副本、已进回收站的副本和被修改的回读。创建 ACK 之后另行读取详情核验。
- `SecureVaultService` 把不可变计划、源原生摘要、本地关联凭据快照与进度保存到实际应用加密库；进度更新检查版本、来源绑定、原生快照、本地使用/编辑、冲突和请求队列。恢复计划总量限制为 8 MiB。没有增加可由网页或管理端直接提交日志的运行时命令。
- 重启使用密码库内最新的 Bitwarden 会话，刷新结果在下一次请求前保存。组织/Cipher 派生密钥使用后清零，调用方持有的密钥不被错误清除。

主要实现：

- `src/providers/bitwarden/bitwarden-passkey-preservation.ts`
- `src/providers/bitwarden/bitwarden-passkey-preservation-transaction.ts`
- `src/providers/bitwarden/bitwarden-passkey-preservation-preparation.ts`
- `src/core/bitwarden-passkey-preservation-journal.ts`
- `src/core/password-project-removal-journal.ts`
- `src/security/secure-vault-service.ts`

## 验证与边界

33 个文件、533 项相关回归通过，23.31 秒，见 `.artifacts/bw-passkey-preservation-regression-final.log`。其中 51 项专门覆盖 Passkey 原生保留及加密库准备：

- 两类凭据 ID、包装/未包装 Cipher 密钥、零/正计数、真实 ES256 私钥导入与签名验签、备注空白和未知字段。
- 加密保存失败、创建响应丢失、receipt 保存失败、重新创建服务并解锁、未确认结果不重发、重复/消失/删除/变化的副本。
- 换账户、本地使用变化、来源变化、不合法计划、过期进度、部分列表和令牌刷新。

密码库测试使用真实 `SecureVaultService` 加密/解密与重启逻辑，存储后端为 `MemoryVaultStorage`；客户端 HTTP 方法被模拟。复制引擎另有 AES-GCM 日志夹具。**这不是实际 IndexedDB、Edge 重启或真实 Bitwarden/Vaultwarden 服务验收。** 本批没有启动 Docker 或 AVD。

两套 TypeScript、生产构建、234 个图标、三张扩展页面资源检查通过，见 `.artifacts/bw-passkey-preservation-build-final.log`。安全审计通过：212 个运行时命令、24 个仅管理端项目命令，见 `.artifacts/bw-passkey-preservation-audit.txt`。`dist` 已重建为当前 0.1.37 源码；这不会启用尚未接入的准备适配器或解除源 Passkey 删除门禁。

保留失败日志：最初测试工厂裁掉备注首尾空白；修正为直接生成带空白的原生密文后验证原值。新加应用夹具缺少分组 label，已补齐。类型检查发现工厂参数不支持 OTP/history、ES2020 不支持 replaceAll，以及测试 Passkey 缺少必需字段，均已修正。首次集中回归的 9 项失败来自本地计划验证未提供校验器要求的修订时间；已使用来源时间完成本地格式校验，真实副本仍必须独立读取服务器。最终回归及构建均重新通过。

此前启动既有本地 Vaultwarden 容器被自动审批拒绝，工具只返回 `blocked by policy`。本批未重试该动作，也未把旧服务测试计为新功能通过。此前四项补偿服务用例仍未运行，见 `.artifacts/bw-project-restoration-live-status.json`。此前被拒绝的缓存/配置目录清理也未重试，不声称释放了磁盘空间。

## 下一步

1. 将已核验副本接入完整项目移除协调器，持续核验全部副本，并原子迁移本地 Passkey ID/来源引用，避免原 Cipher 墓碑删除仍需保留的凭据。
2. 处理准备或删除期间的本地使用/编辑、无法判定的创建/恢复结果，以及已提交后源密码被其他端恢复；保留恢复记录并提供明确决策。
3. 完成来源操作队列、后台重启恢复、实际 IndexedDB、管理界面和 Edge/Android 往返。UI 改动须先使用本地 M3E Canvas。
4. 继续真实 OneDrive OAuth/自动同步、待决定的 Android KDBX 分组范围、WebDAV ZIP 并发新备份窗口及完整类型/后端生命周期矩阵。

后续接入已完成一批：源 Passkey 副本进入内部完整协调器和原子引用迁移，547 项回归及真实 Edge IndexedDB 两次浏览器重启恢复通过。HTTP 仍为合成响应，不等同真实服务或 Android 验收。更新见 [引用迁移报告](bitwarden-passkey-adoption-318.md)。
