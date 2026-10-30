# Monica for Extension 0.1.46 Beta（仅 Chrome / Chrome only）

> **测试版声明**：本版是供试用和反馈的测试版，不是稳定版，也不代表浏览器商店已上架。**仅支持 Chrome 128 及以上**；不声明支持 Firefox、Edge 或其他浏览器。发布页的 Preview／Pre-release 标记与本说明一致。

## 中文

### 重要：扩展 ID 已固定，升级前先导出备份

- 本版在 manifest 中加入公钥，扩展 ID 固定为 `lebnfedmijifofonogjdphpojihgohmc`。无论从哪个本地目录“加载已解压”，同一份构建都得到同一 ID；OneDrive 回调与 Windows 本机通信宿主可以按这个 ID 一次登记。
- 旧版使用由加载路径派生的 ID。`chrome.storage.local` 按扩展 ID 隔离，直接更换文件会得到一个“新扩展”，旧数据不会自动出现。升级前请在旧版中导出便携备份，加载本版后在新 ID 下恢复；确认恢复成功后再移除旧版。
- 曾经注册过 WiFi／MDBX 本机通信组件的用户，需要用本版的 `install-wifi.ps1`／`install-host.ps1` 重新登记一次；固定 ID 之后的升级不再需要重复登记。

### OneDrive 状态

Entra 中的 SPA 回调已于 2026-10-20 登记，固定 ID 后不再因 `redirect_uri` 被拒绝。但真实 Microsoft 登录、令牌刷新和 Graph 文件读写**尚未完成验收**；外部账号还可能受发布者验证或租户管理员同意的限制。请勿把 OneDrive 当作已验证的备份目的地。

### 附近（Wi-Fi）同步

- 新增附近同步设置页：选择本机或 MDBX 密码库、邀请文本／二维码配对、查找已配对设备、同步方向、页面打开时自动同步、状态显示和取消。配对只建立信任，实际传输需要另行开始；Passkey 跨端限制需要明确确认。
- 配对不再误报同步完成：只有对方确认保存后才更新同步时间并显示结果，结果只列出本机实际保存／删除的项目与数量，不显示密码；对方保存失败或超时会明确报错。
- Windows 通信组件提供配置下载与二维码／链接切换，不再要求手填 IP；局域网通信需要本机通信组件，MDBX 数据库本身已内置。
- 接收中断后可以离线恢复：待处理步骤、内容和附件副本先加密保存，重启、取消或锁定不会丢弃；丢失响应不会重复创建内容。遇到新的本机修改会显示冲突并停止。
- 新增冲突检查与确认入口：仅在修改互不覆盖时允许“保留本机修改并继续”；检查无需另一台设备在线，确认前再次核对数据库版本。历史不完整、多设备历史、重叠修改或超出检查上限时继续保留冲突，不自动覆盖。
- 补齐较大文件夹配置与附件组合的分步接收、二进制归档和 MDBX 原子恢复；每次发送重新检查权限和数据库版本，失败完整回滚。来自不同密码库的根目录内容分别归属，删除一方不会修改另一方。
- 补齐嵌套文件夹跨批次顺序（先父后子、先移出再删除）、文件夹回收站／恢复／永久删除、未分配标签与根目录附件、附件身份与未知字段保留。
- 修复 MDBX 扫描可能遗漏第一版原生文件夹配置、后台文档误断开 Wi-Fi 管理端口、旧原生 UUID 被误当会话句柄，以及本地库／MDBX 往返产生虚假修改与重复写入的问题。
- 已用当前普通版 Android 完成真实局域网双向验证（隔离合成数据）：插件创建的 Passkey 在 Android 端使用原密钥验签成功、零计数不变，密码编辑可以回传。真实手机首次同步仍需复测；Android 自动同步所需的 mDNS 在线广播尚未接入。

### 密码库与同步

- 修复 Bitwarden 实时通知连接直接使用旧令牌的问题：连接前先验证并按需刷新会话，保留加密保存与账号校验；锁定或关闭同步会取消进行中的认证，连接失败仍通过定时同步补齐更新。
- MDBX 原生目录、文件夹／根标签、密码项目、标签、关系和附件采用完整目录及版本检查，支持整笔接收、带附件移动和保留附件身份的替换；保留数值精度、Passkey 原密钥、凭据 ID 与计数策略。无法完整处理的内容会明确阻止扫描，避免遗漏被误认成删除。
- 本机项目同步保留原始来源归档（精确 JSON、二进制编码、未知格式和历史版本），归档保持加密，不自动创建远端连接或启用凭据。

