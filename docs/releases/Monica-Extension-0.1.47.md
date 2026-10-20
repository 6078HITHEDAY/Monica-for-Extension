# Monica for Extension 0.1.47 preview-beta

> **发布渠道**：GitHub 正式 Release（未标记 Pre-release，标签 `v0.1.47`）。
> **构建性质**：preview-beta 试用版，不是稳定版，也不代表浏览器商店已上架。
> **支持范围**：Chrome 128 及以上为声明目标；Edge 的侧栏 Wi-Fi 同步连接路径已实测修复，但本版未完成 Edge 全量验收。
> **同步方向**：在 Android 端的“附近设备同步”设置中务必选择“双向同步”；选择“仅发送”或“仅接收”可能与电脑端方向不兼容，导致同步无法开始。

## 中文

### 本版修复

- 修复在 Edge 侧栏打开 Wi-Fi 同步时始终显示“同步连接已关闭，请重新连接。”的问题。Edge 侧栏的 `runtime.Port.sender` 只提供 `id`、`url`、`origin`，不提供 `tab`、`frameId`、`documentId` 或 `documentLifecycle`；后台原先按普通标签页校验，连接被静默断开。
- 侧栏文档现在以精确的 `index.html?surface=sidepanel` 路径和扩展 origin 识别；普通标签页继续要求顶层 frame 与有效 `documentId`，伪造路径、非顶层 frame 和异常来源仍会被拒绝。
- 无法识别的管理页上下文现在会返回 `manager-context-invalid`，页面显示具体原因，不再误报为普通的连接关闭。
- 新增对应单元测试，覆盖 Edge 侧栏精简 sender、带文档元数据的侧栏、普通标签页严格校验及侧栏异常路径拒绝。

### 升级与安装

- 扩展 ID 仍为 `lebnfedmijifofonogjdphpojihgohmc`。直接替换文件并在扩展管理页重新加载即可；不需要重新导出／恢复密码库，也不需要重新运行 `install-wifi.ps1` 或 `install-host.ps1`。
- Edge：`edge://extensions` → Monica → **重新加载**，然后完全关闭并重新打开侧栏。
- Chrome：`chrome://extensions` → **重新加载**；已登记的本机通信组件继续有效。
- 本版取代 0.1.46 的发布 ZIP；0.1.46 的安装包包含上述侧栏缺陷。

### 验证

构建、单元测试、真实 Edge 侧栏 sender 验证与可复现打包结果见[发布验证记录](../verification/release-0.1.47.md)。

### 已知限制

- OneDrive 真实登录、令牌刷新和 Graph 文件读写仍未验收；外部账号可能受发布者验证或租户管理员同意限制。
- 附近同步的真实手机首次同步、Android 自动同步与多播发现、F-Droid 验收、部分原生归档与文件夹配置、跨后端冲突合并仍未完成。
- Firefox 不支持。Edge 仅完成侧栏 Wi-Fi 同步连接路径的真实验证，其余界面与流程未做本版全量验收。
- 本版不宣称通过完整稳定版发布门禁；验证范围以发布验证记录为准。

### 反馈

反馈请提供版本、浏览器、密码源和复现步骤；不要上传真实密码、Passkey 私钥或密码库。安全问题按 [SECURITY.md](https://github.com/Monica-Pass/Monica-for-Extension/blob/main/SECURITY.md) 私下报告。

## English

> **Distribution**: a regular GitHub Release, not marked Pre-release; tag `v0.1.47`.
> **Build quality**: preview-beta for testing and feedback, not a stable release or a store listing.
> **Scope**: Chrome 128+ remains the declared target. The Edge side-panel Wi-Fi connection path is verified; full Edge acceptance is not claimed for this build.
> **Sync direction**: in Nearby sync on Android, always select **Bidirectional**. Send-only or receive-only may be incompatible with the desktop direction and prevent a sync from starting.

### Fixes

- Fixed Wi-Fi sync in the Edge side panel always showing “connection closed, reconnect”. Edge side-panel `runtime.Port.sender` exposes only `id`, `url` and `origin`, omitting `tab`, `frameId`, `documentId` and `documentLifecycle`; the background validated it like a normal tab and silently dropped the port.
- A side panel is now recognised by the exact `index.html?surface=sidepanel` path and extension origin. Normal tab documents still require a top-level frame and a valid `documentId`; forged paths, non-top-level frames and unexpected origins remain rejected.
- Unrecognised manager contexts now return `manager-context-invalid`, so the page explains the actual problem instead of reporting a generic connection close.
- Added unit coverage for the reduced Edge side-panel sender, a side panel with document metadata, strict tab validation, and rejected side-panel variants.

### Upgrade and install

- The extension ID remains `lebnfedmijifofonogjdphpojihgohmc`. Replace the files and reload the extension; no vault export/restore and no `install-wifi.ps1`/`install-host.ps1` rerun are required.
- Edge: open `edge://extensions`, click **Reload** for Monica, then fully close and reopen the side panel.
- Chrome: open `chrome://extensions` and click **Reload**; existing native-helper registrations stay valid.
- This release supersedes the 0.1.46 ZIP, which contains the side-panel defect.

### Verification

See the [release verification record](../verification/release-0.1.47.md) for the build, unit tests, real Edge side-panel sender evidence and reproducible packaging results.

### Known limitations

- Real OneDrive sign-in, token refresh and Graph file read/write remain unverified; external accounts may still be limited by publisher verification or tenant admin consent.
- Real-phone first sync, Android automatic sync and multicast discovery, F-Droid acceptance, some native archive/folder profiles and cross-backend conflict merging remain unfinished.
- Firefox is unsupported. Only the Edge side-panel Wi-Fi connection path was verified; the rest of the Edge UI and flows were not fully accepted in this build.
- This build does not claim the complete stable-release gate; the verification record defines the accepted scope.

### Feedback

Include the version, browser, password source and reproduction steps. Do not upload real passwords, Passkey private keys or vaults. Report security issues privately per [SECURITY.md](https://github.com/Monica-Pass/Monica-for-Extension/blob/main/SECURITY.md).
