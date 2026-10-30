# Monica for Extension 1.0.101 — 首个正式版 / First stable release

2026-10-21 · 标签 / Tag: `v1.0.101`

> 0.1.48 preview-beta 改动已归档至[发行说明](Monica-Extension-0.1.48.md)及[验证记录](../verification/release-0.1.48.md)。0.1.47 及更早历史记录保持原样。 / The 0.1.48 preview-beta is archived; 0.1.47 and earlier records are unchanged.

## 中文

这是 Monica 浏览器插件的首个正式版本，承接 0.1.x 预览版。提供加密本地密码库、网页账号和验证码填充、密码保存、Passkey、内置 MDBX、KeePass、WebDAV 与 Bitwarden 密码源，以及密码、笔记、验证码和卡包管理。支持 Chrome/Edge 128+；本轮浏览器验收使用隔离 Edge。

- 多选操作栏固定悬浮在窗口底部，按当前内容区居中并跟随所选配色；窄屏和大字体自动换行，矮窗口内可滚动访问全部操作。列表与分页末尾按操作栏实际高度预留空间，最后一项不会被遮挡；退出多选后恢复底部导航。

- 暂时隐藏支付方式（支付账号）的新建入口和卡包类型切换选项；筛选已有支付账号时，新建按钮也不再创建该类型。已有记录仍可查看、编辑、筛选与同步。

- 修复侧栏模式和窄屏导航抽屉中关闭按钮挤到 Monica 标题旁、与文字重叠的问题；关闭按钮独占头部右侧，矮窗口滚动时也保持可见和可点击。

- 新建编辑器按 Android 分组切换：凭据组包含密码、API Key、Wi-Fi、SSH 密钥、条码、原生 API 令牌与 GPG 密钥；卡包组包含银行卡、证件、账单地址、会员卡、积分卡与旅行票证。安全笔记、独立验证码不再混入卡包菜单。银行卡的借记卡／信用卡／预付卡选择移到主要信息区，新卡默认借记卡；既有卡片保留原类型。卡包与原生令牌切换保留各自未保存的草稿，原生令牌保持专用数据格式。

- 修复卡包多张卡面同时读取时随机出现“附件读取失败”、刷新后换一批图片消失的问题。图片读取排队并在后台忙碌时等待空闲名额，取消和切换页面会释放资源；兼容 Android 同步附件缺少媒体类型的图片，按 PNG/JPEG/GIF/WebP 文件内容安全识别，详情预览同步修复。

- 新增 Firefox 桌面版构建（153+），适配侧栏、内置 MDBX 后台引擎、原生页面身份检查、本机助手与 CLI 注册，以及 OneDrive 精确回调地址。版本保持 1.0.101；本地测试包未签名，永久安装需 Mozilla 签名，真实云授权与硬件验证仍需单独验收。见 [Firefox 使用说明](../FIREFOX.md)。

- 扩展版本命名切换至 `1.0.101`；版本配置、锁文件与浏览器清单保持一致，构建时检查三段数字版本。设置新增 GitHub 更新检测，手动检查正式发布，发现新版显示提示及发布页入口；单独提示无发布、限流、超时和连接失败，不自动下载安装。

- 项目列表及钱包、验证码卡片支持鼠标长按或右键进入多选，也可点击「多选」。支持全选当前页、批量收藏／取消收藏、传输与移到回收站；删除前确认项目及实际记录数量，完整密码项目一起处理，并在数据并发变化时拒绝整批修改。最多选择 200 个项目，按 Esc 退出。

- 明文 JSON 与加密整库备份导出均需重新验证主密码或已绑定的 Windows Hello；后台校验会话和库版本，拒绝旧接口绕过认证。四字符主密码下限保持不变。
- 新增可选剪贴板自动清理，默认关闭，开启时按需申请读取与写入权限。支持 30 秒、1 / 2 / 5 分钟；锁库时提前尝试清理，只处理仍与上次复制一致的内容。
- 备份页新增容量提示与最多三份加密本机恢复检查点；历史副本导出同样重新认证，不自动回滚当前库。更新保护方式清理旧副本，空间不足时优先保存当前库。
- 新增运行诊断与同版本构建校验，支持下载仅含白名单状态的脱敏报告；补充设备密钥、同步运行条件和接收冲突的处理说明。

- 附近设备手动同步在手机尚未准备好时保留连接请求，最多等待两分钟并可随时取消；连接建立阶段遇到手机监听入口变化会重新发现并重试，身份验证、内容校验及保存失败仍立即停止，不重复保存或确认。

- 优化网页账号菜单选中后的密码填充：仅复制所选账号及绑定验证码，减少大密码库的整库复制与序列化开销，并保留填充前的库变更校验。

- CLI 联动默认关闭，在「设置与备份 → 通用」开启后才显示侧栏「CLI 内容管理」入口，并标注「不完善」；关闭时退出已打开的管理页。Passkey 主密码验证窗口跟随所选配色与明暗模式，并精简为单层表单和输入框。

