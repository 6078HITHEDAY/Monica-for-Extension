# Bitwarden 回收站的并发修改与恢复

2026-10-09，扩展 `0.1.37` 当前工作树的增量修复，未新建版本、标签或发布。

## 已复现的问题与修改

真实 Vaultwarden 1.37.3 中，删除请求到达前另一端更新了密码，服务器把最新密码保存在回收站。扩展却在收到删除成功后，用删除前的同步快照自行生成本地回收站记录，保存了旧密码、旧修订和本地时间。失败记录在 `.tmp/bw-trash-318/concurrent-delete-bm2ai3/evidence.json`，日志 `.artifacts/bw-trash-live-before.log`。

`BitwardenProvider` 现在在删除后读取该 Cipher 的实际内容，确认回收站标记并完整解码后才确认持久回执。返回本地的是服务器保留的密码、修订、删除时间和同 Cipher 的凭据。读取失败或远端已经恢复时保留待处理操作，不以 HTTP 200 代替内容确认。

移入回收站请求不再自动网络重试。请求已提交但响应丢失时，重试可能再次删除其他设备刚恢复的项目。加密回执在重启后读取服务器状态：仍在回收站则确认已有结果；远端仍可用或已经恢复则保留冲突并停止重删。用户可以使用远端版本，或明确保留本地删除；后者修复为排入 `delete`，避免原先误排 `update` 而造成回执与操作不匹配。

## 真实服务语义

- 更新会拒绝明确过期的 `lastKnownRevisionDate`。
- `/ciphers/{id}/delete` 接受同样过期的版本字段及不匹配的 `If-Match`，返回 200。这些参数没有提供删除 CAS。
- 删除保留最新密码、自定义字段及附件；`/sync` 和 `/details` 均可读取回收站项目，附件在回收站内和恢复后可以下载并通过独立 SHA-256 比对。
- 恢复保留 Cipher ID、密码、保护字段和附件。

这里验证的是隔离的 Vaultwarden 1.37.3 HTTP 服务，不是 Bitwarden 官方云，也不是服务器多 Cipher 原子事务。**Bitwarden 项目成员移除仍未启用。** 共享内容转移需要源和目标一起受保护；本次读取确认不能替代这一要求。后续需要独立的持久移除日志、附件并发检测及补偿恢复流程，或采用服务真正支持的事务机制。WebDAV ZIP 的目录最新备份并发窗口也仍独立待解决。

## 验收

- 25 个文件、344 项相关回归通过，包括 Bitwarden、持久回执、共享密码库服务和 Passkey 定向同步。日志 `.artifacts/bw-trash-regression.log`。
- 新增 4 个加密密码库重启测试覆盖成功回读、读取中断、远端恢复后选择两种冲突决策；另有删除请求不自动重试的客户端测试。
- 真实服务最终 2 个文件、6 项通过，运行 15.88 秒：5 项回收站场景加已有 99＋2 密码项目批次边界及独立账号回读复验。日志 `.artifacts/bw-trash-live-final.log`。
- 两套 TypeScript、生产构建、234 个图标及页面资源检查通过；当前 `dist` 已更新。日志 `.artifacts/bw-trash-build-final.log`。
- 运行时安全审计通过，212 个命令及 24 个管理端项目命令。日志 `.artifacts/bw-trash-runtime-audit.log`。

最终证据在 `.tmp/bw-trash-318/` 的 `contract-X0qMHn`、`concurrent-delete-7inWO3`、`delete-response-K3NaJA`、`readback-response-qxD0tW`、`concurrent-restore-XpT6Zo`。保留实际语义、加密待同步快照、并发后读取与恢复结论。分批复验在 `.tmp/bw-project-batch-318/run-pCddJt/`。文件哈希清单为 `.artifacts/bw-trash-acceptance-manifest.json`。

保留失败证据：初次产品复现；随后时间断言未匹配现有毫秒日期规范化；恢复决策真实回执类型错误；测试夹具新增删除属性需要补类型。分别在 `bw-trash-live-before.log`、`bw-trash-live-after.log`、`bw-trash-recovery-unit.log`、`bw-trash-build.log`。修正日期断言没有放宽密码、修订或恢复检查。

## 环境与边界

Docker 因失效的 OTel socket 停止。确认运行目录只含该 socket、进程已结束后，将目录改名保存在 `C:/Users/joyins/AppData/Local/Docker/run.before-bw-removal-20261009`，没有删除。重新启动后的引擎报告零容器、零镜像和零卷，无法复用上一轮记录的容器；未重置引擎或尝试改写旧数据位置。使用同一镜像内容 `sha256:973e49edd3878ee81e45f6c0709e2f7a465455087787ebe59e3ebee744d53392` 新建隔离测试服务，仅绑定 `127.0.0.1:18316`，新卷 `monica318-bw-trash-20261009`。初次无持久卷的容器被服务器拒绝启动，保留失败容器，随后使用新命名容器和新卷运行。账号和数据均为本次新建的合成测试数据；服务身份记录 `.artifacts/bw-trash-service.json`。

没有 Android 产品、APK、Passkey 私钥、凭据 ID 或零计数策略修改，没有新增浏览器界面验收。用户此前确认的 GitHub Bitwarden Passkey 登录及正常响应结论保持有效。公共 Android 虚拟机已无 QEMU 进程，ADB 显示 offline；共享任务已完成，核验 PID 和启动时间后停止本任务留下的 emulator 包装进程，保留 AVD 配置与数据盘。先前被拒绝的扩展缓存／测试资料删除没有重试。

全目标仍未完成：项目成员移除的其他后端、完整 Android 类型与生命周期矩阵、Android KDBX 分组授权以及真实 OneDrive 账号互通继续跟进。
