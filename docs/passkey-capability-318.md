# Passkey capability and Android refresh protection · 2026-10-10

Extension development build: **0.1.37**, updated in `dist`. No release/tag/publication in this batch.

## 中文

Passkey 列表、全部项目、归档／回收站及详情现在使用同一套能力判断：

- **浏览器不可用**：缺失／损坏私钥、Android 元数据、算法不支持、备份标志冲突、计数回退或密码源绑定失效。详情显示具体原因。
- **仅原设备**：导入的设备密钥引用没有携带实际私钥。此副本不能用于浏览器登录；从原设备重新导出包含私钥的加密备份可能恢复跨端能力，不将引用等同于永久不可导出的硬件密钥。
- **跨端受限**：可在浏览器签名，但注册时不可备份、存在非零计数历史，或不是 ES256。分别解释网站、Android 零计数策略及 Bitwarden 写入限制。
- **可跨端保存**：密钥可解析并由当前浏览器导入，且未发现上述迁移限制。这是密钥能力判断，不承诺网站一定接受登录。

保存位置和能力分开判断：Monica 本地库的可导出私钥不会被误标为“仅本地可用”。元数据来源适配器只增加设备引用提示，不把引用或私钥写入界面。MDBX、KDBX、Android ZIP 和手动快照保留该提示。

密钥检查与实际签名复用同一个导入函数，支持 ES256、RS256、PS256、Ed25519，并兼容 PKCS8 的 PEM／Base64 形式。仅为当前可见项目异步检查；按项目 ID、密钥材料及算法缓存，最多 128 条，锁库或页面卸载时清空，不保留 CryptoKey。备注、主题、搜索和详情切换不会反复导入相同密钥。

同步刷新补上 Android 当前保护逻辑：已有记录的空可备份属性已经按 `true` 签名，不能通过刷新改成 `false`；显式相反值也被拒绝，传入省略值保留原值。原有 ID、私钥、计数不被改写，新导入的独立 `false` 凭据仍可保存。冲突的 BE=false／BS=true 不再被签名器静默纠正，而是拒绝签名。

设计沿用本地 M3E Canvas，连续圆角分组与状态标签；[可编辑设计及本地链接](design/passkey-status-318.md)。中文、英文及六个附加语言目录已同步。

验收：

- 首轮能力／签名专项 **41/41**。
- Passkey、加密存储、Bitwarden 与格式编解码回归 **615 项**：614 首次通过，1 项旧批量项目测试超时；隔离复跑该文件 **4/4**，未放宽超时。
- KeePass、MDBX、Android WebDAV 文件提供方回归 **1,003/1,003**。与前组有重叠，不相加作为唯一测试数。
- **3 个实际 Edge 场景**：新建 ES256 注册／登录、导入 Bitwarden 登录，以及 7 种凭据列表与 6 种详情状态。状态页最终复验通过；验证暗／亮色、320px 放大文字、密钥不进入 DOM、详情／搜索重复打开不再次解析密钥、存储中原计数及密钥不变。
- TypeScript 项目检查、E2E 文件类型检查、生产构建、安全目录／资源检查通过；2 个本地 Canvas 页面渲染通过。

证据：`.artifacts/passkey-capability-{unit,regression,batch-rerun,file-regression,edge,edge-verified,build-final,security-final}.log`；状态页截图归档在 `.codex-tasks/android-interop-315/raw/passkey-capability/`；当前构建清单 `.artifacts/passkey-capability-manifest-318.json`。

Android 参考为其新修复报告 `Monica-main/Monica for Android/docs/PASSKEY-COMPATIBILITY-VERIFICATION-2026-10-10.md`。本批没有修改或安装 Android，也没有使用已过期的旧补丁 APK 来证明新修复。完整 Android 系统 Credential Manager、真实网站及所有后端往返验收仍未全部完成；既有 KDBX 分组与跨端总任务继续保留未完成状态。

## English

The extension now labels Passkeys by actual browser key capability and transfer restrictions. Device references are unavailable in the browser and marked as belonging to the original device. Exportable keys in the local vault are not falsely labelled device-only. Details explain missing or invalid keys, backup flags, counter history, source bindings and algorithm limitations.

The real signer and UI inspection share key import logic. A bounded session cache avoids repeated crypto imports during list/detail/search interactions and is cleared on lock. Same-credential refreshes preserve Android-compatible immutable backup eligibility; conflicting updates leave the stored credential intact. Existing identities, private keys and counter policy remain unchanged.

Targeted regressions, 1,003 file-provider tests, three actual Edge scenarios, build/type checks, security checks and local Canvas previews passed. One existing batch test timed out in the broader run and passed its isolated rerun without timeout changes. This validates the extension batch, not complete Android system or real-site interoperability.
