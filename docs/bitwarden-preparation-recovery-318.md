# Bitwarden 项目移除：准备期编辑恢复

2026-10-10，扩展 `0.1.37`，HEAD `18dd08d79a5ac454cac5512f85e0dbf55141e395` 上的未提交工作。当前 `dist` 已重新构建。本批补上密码项目移除准备期间的恢复出口，整体 Android 对齐目标继续保持未完成。

## 行为

原来，准备复制 Passkey 时修改本地密码或关联凭据，会使后续检查持续拒绝，普通同步也被准备日志挡住。现在发现这类编辑后，先在加密日志中持久化停止准备，再进入只读核对。后续工作进程不能继续复制或冻结删除意图。

恢复阶段不发送 Cipher 新建、删除、恢复或普通同步写入。它两次读取当前原项、项目成员及保留副本；通过加密操作标记查找副本，并核对独立 details、原生密文及凭据身份。已尝试创建但暂时查不到的副本继续保留为未知结果，不能当成创建失败，也不会重发创建请求。稍后副本出现后，可以通过现有“核对并继续”完成恢复。

核对通过后，在一次加密保存中完成：

- 保留最新本地编辑，并把相应远端版本保存为需要明确选择的冲突。
- 保留最初移除草稿中尚未上传的修改；不能因后续关联凭据编辑触发恢复而被旧远端内容覆盖。
- 保留所有原项、原 Passkey 本地 ID、凭据 ID、私钥、签名计数及最新本机使用统计。
- 将已经确认的独立副本作为真实来源记录加入本地，保留原生密文及复制日志。没有创建的副本不补建。
- 清理对应的普通同步队列，将移除标记为取消。用户通过已有“保留浏览器版本／采用 Bitwarden 版本”处理冲突后再同步。

身份缺失/改绑、未确认写入回执、原项被独立删除、损坏/重复/被删除的副本仍会保留恢复记录。新流程没有授权忽略这些不确定状态。

同时修复了来源卡片的空队列显示：后台现在为已配置来源返回零值队列，空队列显示“没有待处理操作”；准备恢复中的项目计入恢复数量。正在核对取消准备时，复用已有状态文字和继续按钮，避免误显示为仍在复制。

## 验证

最终 6 个相关文件 **196 项回归通过**，36.19s；之前的 7 文件 196 项与中间 4 文件 134 项均有重叠，不相加作为覆盖总数。Passkey 保留测试中新增 17 个针对性用例，包括准备前/中/后编辑、主项携带凭据、多源 Cipher、回读中的再次编辑、未知副本稍后出现、加密保存失败和重启、伪造/缺失回读及未上传初始草稿保护。

真实 Edge `154.0.4258.62` / MV3 / IndexedDB 共 **9 个不同用例通过**。三个新增用例覆盖正常复制响应、丢失响应、暂时不可发现后再次发现；每条流程只有 1 次复制、0 次删除、0 次恢复，并保留原始密码和 0/23 计数。通过实际管理页选择保留本地、连续同步两次后，独立解码远端密码正确；原始两把凭据及一份副本共 3 份签名均以原公钥验签通过。

最终构建上的三个新增 Edge 用例复验 **12.3s 全部通过**。未知结果流程的 320px 真实渲染已检查。HTTP 为 Playwright 合成路由，不是实际 Bitwarden/Vaultwarden、Android 或网站 RP 验收。

两套 TypeScript、专项 E2E TypeScript、234 图标检查、生产构建及三个扩展入口验证通过。安全审计仍为 212 个命令、24 个仅管理页的密码项目命令；没有新增运行时命令。

## 证据与设计

- `.artifacts/bw-preparation-recovery-safety-final.log`：最终 196 项回归。
- `.artifacts/bw-preparation-recovery-regression.log`、`bw-preparation-recovery-final-regression.log`：前两批重叠回归。
- `.artifacts/bw-preparation-recovery-build-final.log`、`bw-preparation-recovery-security-final.log`。
- `.artifacts/bw-preparation-recovery-edge.log`：首轮 8/9；`bw-preparation-recovery-edge-verified.log` 与 `bw-preparation-recovery-edge-final.log`：新增三例均通过。
- `.artifacts/bw-preparation-recovery-edge-final/`：浏览器身份及 320px 恢复界面截图。
- `.artifacts/bw-preparation-recovery-manifest.json`：当前源码、构建及证据摘要。
- [本地 M3E Canvas 可编辑设计](design/bitwarden-removal-318.md)：新增取消准备核对页，共六页，使用现成列表与按钮；本地预览和实际插件渲染均已检查。

保留的失败：首轮单测误用了不存在的 `storage.save`，改为真实 `write` 后通过；首次类型检查发现测试可选字段与既有 E2E 返回值类型未收窄，均已修正。首次未知结果 E2E 已完成恢复、同步和验签，但在 320px 刷新后未先打开导航，最后一次来源页定位超时；修正为实际“打开导航”流程后通过，没有增加超时时间。

本批 15 个独立 Edge 配置保留，本任务 Edge 进程为零，见环境记录。没有启动 Android 或 Docker，没有修改 Android 产品代码、凭据计数策略，没有发布/推送/打标签或重试先前被拒绝的容器启动、缓存删除。

## 剩余范围

需要专门决策的身份变化/缺失、始终未知的创建/恢复结果、保留副本管理和实际服务/Android 验收仍未完成。OneDrive 真实账号、Android KDBX 分组授权范围、ZIP 并发窗口及完整类型/后端/生命周期矩阵继续保留为未完成。已有 [当前 Android MDBX Passkey 往返](android-passkey-current-runtime-318.md) 与 [冻结删除意图后的编辑恢复](bitwarden-project-local-recovery-318.md) 各自保留其验收范围。
