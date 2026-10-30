# Bitwarden 密码项目同步批次

2026-10-09：修复同一密码项目被 100 条同步上限拆成两轮上传的问题。队列前有 99 条独立密码、后面有一个双密码项目时，第一轮只上传 99 条独立密码，第二轮完整处理双密码项目。指定同步一个项目成员时，也包含该项目其余待同步成员。同标题的独立密码不合并。

`BitwardenDurableSyncCoordinator` 按已有明确项目标识及密码源／数据库范围分批。一个项目内的修改即使在队列中不连续，也作为同一批次单元；不跳过放不下的项目去处理后面的记录。批次仍最多 100 条；超过现有编辑器 100 成员上限的导入项目会明确报错并保留队列。只读刷新不发起修改，未选中的队列和密码内容保持不变。提示显示实际处理条数，不再固定声称处理了 100 条。

这是扩展的批次边界修复。Bitwarden 仍按 Cipher 逐条发送请求，没有声称服务器提供整组原子事务。网络中断可能出现部分 Cipher 已提交；已有加密回执继续用于识别已提交请求和恢复其他成员。项目成员移除所需的远端版本、附件及删除保护仍单独待实现，本次没有解除其功能限制。

## 验证

- 明确复现：99＋2 场景原代码实际上传 100 条，指定同步单成员原代码只上传 1 条；两个断言失败、只读控制通过。日志 `.artifacts/bitwarden-project-batch-reproduced.log`。初版测试构造器不接收自定义 ID／分组字段的问题单独保存在 `bitwarden-project-batch-before.log`，不算产品复现。
- 修复后 32 项相关测试通过，包括项目剩余队列、同标题独立记录、只读刷新、密码库与同步器重启、提交成功但响应丢失后不重复创建密码。`.artifacts/bitwarden-project-batch-recovery.log`。
- 25 文件、301 项 Bitwarden／Passkey 相关回归通过，含定向 Passkey 刷新路径。`.artifacts/bitwarden-project-batch-regression.log`。两套 TS、生产构建、图标／页面资源检查通过，当前 `dist` 已更新；运行时安全审计通过。
- 真实本机 Vaultwarden HTTP 验收通过（单场景 6.77 秒，整个运行 10.72 秒），没有模拟网络。第一轮服务器回读恰为 99 条独立密码；加密密码库和同步器重启后第二轮仅补齐双密码项目，最终 101 条、队列为空。再次独立登录服务器验证 99 个单项和一个双密码项目，以及完整凭据自定义字段、保护标记、密码和精确未来整数 `9007199254740993`。

真实证据在 `.tmp/bw-project-batch-318/run-BEJZtq/`：`evidence.json`、第一次批次后的加密密码库、独立服务器回读。运行日志 `.artifacts/bitwarden-project-batch-live.log`。只使用已授权的 `127.0.0.1:18316` 隔离容器和新建合成账号，未使用用户账号。本批没有 Android 应用或浏览器界面新增验收，也未改变 UI 布局。

Docker 初次启动因失效的 `userAnalyticsOtlpHttp.sock` 重解析点立即停止，日志和引擎状态已确认。只关闭本任务启动的进程；单文件改名失败后，核验 `Docker/run` 仅含该文件，将整个运行目录可逆改名为 `run.before-project-batch-20261009`，保留原内容。再次启动引擎后只启动原隔离 Vaultwarden 容器。没有删除 Docker 文件、卷、账号或扩展缓存。过程见 `.artifacts/docker-project-batch-runtime-recovery.json` 和 `.artifacts/bitwarden-project-batch-service.json`。

本批记录是当前密码项目互通目标的增量证据。真实 Android 全字段／生命周期矩阵、Bitwarden 成员移除、Android KDBX 项目分组及 OneDrive 实际账号互通仍未完成。没有新发布、推送或打标签。
