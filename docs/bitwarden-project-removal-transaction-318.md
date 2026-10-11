# Bitwarden 项目成员移除：分步事务与补偿恢复

2026-10-09，扩展 `0.1.37` 当前工作树。**这是内部事务层的实施和真实服务验收，成员移除界面尚未开放，完整功能仍在进行中。**

## 已实现

上一轮真实服务确认删除接口忽略版本条件，详见 [回收站恢复](bitwarden-trash-recovery-318.md)。本次增加专用的逐项删除和补偿恢复流程，每次发送删除或恢复前先把意图写入 Monica 的加密密码库。

- `BitwardenProjectDeletionJournal` 记录不可变的成员/Cipher 对应、原生快照摘要、递增修订、删除和恢复阶段。它位于既有加密项目移除记录中；损坏、未来版本、跨源身份、重复成员和非法倒退会被拒绝。
- `SecureVaultService` 在本地移除准备与日志首次写入间保持同一加密提交；后续每一步检查源绑定、当前项目、删除队列、冲突和预期日志修订。普通同步和通用完成方法继续拒绝执行待处理项目删除。
- `BitwardenProjectRemovalTransaction` 先验证原始记录和保留内容，再逐项删除并回读。快照摘要保留所有原生字段、未知字段和附件身份，只排除服务器修订/删除时间以及会过期的附件下载 URL。
- 删除结果未知时不重发。实际源内容变化、保留内容变化或源已在另一端恢复时，流程先持久切换到恢复阶段，再恢复已处理成员。恢复只调用服务器 restore，不把旧密码快照 PUT 回去，因此并发产生的新密码和新附件仍保留。
- 恢复响应丢失后先读取结果。如果远端仍在回收站，保留待处理日志并停止重复恢复，因为它也可能是在成功恢复后又被其他设备删除。缺失/不可访问的原始 Cipher 同样保持未完成，不伪造成功。
- HTTP 适配器复用现有客户端；新增 `restoreCipherOnce` 不自动重试未知结果。生产协调器仍必须在整个事务期间持有密码源操作队列，并提供完整的项目/附件验证。

日志的 `committed` 仅表示已经验证这一串逐项远端操作；`restored` 仅表示已处理成员的补偿恢复完成。父操作继续处于待处理状态，直到最终本地采用/取消流程接入。这不构成 Bitwarden 服务器整组原子事务。

## 实际发现并修复的前置问题

最初 6 个真实场景都在准备校验失败。独立比较实际期望值和回读值发现，唯一差异是 `createdAt`：早期创建确认保留本地创建时间，随后成员更新回读采用了 Bitwarden 服务器分配的时间。这不是“首条成员的时间覆盖其他成员”；工作中曾有这一初步判断，现已纠正。

准备校验现在仅在单个 Bitwarden 外部来源时，把这一服务器时间确认排除出内容冲突判断；最终准备快照使用实际回读时间。密码、自定义字段、组成员、源身份和其他后端的创建时间检查保持严格。新增 Bitwarden/MDBX2/WebDAV 对照测试，并验证真正的密码变化仍拒绝。

## 验收证据

- 首轮内部测试：2 文件、54 项通过，`.artifacts/bw-project-transaction-first.log`。
- 最终相关回归：31 文件、444 项通过，`.artifacts/bw-project-transaction-regression.log`。包括 15 个新事务场景、3 个创建时间来源对照，以及恢复请求不重试的客户端用例。
- 真实 Vaultwarden 1.37.3 HTTP：6 项通过，总运行 12.85 秒，测试耗时 10.16 秒。`.artifacts/bw-project-transaction-live-second.log`。
- 两套 TypeScript、生产构建、234 图标/页面资源和运行时安全审计通过。`.artifacts/bw-project-transaction-build.log`、`bw-project-transaction-runtime-audit.log`；212 个运行时命令及 24 个管理端项目命令保持限制。当前 `dist` 已更新。

实际场景在 `.tmp/bw-project-transaction-318/`：

| 场景 | 最终证据目录 | 验证结果 |
| --- | --- | --- |
| 删除两个成员，保留一个 | `complete-xhoqkE` | 远端逐项删除确认；共享字段/附件保留 |
| 删除响应丢失后加密重启 | `delete-loss-H1TPoC` | 不重复删除，继续其他成员 |
| 删除窗口并发改密 | `concurrent-source-sJTVW5` | 补偿恢复，最新密码保留 |
| 保留成员被并发修改 | `concurrent-target-GboDFM` | 恢复已处理源，目标新备注保留 |
| 删除窗口新增源附件 | `attachment-window-yr8cup` | 恢复源，原附件与新附件均在 |
| 补偿恢复响应丢失 | `restore-loss-hH3fs6` | 加密重启读取结果，不重复恢复 |

使用真实附件上传/下载服务、真实 Cipher 接口、完整加密密码库和新合成账号。检查原/目标附件的 SHA-256、精确共享字段、密码、原始 Cipher 身份及独立服务回读。没有实际 Android、Edge 界面或官方 Bitwarden 云验收。

最初失败与诊断保存在 `bw-project-transaction-live-first.log`、`bw-project-transaction-preflight.log` 及 `complete-nQso6q/preflight.synthetic.json`。类型检查还发现状态表推导和局部变量重名错误，修复后通过生产构建；没有放宽测试断言。最终哈希清单 `.artifacts/bw-project-transaction-manifest.json` 包含源码、日志、实际服务证据及当前 dist。

## 继续完成的部分

1. 接入生产端准备协调器：完整项目成员扫描、共享字段保存、分页附件复制和独立字节校验，绑定当前密码源与解锁会话；测试中的验证回调不能直接当作完整生产验证器。
2. 处理同一 Cipher 的 Passkey/TOTP 子项和源内共享凭据，确保移除密码成员不会让仍应保留的签名凭据失效；当前实际场景未包含这些子项。
3. 将远端确认与本地项目、子项、源记录和队列清理原子提交；接入补偿后的取消/重新审阅，以及确需再次恢复时的明确决策。
4. 接通重启自动恢复和来源操作队列，再更新本地 Canvas 草图、管理端状态和移除/撤销入口；实际 Edge 与 Android 往返单独验收。

Docker 复用上一轮隔离容器 `monica318-bw-trash-volume-20261009`，只监听 `127.0.0.1:18316`；启动前保留已知失效运行 socket 所在目录至 `run.before-bw-project-transaction-20261009`，没有删除。容器及本任务启动的 Docker 已停止，原卷、合成账号、失败证据保留。此轮未启动 Android 虚拟机或修改 Android 产品；未改现有 Passkey ID、私钥和零计数策略，未发布、推送或打标签，也未重试被拒绝的扩展缓存清理。