### Android 1.0.320 字段对齐

- 对齐 Android 新增的地址姓名分段、地址第三行、区／县、家庭及工作联系方式和银行卡持卡人姓名分段；完整姓名与姓名分段独立保存，家庭／工作联系方式不使用默认联系方式代填。
- 新增字段已接入本机保存、导入、Android 备份、MDBX、KDBX 和 Bitwarden 编解码；网页填充支持对应独立字段、国家与有效期下拉框和多行地址，并对含义不明或重复匹配的控件跳过。

### 界面与性能

- 移除显示分组、管理堆叠和封面操作，密码项目直接平铺；登录项与全部项目共用紧凑列表样式。移除时间线页面、侧栏入口及后台读取接口，并移除侧栏独立的 API 密钥入口；已有 API Token 记录仍可在“全部项目”中管理。
- 修复大型密码库的界面卡顿：打开动态验证码页的最长主线程阻塞从约 3.1 秒降至约 0.37 秒，列表、搜索与详情也更流畅。详见 [PERFORMANCE.md](../PERFORMANCE.md)。

### 构建与 CI

- 修复 Linux CI：固定哈希测试夹具按 CRLF 检出、CodeQL 先构建浏览器引擎、Windows Hello 测试按平台判断、Popup 探针显式选择语言；更新与当前界面不符的 e2e 用例，缺少 Edge 时跳过并注明原因。本测试版不声明 Edge 已验收。

### 已知限制

- 仅支持 Chrome 128 及以上。Firefox 需要事件页、sidePanel／offscreen／favicon 替代、独立 OAuth 回调和签名 XPI，当前不支持；Edge 未在本版验收。
- OneDrive 真实登录、刷新和文件读写未验证；外部账号可能需要发布者验证或管理员同意。
- 附近同步的真实手机首次同步、Android 自动同步与多播发现、F-Droid 验收、部分原生归档与文件夹配置、跨后端冲突合并仍未完成。
- 本测试版不宣称通过完整稳定版发布门禁；验证范围以[发布验证记录](../verification/release-0.1.46.md)为准。

### 安装与反馈

下载 `monica-extension-0.1.46.zip` 并解压，在 `chrome://extensions` 打开开发者模式，选择“加载已解压的扩展程序”并指向解压目录。已有旧版用户请先按上文导出备份；恢复成功后再删除旧加载项。