- 新增「CLI 内容管理」，通过本机 Native Messaging 管理 CLI 已保存数据库、目录、密码字段、GitHub/GitLab 连接和 AI 授权撤销。需安装配套 CLI 联动组件；主密码不存入浏览器，已有秘密字段不导出到扩展，并发编辑拒绝覆盖。

- Passkey 登录弹窗新增「使用 Windows/浏览器验证器」，Monica 锁定时也可直接切换。系统可提供 Windows Hello、手机扫码或安全密钥等选项，具体取决于浏览器、系统与网站；切换不使用 Monica 私钥，也不更新其使用记录。
- 附近同步默认只发送新增和修改；导出时过滤删除记录，覆盖旧版清空回收站、漏扫项目与副本已有删除记录的情况。发现历史删除时，询问「跳过删除，继续同步」「本次包含删除」或「取消同步」；包含删除只对本次生效。需同时更新本机通信组件，旧助手会停止发送并提示更新。
- 修复附近同步接收到恢复记录时，MDBX 本地回收站项目可能显示同步完成却未恢复的问题；写入实际数据库后才确认采纳。
- 对齐 Android 1.0.321 的七种网址匹配规则，新增默认和主机匹配编辑，保留原始规则及未知元数据；不支持的规则停止自动填充推荐，避免扩大匹配范围。正则匹配仅支持安全子集。
- 新增会员卡、积分卡与旅行票证模板的编辑、查看和复制，保留前导零、时区文本、未知模板及附加字段；同步和备份支持对应卡包数据。
- 新建菜单将条码归入“账号与安全”，在“钱包与其他”提供会员卡、积分卡和旅行票证的直接入口，自动选中对应模板；完整类型选择器同步更新。
- 凭据组新增独立备注，组内密码共享此备注，项目备注与其他凭据组备注各自保留；Android 备份、本地数据库、Bitwarden 和附近同步保留这些扩展字段。

完整 Android 对齐仍在开发：真实手机首次同步与自动调度、mDNS 多播发现、部分原生归档与文件夹配置、Android 两版文件夹／根目录附件收发、F-Droid 与 Android 界面验收、跨后端冲突与恢复，以及真实 OneDrive 登录验收。这些未完成内容不计入本次完成范围。


**安装与升级**

- 下载 `monica-extension-1.0.101.zip`，解压到固定目录，在 `edge://extensions` 或 `chrome://extensions` 开启开发者模式并加载该目录。不要从临时目录或随后会删除的解压目录加载。
- 从预览版升级时保留原加载路径与扩展 ID `lebnfedmijifofonogjdphpojihgohmc`，覆盖文件后重新加载；无需移除扩展或重新导入密码库。
- Windows x64 附近同步所用通信组件已随插件 ZIP 内置，可在同步设置中下载和安装。已安装旧版的用户也需要更新。可选独立助手 `monica-mdbx2-host-windows-x64-0.1.4.zip` 同时提供本机 MDBX 和 Windows Hello 通信；两种安装方式复用同一程序，无需都安装。独立助手解压后按说明运行 `install-host.ps1`，指定自己的浏览器扩展 ID。
- CLI 联动默认关闭并标注“不完善”，配套 CLI 辅助程序由 CLI 项目提供。本次不发布未签名 Firefox XPI，也不代表浏览器商店已上架。
- 插件和独立助手均附 SHA-256 校验文件；依赖、许可证与源码提交证据包含在 ZIP 中。

## English

The first stable Monica browser-extension release follows the 0.1.x previews. It includes an encrypted local vault, webpage login/OTP filling, password saving, Passkeys, bundled MDBX, KeePass, WebDAV and Bitwarden sources, and password/note/authenticator/card-wallet management. Chrome/Edge 128+ are supported; this release uses isolated Edge for browser acceptance.


- Keep batch-selection actions floating at the bottom of the viewport, centered on the content area and using the selected palette. Actions wrap for narrow layouts and large text and scroll within short windows. Measured clearance after the list and pagination keeps the final item unobscured; exiting selection restores bottom navigation.

- Temporarily hide payment-account creation and wallet type-switch options, including primary create actions while legacy payment records are filtered. Existing records remain viewable, editable, filterable and compatible with synchronization.

- Fix the navigation drawer close button overlapping the Monica wordmark in sidebar and narrow layouts. Reserve its own column at the header's right edge and keep it reachable when short windows scroll.

- Match Android's create-editor groups: credentials switch among passwords, API Key, Wi-Fi, SSH keys, barcodes, native API tokens and GPG keys; wallets switch among bank cards, identities, billing addresses, membership/rewards/travel passes. Standalone notes and OTP records no longer appear in wallet switches. Move debit/credit/prepaid selection into the main bank-card fields, defaulting new cards to debit while preserving existing types. Wallet and native-token switching retain separate unsaved drafts; tokens keep their native data format.

- Fix card artwork randomly failing to load or disappearing after refresh when many cards are visible. Queue verified attachment reads and wait for explicit backend capacity rejections; cancellation and navigation release resources. Detect PNG/JPEG/GIF/WebP content safely when Android-synced attachments lack MIME metadata, including detail previews.

