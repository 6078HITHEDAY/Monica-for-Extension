# Wi-Fi receive continuation — 2026-10-16

## 中文

用户在资料字段提交 `5f93593` 后另行要求继续 Wi-Fi 收尾。本轮只补齐中断接收遇到不重叠本机修改后的核对、显式确认与恢复。[上一轮冻结记录](wifi-stage-closeout-2026-10-16.md)保留为历史，不表示本轮功能仍被撤出。公开版本仍为 0.1.39 Preview，本机 `dist` 已包含本轮实现；没有推送、标签或新 Release。

### 已完成与安全边界

- 原生写入先证明旧操作因版本变化未执行，且加密日志完整保留已完成步骤，才允许检查。管理页面只传不透明操作／确认 ID，不能提供计划、版本或证明。
- 仅允许已有条目的标题／内容更新与受支持的剩余文件夹、标签及新建文件夹／根附件操作组合。条目写入、移动、删除、关系、分配和条目所属附件等剩余操作不进入此路径。
- 必须读取完整历史，最多 8 页、每页 50 条，共 400 条；除唯一的原生初始化记录外只接受同一设备历史。按原生单调 `localSeq` 证明两版本之间连续且不超过 64 次提交，核对完整变更范围和差异，最多涉及 1024 个条目。时间戳排序和对象历史父节点不能作为全库写入顺序证据。
- 确认 ID 单次使用、两分钟过期，并绑定会话、密码库句柄、设置代次和版本。确认前再查版本，先加密保存确认记录和新操作再写入；一般恢复始终重放已保存的原操作。每笔接收最多保留 8 次显式继续记录，原已完成输入不被重写。
- 不满足条件时保留加密日志和冲突；取消、锁定、重启不丢弃内容。待恢复期间同一 MDBX 的普通修改／云同步保护仍在。原生权限和版本检查仍执行，Passkey 密钥、凭据 ID 和计数策略未修改。

### 验证

证据目录：`.artifacts/wifi-closeout/`。所有数据为隔离合成数据；使用已安装 Edge 与既有原生组件，临时注册恢复，五个测试浏览器配置目录已清理。

| 验证 | 结果与日志 |
| --- | --- |
| 定向单元／安全回归 | 21 个文件、402 项通过；`unit-final.log` |
| 真实 MDBX 配置／附件接收与继续 | 37.8 秒通过；`edge-accepted.log` |
| 本地可编辑 M3E Canvas | 4.2 秒通过，同上；[草图入口](../design/nearby-recovery-320.md) |
| 生产恢复界面、旧日志、取消、重连、锁定、窄屏 | 9.2 秒通过，同上 |
| 实际 Native Messaging 设置页配对、发现、同步、取消 | 16.6 秒通过，同上；浏览器批次合计 4 项通过 |
| 生产构建、项目／互操作类型、原生来源与页面资源 | 通过；`build-final.log`，仅既有包体大小提示 |
| E2E 严格类型检查 | `npx tsc -p .artifacts/wifi-closeout/e2e.tsconfig.json --pretty false` 通过；`e2e-types-final.log` |
| 构建安全检查 | `node scripts/security-audit.mjs` 通过；`security-final.log`。核对 219 个运行时命令、24 个管理端项目命令及附近同步端口；无测试秘密或 source map 泄漏 |

真实引擎场景验证：接收中断后修改本机密码；只读核对；核对后再次修改使旧确认失效；重新核对并确认；原生保存完成但响应丢失；关闭浏览器再启动并恢复已持久化操作。最终本机密码标题和备注保留，原 Passkey 私钥摘要、凭据 ID、签名与计数 19 保留；1 MiB 配置及独立 1 MiB 附件重新读取并核验 SHA256，根目录来源归属保留，日志完成后清除。

证据区分：生产界面中成功核对／确认的渲染和点击契约使用明确标记的合成管理端响应（`actualNativeRecovery:false`、`syntheticReviewResponses:true`）；真实证明、加密持久化、写入与重启恢复由独立的实际引擎／协调器场景验证。没有将二者声称为一次完整的生产界面到原生冲突继续操作。

修复并保留了早期失败日志：历史每页请求从错误的 100 改为原生上限 50；撤去不成立的全库父链假设，改用完整单设备序列；明确允许原生初始化记录的创建者标签；附件比较按身份、数量、内容和实际字节校验，不要求无语义保证的排列顺序。最后仅修正测试数组类型收窄，严格类型检查通过后未重复构建或浏览器验收。

### 固定限制

重叠修改、无法证明的写入来源／历史、多个设备历史、超过 400 条的完整历史、旧日志缺失完成内容仍不支持确认继续，不提供通用冲突合并或丢弃。更大单文件、Android 两版文件夹／根附件及界面／组播的完整验收、跨后端恢复和真实 OneDrive 账户验收继续留待后续，未计入完成范围。Wi-Fi 网络仍需要本机通信组件；MDBX 数据库引擎已内置。无 Android 修改、AVD 工作、原生引擎重建或用户 Chrome／账户操作。

## English

This separately authorized follow-up after `5f93593` closes bounded continuation of an interrupted receive after unrelated local entry edits. The earlier freeze remains historical. `dist` is updated, public Preview remains 0.1.39, and no push, tag or release was created.

Review requires a proven stale native operation, complete retained inputs, unchanged other branch heads and complete single-device history (except native genesis), bounded to 400 commits. A contiguous native `localSeq` interval of at most 64 commits proves that only existing-entry title/payload updates occurred; at most 1024 affected entries are allowed. Remaining writes are restricted to supported collection/label operations and creation of collection/root-owned attachments. Object parents and timestamps are not used as vault-wide write ordering evidence. Unknown, incomplete, overlapping or unsupported histories/plans remain blocked with encrypted data retained.

The manager supplies only opaque IDs. Confirmation is single-use, expires after two minutes, rechecks session/handle/preferences/revision and persists encrypted approval before native writing. Up to eight explicit continuations are retained per receive. Ordinary recovery replays the persisted operation, including after committed response loss and browser restart. Existing inputs, native authorization and revision guards remain intact.

Validation passed: 402 tests across 21 files; four isolated Edge scenarios; production build, strict E2E types and security audit. The actual engine test preserves the latest local password edits, original Passkey key/credential/signature and counter 19, root ownership and both 1 MiB payloads with byte hashes. Production UI success rendering uses disclosed synthetic manager responses; actual recovery is independently verified through the real coordinator/engine. These are complementary tests, not one asserted UI-to-native acceptance path. Local Canvas and final narrow dark UI rendering were inspected. Five test profiles were removed and temporary native registration restored.

General conflict merging, larger individual files, complete Android/F-Droid attachment/UI/multicast acceptance, broader backend recovery and real OneDrive acceptance remain deferred. No Android sources, native build, personal browser or accounts were touched.
