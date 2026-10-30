# Bitwarden 附件跨库复制验收

2026-10-11，浏览器插件开发构建 0.1.37，未发布。

批量传输旧实现仍把 Bitwarden 附件当作不支持；缓存记录缺失或 Passkey／验证码投影的远端 ID 带后缀时，还可能将父 Cipher 误判为没有附件。现在通过现有认证下载器读取父记录文件，区分列表密文长度与下载后的明文长度，支持未知大小及空文件。文件名不能解密时阻止复制，不把界面的占位名称写入目标；原 Steam 内容恢复仍可使用已认证正文。组织、Cipher 和独立附件密钥均沿用现有解密流程，读取完成或失败后清空临时字节和组织密钥。

个人附件使用单条 Cipher 接口，不为每个文件执行整库同步。来源版本先按已有模型的毫秒精度核对；这是复制时的变更检测，不构成远端删除的 CAS 保证。列表分页、下载身份、偏移、结束位置和上传回执均检查；MDBX 目标回读全部文件，核对名称、大小、归属和 SHA-256 后才纳入插件。复制最后重新读取来源目录，目录变化则保留来源并报告失败。

继续审查时发现旧跨库移动路径调用普通 `ProviderAdapter.remove` 后直接纳入目标：KeePass 的普通删除仅修改内存会话，Bitwarden／旧 WebDAV 也没有该批量操作对应的持久删除恢复回执。因此在计划阶段阻止这些来源的移动，仍允许复制；已实现恢复事务的本地和 MDBX 来源继续使用原移动流程。完整多后端安全移动仍是未完成项。

## 验证

- 34 个相关测试文件、334 个回归检查通过；补上服务端高精度日期和不可解密文件名检查后，三个改动文件最终 53 项通过，共 336 个不同回归检查。包含共享父记录后缀、未知大小、空文件、组织密钥、MAC 损坏、名称/版本变化、下载失败清理、目标同大小不同内容及非法上传边界。
- 实际本机 HTTP 服务发送标准 Bitwarden type-2 加密二进制，真实 Native Host 写入隔离 MDBX。损坏 MAC 时拒绝；目标文件已提交但本地纳入前中断，重启 Native Host 与磁盘加密密码库后重试成功；再次重试仍只有一个副本。再次重启后独立读取目标文件并校验摘要，来源项目及原始合成备份不变。
- 原生测试使用已知 SHA-256 的既有合成备份，在新隔离目录导入；未读写用户密码库。证据为 `.tmp/bitwarden-mdbx-copy-20261011/run-*/evidence.json`，测试源码 `tests/interop/bitwarden-mdbx-attachment-copy.interop.ts`，执行需显式设置 `MONICA_TRANSFER_NATIVE=1`。没有调用 Android 或更改 Native Host 源码。
- 最初原生测试暴露新上传验证错误地要求 finish 同时返回 operationId；实际协议是上传返回 transferId、独立删除返回 operationId。依据原生解析契约修正验证及旧假实现后通过，保留失败诊断。另修复新测试调用错误的文件释放方法和缺失空组织密钥映射的类型错误。

回归日志：`.artifacts/transfer-attachments-regression-20261011.log`、`transfer-attachments-unit-accepted-20261011.log`；原生最终日志：`bitwarden-mdbx-attachment-native-final-accepted-20261011.log`。最终生产构建（含项目/互通 TypeScript、236 图标、三个扩展页面）与 212 条运行时命令的安全产物检查通过，日志为 `transfer-attachments-build-accepted-20261011.log`、`transfer-attachments-security-final-20261011.log`。

实际 Edge 155.0.4283.45 的三个场景通过：批量预览/确认/进度/重试、Passkey/Steam 筛选范围、Bitwarden 标准 maFile 下载失败后恢复并生成验证码。传输 UI 场景使用合成后台结果，不替代上述原生实写证据。日志 `.artifacts/transfer-attachments-edge-20261011.log`；Steam 真实渲染截图已检查，文件名保护修正后的最终 Steam 回归见 `transfer-attachments-edge-final-20261011.log`。所有配置与数据均为隔离测试数据。

本报告证明合成 Bitwarden 元数据、真实加密 HTTP 文件与真实 MDBX 复制链路；不证明真实 Bitwarden 账户/服务端、Android 往返或所有目标后端的完整移动。未改凭据 ID、私钥或 Android 零计数策略；本地/KeePass/Bitwarden 目标、OneDrive 实际账户及完整跨端矩阵仍待完成。