下载列表仅保留插件 ZIP 和 SHA-256 校验文件；依赖清单、许可证清单与源码提交证据已包含在 ZIP 内。反馈请提供版本、浏览器、密码源和复现步骤；不要上传真实密码、Passkey 私钥或密码库。安全问题按 [SECURITY.md](https://github.com/Monica-Pass/Monica-for-Extension/blob/main/SECURITY.md) 私下报告。

## English

### Important: the extension ID is now fixed — export before upgrading

- This release adds the public key to the manifest, pinning the extension ID to `lebnfedmijifofonogjdphpojihgohmc`. Loading the same build unpacked from any local directory now yields the same ID, so the OneDrive callback and Windows native-messaging hosts can be registered once.
- Older builds derived their ID from the load path. `chrome.storage.local` is scoped per extension ID, so replacing files produces a "new" extension that cannot see the old data. Export a portable backup from the old build first, load this release, restore under the new ID, and only then remove the old entry.
- Users who registered the Wi-Fi/MDBX native helper must rerun `install-wifi.ps1`/`install-host.ps1` once for the new ID. Future upgrades keep the same ID and need no re-registration.

### OneDrive status

The Entra SPA redirect was registered on 2026-10-20, so the fixed ID no longer fails with `redirect_uri`. Real Microsoft sign-in, token refresh and Graph file read/write have **not been accepted yet**, and external accounts may still be blocked by publisher verification or tenant admin consent. Do not treat OneDrive as a verified backup destination.

### Nearby (Wi-Fi) sync

- Added nearby-sync settings: choose the local or MDBX vault, pair by invitation text/QR, find paired devices, choose direction, auto-sync while the page is open, inspect status and cancel. Pairing only establishes trust; transfers start separately, and Passkey portability requires explicit confirmation.
- Pairing no longer claims a completed sync. Timestamps and the result dialog require the peer's save receipt; results show actual locally saved/deleted items and counts without passwords, and rejected or timed-out peer saves report failure.
- The Windows helper offers configuration download and QR/link switching without manual IP entry. LAN networking needs the local helper; MDBX storage is bundled.
- Interrupted receives can be recovered offline: pending steps, content and attachment copies are encrypted before writing, survive restart/cancel/lock, and lost replies do not duplicate content. Intervening local edits stop recovery with an explicit conflict.
- Added conflict review and confirmation: “Keep local changes and continue” is offered only for proven non-overlapping edits. Review works offline and rechecks the database revision before approval; incomplete history, multi-device history, overlapping edits or exceeded bounds remain blocked rather than overwritten.
- Added resumable adoption and binary archival for larger folder profiles with attachments, plus atomic MDBX restoration and per-source ownership. Every outgoing read rechecks policy and revision; failures roll back completely.
- Fixed nested-folder batch ordering (parents first, descendants moved/deleted first), retained folder trash/restore/purge, unassigned labels and root attachments, attachment identity and unknown-field retention.
- Fixed native scans overlooking schema-1 profiles, the offscreen document disconnecting unrelated Wi-Fi manager ports, historical native UUIDs rejected as session handles, and false edits/repeated writes in local-vault/MDBX round trips.
- Verified real bidirectional LAN exchange with current ordinary Android (isolated synthetic data): a browser-created Passkey signs with its original key on Android, counter zero is preserved, and password edits return to the browser. First sync on a real phone still needs retesting; Android automatic sync requires mDNS presence, which is not implemented.

### Vault and sync

- Fixed Bitwarden notification connections using stale tokens: the session is validated and refreshed before the WebSocket handshake, with encrypted persistence and account checks. Locking or disabling sync cancels pending authentication; polling still covers failed connections.
- Native MDBX catalogs, folder/root tags, password records, labels, relations and attachments use complete inventories and revision checks, with atomic adoption, attachment moves and identity-preserving replacements. Numeric precision, original Passkey keys/credential IDs and counter policy are preserved. Incomplete projections explicitly block scanning so omitted content cannot become deletions.
- Local-item synchronization retains exact source archives (JSON, binary encodings, unknown formats and historical versions). Archives stay encrypted and never create remote connections or activate credentials automatically.

### Android 1.0.320 field alignment

- Aligned address name parts, third address line, district, home/work contacts and cardholder name parts. Full names are never derived from name parts, and default contacts never replace missing home/work contacts.
- Preserved the fields through local saves, imports, Android backups, MDBX, KDBX and Bitwarden codecs. Web filling supports the independent fields, country/expiry selects and multiline addresses, skipping ambiguous or duplicated matches.

### UI and performance

- Removed display grouping, stack management and cover controls; password projects are flat, with Login and All items sharing compact cards. Removed the timeline page, navigation entry and background read API, plus the separate API-key sidebar entry; existing API Token records remain manageable under All items.
- Fixed UI freezes with large vaults: the longest main-thread block when opening the OTP page dropped from about 3.1 s to about 0.37 s, with smoother lists, search and details. See [PERFORMANCE.md](../PERFORMANCE.md).

### Build and CI

- Fixed Linux CI: hash-pinned fixtures check out with CRLF, CodeQL builds the browser engine first, Windows Hello tests/scripts are platform-aware, the Popup probe selects its asserted language, drifted e2e tests are updated, and missing-Edge acceptance tests skip with a reason. This beta does not claim Edge acceptance.

### Known limitations

- Chrome 128+ only. Firefox requires event pages, sidePanel/offscreen/favicon replacements, a separate OAuth callback and a signed XPI, and is not supported; Edge is not accepted in this release.
- Real OneDrive sign-in, refresh and file read/write are unverified; external accounts may need publisher verification or admin consent.
- Real-phone first sync, Android automatic sync/multicast discovery, F-Droid acceptance, some native archives/folder profiles and cross-backend conflict merging remain unfinished.
- This beta does not claim the complete stable-release gate. See the [release verification record](../verification/release-0.1.46.md) for the exact scope.

### Install and feedback

Download `monica-extension-0.1.46.zip`, extract it, enable Developer mode at `chrome://extensions`, and choose “Load unpacked” pointing at the extracted directory. Existing users should export a backup first and restore it under the new ID before removing the old entry.

The download list contains only the extension ZIP and its SHA-256 checksum. Dependency and license inventories and source-commit evidence remain embedded in the ZIP. Report bugs with version, browser, backend and reproduction steps; never upload real passwords, private keys or vaults. Report security issues privately following [SECURITY.md](https://github.com/Monica-Pass/Monica-for-Extension/blob/main/SECURITY.md).