- Add Firefox desktop builds (153+), including sidebar, the bundled MDBX background engine, native document identity checks, native helper/CLI registration and the exact OneDrive redirect. Version remains 1.0.101. Local builds are unsigned; permanent installation requires Mozilla signing. Live cloud authorization and hardware authentication require separate acceptance. See the [Firefox guide](../FIREFOX.md).

- Extension version numbering now starts at `1.0.101`, with matching package, lockfile and browser manifest versions checked during builds. Settings can manually check stable GitHub releases and show a newer-version notice and release-page link, with distinct no-release, rate-limit, timeout and connection-failure states. Updates are downloaded and installed manually.

- Hold or right-click an item to enter multi-selection in lists and wallet/OTP tiles, or use Select items. Select the current page, favorite/unfavorite, transfer or move to trash. Trash confirmation shows item and record counts; credential projects are handled together and concurrent changes reject the entire mutation. Select up to 200 items and press Escape to exit.

- Creation menus group barcodes under Account & security and offer direct Membership card, Rewards card and Travel pass actions under Wallet & other, with the selected template ready to edit in both menu and full-picker flows.
- Plaintext JSON and encrypted full-vault exports now require fresh master-password or enrolled Windows Hello authentication, with backend session/envelope checks and legacy-route denial. The four-character minimum is unchanged.
- Optional clipboard expiry is off by default and requests clipboard permissions only when enabled. Choose 30 seconds or 1 / 2 / 5 minutes; locking triggers early best-effort cleanup, preserving subsequently copied text.
- Backup settings show vault capacity and up to three encrypted local recovery checkpoints. Exporting a checkpoint requires fresh authentication and never automatically rolls back the current vault. Protection changes clear old checkpoints; low storage prioritizes the current vault.
- Runtime diagnostics export only whitelisted status fields. Build identities detect mismatched page/background builds sharing a version number. Protection, sync lifecycle and receive-conflict guidance are clearer.

- Manual nearby sync now waits up to two minutes for the paired phone to become ready and remains cancellable. Setup-only connection failures rediscover a replaced listener; authentication, content validation and save failures still stop immediately without replaying saves or acknowledgements.

- Speed up password filling after selecting an account in the webpage menu by copying only the selected login and its bound OTP, reducing whole-vault copying and serialization while retaining the final vault-change check.

- Keep CLI integration off by default. Enable it under Settings and backup → General to show its sidebar entry, marked “Incomplete”; disabling it closes any open management view. The Passkey password verification window follows the selected palette and color scheme, with a simpler form and a single input surface.

- Add CLI content management through local Native Messaging: saved databases, folders, selective password edits, GitHub/GitLab connections and AI grant revocation. Requires the matching CLI helper. Master passwords are not stored in the browser, existing secret fields are not exported, and stale edits cannot overwrite newer content.

- Add “Use Windows/browser authenticator” to Passkey sign-in, including while Monica is locked. The system can offer Windows Hello, phone scanning or security keys depending on the browser, system and website. Switching does not use Monica's private key or update its usage history.
- Nearby sync sends additions and edits by default and filters deletions during export, including records left by older trash purges or missed scans. Historical deletions require a choice: skip and continue, include for this transfer, or cancel. Update the local communication component as well; older helpers stop sending and request an update.
- Fix nearby sync reporting completion while an incoming restored item remains in the local MDBX trash. Acknowledge adoption only after writing the actual database.
- Align with Android 1.0.321's seven URL matching modes, including default and host editing, while preserving raw rules and unknown metadata. Unsupported rules disable autofill recommendations instead of broadening matches. Regular expressions use a restricted safe subset.
- Add membership, rewards and travel pass templates with editing, viewing and copying. Preserve leading zeros, timezone text, unknown templates and additional fields through sync and backup.
- Add independent credential group notes shared by passwords in that group, preserving project notes and other groups' notes. Android backups, local databases, Bitwarden and nearby sync retain the new fields.

Full Android parity remains in development: real-phone first sync and automatic scheduling, mDNS discovery, some native archives/folder profiles, folder/root attachment exchange in both Android editions, F-Droid/Android UI acceptance, cross-backend conflict/recovery, and real OneDrive sign-in acceptance. These unfinished items are not counted as completed by this stage.

**Install and upgrade**

- Download and extract `monica-extension-1.0.101.zip` to a permanent directory. Enable Developer mode at `edge://extensions` or `chrome://extensions` and load that directory. Keep the directory in place.
- When upgrading from a preview, retain the original path and extension ID `lebnfedmijifofonogjdphpojihgohmc`, replace its files, then reload. Do not remove the extension or reimport your vault.
- The Windows x64 Wi-Fi component is bundled inside the extension ZIP and available from Nearby Sync settings. Existing helper installations must also be updated. The optional standalone `monica-mdbx2-host-windows-x64-0.1.4.zip` adds native MDBX and Windows Hello communication using the same executable; both installations are not required. Extract it and follow its README to run `install-host.ps1` for your browser extension ID.
- CLI integration remains off by default and marked incomplete; its helper is distributed by the CLI project. Unsigned Firefox XPI distribution and browser store publication are outside this release.
- Both ZIP downloads include SHA-256 checksum files. Dependency/license inventories and source-commit evidence are embedded in the archives.
