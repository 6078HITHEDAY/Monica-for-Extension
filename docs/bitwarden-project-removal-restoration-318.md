# Bitwarden 项目移除：补偿后的本地收尾（2026-10-09）

本批完成内部协调器在远端补偿确认后的本地收尾。读取服务器当前密码和关联凭据，在同一次加密写入中采用结果、清理本次删除队列并将操作记为 cancelled。**完整互通和管理端入口仍未完成；新增真实 Vaultwarden 场景尚未运行。**扩展保持 0.1.37，未提交、推送、发布或打标签。

## 行为

- `restoredReadback` 两次重新读取完整成员范围和原始 Cipher，包括期间新增的同项目成员；逐项比较内容和回收站状态。变化中的结果、缺失/不可读取的来源仍保留恢复日志。此检查是多个服务器读取的序列，不是服务器原子快照。
- 补偿后的密码、备注和原始未知字段以服务器当前内容为准，不向远端写回旧草稿。源记录已被另一端移出原项目时保留其新归属；未被本操作触碰、由其他客户端独立放入回收站的记录不会被再次复活。
- 回读只传原始加密 Cipher 和必要的加密组织/文件夹资料。本地保存层自行解密生成投影，检查来源、修订、封装摘要、完整原成员范围和新增成员归属，不接受外部生成的明文项目投影。
- `completePasswordProjectBitwardenRestoration` 保留现有本地 ID、其他来源引用和原草稿，原始封装、会话、关联凭据、队列与 cancelled 日志一次保存。网络不在密码库写锁内执行；验证仅针对本次涉及的记录，不重新克隆全库做导入校验。
- 另一端已移除的 Passkey/TOTP 保留本地内容并进入明确冲突。同一 Passkey ID 的签名身份改变或已有正计数回退，也保留本地和远端版本供选择。没有改变原有零计数设计、凭据 ID 或私钥。
- 这类恢复冲突带 `requiresExplicitResolution` 标志。Bitwarden 持久同步在发出请求前拒绝继续，通用同步保存层也不能清除它。冲突随加密库重启保留；只有现有“保留本地/使用远端”明确决策才能解除，避免下一次普通同步悄悄丢掉保留的密钥。
- 内部协调器会处理已确认 restored 的日志，最终加密保存失败后可以重新读回并完成；终态重试不重复删除、恢复或发起同步。

## 验证

32 个相关文件、496 项集中回归通过，25.00 秒：`.artifacts/bw-project-restoration-regression-final.log`。范围包括 Bitwarden、项目事务/核验、密码库服务、附件及后台项目逻辑。

最后补充协调器终态接入与保存失败重启的专用测试，与现有采用/补偿用例一并运行，33 项全部通过，13.75 秒，见 `.artifacts/bw-project-restoration-coordinator-tests.log`。其中 HTTP 为客户端模拟；加密库写入、失败保存和重新解锁使用真实密码库逻辑。测试生成实际 ES256 私钥，验证删除/替换冲突后保存的密钥与凭据 ID 保持一致；本批不声称真实网页签名验收。

两套 TypeScript、生产构建、234 个图标及三张扩展页面资源检查通过，`.artifacts/bw-project-restoration-build.log`。运行时审计通过：212 个命令、24 个仅管理端项目命令，`.artifacts/bw-project-restoration-audit.txt`。`dist` 已重建为当前可达代码，版本仍为 0.1.37；未接入后台的协调器不会因此在界面启用。

初期编译缺少 `bitwardenProjectCipherId` 导入，已补齐；三项用例把缺失的 `deletedAt` 属性与显式 undefined 当成相同 `toMatchObject` 结构，已改为单独检查该值。失败日志保留。后续审查补充了普通同步不能丢弃恢复冲突、Passkey 密钥替换及计数回退的检查。

## 未运行的真实服务场景

`real-services315-bitwarden-project-removal.interop.ts` 新增四项：

| 场景 | 本批状态 |
| --- | --- |
| 并发密码/备注变化后的完整补偿收尾 | 未运行 |
| 补偿最后一次加密保存失败后重启 | 未运行 |
| 真实恢复响应丢失后重启 | 未运行 |
| 删除窗口新增项目成员后的补偿收尾 | 未运行 |

启动既有本地 Vaultwarden 容器的命令被自动审批拒绝，工具仅返回 `blocked by policy`，未给出具体原因。没有换写法或换工具重试。随后只读确认该容器仍为 exited，未运行任何服务测试，也未把旧批次的真实服务通过记录计为本批通过。

本批启动过 Docker Desktop；确认没有运行容器后已关闭，最后检查没有 Docker Desktop/backend/CLI 进程。原持久卷、目录和历史证据保留。环境记录见 `.artifacts/bw-project-restoration-environment-finished.json`，真实服务待验收状态见 `.artifacts/bw-project-restoration-live-status.json`。未启动 AVD、修改 Android 产品代码或重试此前被拒绝的缓存/配置目录删除。

## 后续

仍需完成源密码承载 Passkey 时的持久保留/搬迁、事务期间本地使用/编辑的可恢复决策、恢复请求结果不明时的明确选择，以及 committed 后另一端再次恢复的处理。当前本地内容变化会保留日志并停止收尾，不覆盖新内容。

后台来源队列、实际 IndexedDB/Edge 重启、管理端恢复显示与 Android 往返仍待接入和验收。真实 OneDrive OAuth/自动同步、Android KDBX 分组范围及其他类型/后端生命周期矩阵也仍未完成。完整目标保持进行中。
