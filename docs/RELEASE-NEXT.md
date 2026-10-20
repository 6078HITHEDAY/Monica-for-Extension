# Monica Extension — 下一版 / Next release

> 0.1.39 已归档至[发行说明](releases/Monica-Extension-0.1.39.md)和[验证记录](verification/release-0.1.39.md)。已发布历史保持原样。

## 中文

- 修复 Bitwarden 实时通知连接直接使用旧令牌的问题：连接前先验证并按需刷新会话，保留加密保存与账号校验；锁定或关闭同步会取消进行中的认证，连接失败仍通过定时同步补齐更新。

- 插件移除显示分组、管理堆叠和封面操作，各密码项目直接平铺。登录项与全部项目复用同一列表样式，收紧卡片高度和垂直留白；已有项目内的账号、密码及 Android 分组元数据保持完整。

- 移除时间线页面、侧栏入口及后台读取接口，保留 Android 备份原有内容。移除侧栏独立的 API 密钥入口；密码项目中的 API 密钥类型继续可用，已有原生 API Token 记录仍可在“全部项目”中管理。

- 整合 PR #13 与本地 Wi-Fi 开发改动，保留单一设置入口、MDBX 接收恢复与性能优化。补齐 Windows 通信组件配置下载、二维码／链接切换，移除手填 IP。配对成功不再误报同步完成；只有对方确认保存后才更新同步时间并弹出结果，显示本机实际保存／删除的项目及数量，不显示密码。对方保存失败或超时会明确报错。详见[合并验证](verification/pr13-integration-2026-10-17.md)；真实手机首次同步仍待复测，Android 自动同步所需 mDNS 在线广播尚未接入。

- 修复大型密码库的界面卡顿：打开动态验证码页的最长主线程阻塞从约 3.1 秒降至约 0.37 秒，列表、搜索与详情也更流畅。详见 [PERFORMANCE.md](PERFORMANCE.md)。
- 修复 Linux 上的 CI：固定哈希的测试夹具按 CRLF 检出、CodeQL 先构建浏览器引擎、Windows Hello 测试与脚本按平台判断、Popup 探针显式选择语言；更新与当前界面不符的 e2e 用例；需要 Windows Edge 的验收用例在缺少 Edge 时跳过并注明原因，另以 `npm run test:e2e:edge` 严格运行。
- 修复与 Android 的 Wi-Fi 同步：遵循 Android 的设备 ID 角色规则，在对方监听时由浏览器发现并主动连接，避免双方同时等待；记住对方地址用于单播探测；保留真实错误代码；本机助手按 Android 格式广播同步请求与设置版本。详见 [nearby-wifi-sync-321.md](nearby-wifi-sync-321.md)。

Wi-Fi 首轮范围于 2026-10-16 冻结，保留[当时的阶段记录](verification/wifi-stage-closeout-2026-10-16.md)。其后另行授权的 Android 1.0.320 资料字段对齐已完成[定向验收](verification/wallet-fields-320-2026-10-16.md)，本轮 Wi-Fi 中断接收的受限继续处理也已完成[验证](verification/wifi-recovery-continuation-2026-10-16.md)。以下均为尚未发布的开发改动。

- 对齐 Android 新增的地址姓名分段、地址第三行、区/县、家庭及工作联系方式，以及银行卡持卡人姓名分段。沿用现有补充信息编辑入口，并分别展示详情；完整姓名与姓名分段独立保存，家庭／工作联系方式不使用默认联系方式代填。
- 补齐这些字段的本机保存、导入、Android 备份、MDBX、KDBX 和 Bitwarden 编解码。Bitwarden 自定义字段名称和值均加密，避免重复展示；旧记录缺少完整姓名字段时保留本机原值，明确清空时正常同步清空。KDBX 银行卡账单地址沿用 Android 的文本表示，保留第三行与区/县内容。
- 网页填充支持对应的独立字段、国家与有效期下拉框，以及地址多行格式。按聚焦表单、分组及收货／账单用途限制填充，识别家庭／工作联系人；含义不明或重复匹配时跳过。电话号码区号／本地号的细分仅在可明确解析的美国、加拿大号码中提供，其他号码不猜测；动态新增控件可再次主动填充。

- 新增 Wi-Fi 接收冲突的检查与确认入口：当本机只修改已有条目的标题／内容，剩余步骤仅涉及受支持的文件夹、标签及新建文件夹／根目录附件时，核实互不覆盖后可选择“保留本机修改并继续”。检查无需另一台设备在线；确认前再次核对数据库版本，确认记录先加密保存，保存后丢失响应或重启仍按原操作恢复。历史不完整、多设备历史、重叠修改、旧日志缺少完整内容或超出检查上限时继续保留冲突，不自动覆盖或丢弃。此次未改变 Passkey 密钥、凭据 ID 和计数策略。
- 新增 Wi-Fi 未完成接收的状态与离线恢复入口：无需另一台设备在线，只核对并重试原来的保存操作。新建接收日志会将已完成步骤的内容及附件副本一起加密保留到整笔完成；旧日志明确提示保留范围。遇到新的本机修改会显示冲突并停止，取消、锁定和重启不会丢弃待恢复记录；仅上项已核实的情况可显式确认继续，其他冲突暂不支持合并。
- 补齐较大文件夹配置与附件组合的 Wi-Fi 分步接收和重启恢复：先加密保存待处理步骤，全部完成后才确认同步成功。中断或丢失响应不会重复创建内容；其他修改不会被当作恢复依据覆盖。待恢复期间阻止同一 MDBX 的普通修改和云同步，永久删除也保留各来源附件的独立归属。当前已验证 1 MiB 配置与独立 1 MiB 附件组合；更大的单文件和通用冲突处理留待后续。
- 补齐 Wi-Fi 文件夹配置的二进制归档、本机库中转与 MDBX 原子恢复，保留收藏、归档、图标和来源信息。原始字节通过现有附件通道传输，不挤入 JSON；每次发送重新检查权限和数据库版本。来自其他密码库的根目录配置独立保存，删除一方不会修改另一方或目标全局配置。含配置的独立记录会在暂存前分批；要求额外能力或超出当前恢复预算的内容仍明确停止，不能静默降级。
- 修复 MDBX 扫描可能遗漏第一版原生文件夹配置的问题，补充完整读取与安全写回。保持原生类型、能力、现有对象与 Tiga 限制，失败完整回滚，重启重试不会重复写入。Android 已保存但未应用的配置与附件继续保留；已应用配置的真实本地修改可以回传，原生新生成的时间和提交信息不再造成虚假跨端修改。
- 修复大量嵌套文件夹跨批次同步的顺序：先恢复父目录，再恢复子项；先删除或移出子项，再删除父目录。密码关联项目保持完整，仍遵守每批写入上限。修复密码缺省字段在本机库／MDBX 往返时产生虚假修改、冲突副本与重复写入的问题；单纯移入回收站或恢复不再重写未变的内容，接收规划复用已核对版本的扫描结果。
- 补齐插件内置 MDBX 文件夹携带附件移入回收站、恢复和永久删除状态同步，保留回收站附件原身份与内容。经本地库中转再次同步、重启后仍可恢复读取；永久删除仅清理该文件夹所属内容。仍有活动子项、父文件夹未恢复或引擎版本不支持时，在保存写入事务前停止。
- 补齐浏览器端未分配标签及文件夹／根目录附件的 Wi-Fi 收发、替换和再次转发，保留文件身份、精确 JSON 与未知附加字段。来自不同密码库的根目录内容分别归属，删除一方不会修改另一方。重复附件身份、无效标签内容和内部所有权标记会在写入前拒绝。
- 新增 Wi-Fi 同步设置页，支持选择本机或 MDBX 密码库、邀请文本／二维码配对、查找已配对设备、同步方向、页面打开时自动同步、状态显示和取消。配对只建立信任，实际传输另行开始；Passkey 跨端限制需要明确确认。局域网通信需要本机通信组件，MDBX 数据库本身已内置。
- 接通 MDBX 收发与加密事务恢复：保存原始操作、内容及附件后再写入，重启恢复原回执不会覆盖后续修改。重复同步不重复写入。修复两端同时等待连接时，取消监听尚未完成就释放会话导致的连接失败。
- 补齐 MDBX 回收站内容及附件同步、删除后恢复与首次接收永久删除状态；普通读取仍受原有删除状态和安全策略限制。修复回收站条目收到新附件时仍保留旧文件的问题。原生接收按完整关联项目及实际写入限制分批，移除固定 32 条限制；旧版文件夹名称和未知附加字段也会保留。
- 已用当前普通版 Android 完成真实局域网双向验证：插件创建的 Passkey 在 Android 端使用原密钥验签成功、零计数不变，密码编辑可以回传。该验证使用隔离合成数据，覆盖真实同步提供方、加密存储和 JNI 传输。
- MDBX 原生目录、文件夹／根标签、密码项目、标签、关系和附件采用完整目录及版本检查，支持整笔接收、带附件移动和保留附件身份的替换；保留数值精度、Passkey 原密钥、凭据 ID 与零计数／已有正计数历史。修复重名文件夹旧标记导致名称回退，以及附件初始大小与当前大小不同造成的误判。无法完整处理的内容会明确阻止扫描，避免遗漏被误认成删除。
- 修复 MDBX 后台文档误断开 Wi-Fi 管理端口，以及旧版原生对象 UUID 被误当作会话句柄而拒绝的问题；会话与操作句柄仍使用原有严格校验。取消后的旧操作不再改变新连接状态。
- 本机项目同步保留原始来源归档，包括精确 JSON、二进制编码、未知格式和历史版本；接收、编辑、重启、便携备份恢复及再次复制均保留原文。归档保持加密，不自动创建远端连接或启用凭据。
- 固定扩展 ID：manifest 加入公钥，不上架商店时从任意本地目录“加载已解压”都得到同一 ID `lebnfedmijifofonogjdphpojihgohmc`，OneDrive SPA 回调与原生通信宿主可按此 ID 一次登记。旧的路径派生 ID 会被替换，升级前需先导出备份，并在新 ID 下恢复。

后续待办：部分原生归档与文件夹配置、Android 两版文件夹／根目录附件收发，以及 F-Droid、Android 界面与组播发现验收尚未完成。插件优先兼容 Android 现有协议；本次文件夹修复不要求 Android 修改。完整 Android 对齐还包含跨后端冲突、恢复与真实 OneDrive 验收。这些未完成内容不计入本次阶段完成范围，本记录不表示已发布。

## English

- Fixed Bitwarden notification connections using stale tokens. Connections now validate and refresh the session before the WebSocket handshake, with encrypted token persistence and account checks. Locking or disabling sync cancels pending authentication; polling remains available when notification connections fail.

- Removed display grouping, stack management and cover controls from the extension. Password projects now appear in a flat list, with Login and All items sharing the same more compact cards. Accounts, passwords within projects and existing Android grouping metadata remain intact.

- Removed the timeline page, navigation entry and background read API while preserving existing Android backup contents. Removed the separate API-key sidebar entry; API-key password projects remain available, and existing native API Token records can still be managed under All items.

- Integrated PR #13 with local Wi-Fi development, retaining one settings entry, MDBX receive recovery and performance improvements. Added Windows communication-helper setup downloads and usable QR/link switching without manual IP entry. Pairing no longer claims a completed sync; timestamps and the result dialog require the peer save receipt. Results show actual local saved/deleted items and counts without passwords, and rejected/timed-out peer saves report failure. See [integration verification](verification/pr13-integration-2026-10-17.md). The reported first-sync failure on the user’s phone still needs retesting; Android automatic-sync mDNS presence is not implemented.

- Fixed UI freezes with large vaults: the longest main-thread block when opening the OTP page dropped from about 3.1 s to about 0.37 s; lists, search and details are smoother too. See [PERFORMANCE.md](PERFORMANCE.md).
- Fixed Linux CI: the hash-pinned fixture checks out with CRLF, CodeQL builds the browser engine first, Windows Hello tests/scripts are platform-aware and the Popup probe selects its asserted language; e2e tests that drifted from the current UI are updated; Windows-Edge acceptance tests skip with a reason where Edge is absent and run strictly via `npm run test:e2e:edge`.
- Fixed Wi-Fi sync with Android: follow Android's device-ID role rule so the browser discovers and dials a listening phone instead of both sides waiting; remember the peer address for unicast probes; keep real error codes; the Host advertises sync requests and settings versions in Android's format. See [nearby-wifi-sync-321.md](nearby-wifi-sync-321.md).

The first Wi-Fi stage was frozen on 2026-10-16; its [historical closeout](verification/wifi-stage-closeout-2026-10-16.md) is retained. Separately authorized Android 1.0.320 profile-field alignment passed [targeted acceptance](verification/wallet-fields-320-2026-10-16.md), followed by [verified bounded continuation](verification/wifi-recovery-continuation-2026-10-16.md) for interrupted Wi-Fi receives. All changes below remain unpublished.

- Aligned address name parts, third address line, district, home/work contacts and cardholder name parts with Android. Existing additional-content editors and separate detail labels preserve independent values: full names are never derived from name parts, and default contacts never replace missing home/work contacts.
- Preserved these fields through local saves, imports, Android backups, MDBX, KDBX and Bitwarden codecs. Bitwarden custom-field names and values are encrypted and managed duplicates are filtered. A missing legacy full-name field preserves the existing local value; an explicitly empty field clears it. Card billing addresses in KDBX retain Android's text representation, including third-line and district contents.
- Web filling supports the independent fields, country/expiry selects and multiline addresses. Focused forms, sections, shipping/billing purposes and contact qualifiers constrain filling; ambiguous matches are skipped. Area/local phone-number splitting is limited to unambiguous US/Canadian numbers, without guessing other countries' varying formats. Dynamically added controls can be filled by another explicit invocation.

- Added explicit review and confirmation for interrupted Wi-Fi receives. When local changes only update existing entry titles/payloads and remaining steps contain supported folder/label changes or new folder/root attachments, proven non-overlap enables “Keep local changes and continue”. Review works offline, confirmation rechecks the database revision, and approval is encrypted before writing so lost replies and restart replay the persisted operation. Incomplete or multi-device history, overlapping changes, older journals without complete inputs and exceeded review bounds remain blocked with their data retained. Passkey keys, credential IDs and counter policy are unchanged.
- Added an unfinished-receive view and offline Wi-Fi recovery: the other device may be offline while the extension verifies and retries the original save operations. New receive journals retain completed inputs and attachment copies, encrypted until the whole receive finishes; older journals disclose their limited retention. Intervening local edits stop recovery with an explicit conflict, and cancellation, locking and restart retain the pending journal. Only the verified cases above allow explicit continuation; other conflicts cannot yet be merged.
- Added resumable Wi-Fi adoption for larger collection-profile/file combinations. Pending steps are encrypted before writing, and synchronization is acknowledged only after all steps complete. Interrupted or lost replies retain exact operations without duplicating content; intervening edits cannot be silently accepted as a recovery baseline. Ordinary mutations and cloud sync for the same MDBX wait for recovery, and purge retains source-specific attachment ownership. A 1 MiB profile plus a separate 1 MiB file is verified; larger individual files and general conflict resolution are deferred.
- Added binary Wi-Fi collection-profile archives, local-vault forwarding and atomic MDBX restoration, including favorites, archive state, icons and provenance. Original bytes use the existing asset channel; each outgoing read rechecks native policy and revision. Foreign root profiles remain independently owned and cannot overwrite the shared target root. Independent records containing profiles are batched separately before staging; profiles requiring additional capabilities or unsupported restoration budgets still stop explicitly without silently weakening restrictions.
- Fixed native scans overlooking schema-1 profiles and added complete reads and safe writes. Native type, capability, existing-object and Tiga restrictions remain enforced, with atomic rollback and durable retry receipts. Unapplied metadata/file archives retained by Android remain intact. Real local edits to applied profiles propagate, while regenerated native timestamps and commits do not manufacture cross-device edits.
- Fixed nested-folder ordering across bounded sync batches: restore parents before descendants, and delete or move descendants before deleting their former parents. Password dependency groups remain whole within write limits. Fixed default password fields generating false edits, conflict copies and repeated writes during local-vault/MDBX round trips. Pure trash/restore transitions no longer rewrite unchanged content; incoming planning reuses a scan only after checking its native revision.
- Added retained folder trash, restoration and purge synchronization in the bundled MDBX engine. Trash preserves attachment identity and bytes through local-vault forwarding and restart; purge affects only the owning folder. Active children, unrestored parents and unsupported engine versions are rejected before persisting a write intent.
- Added browser-side Wi-Fi adoption and forwarding of unassigned labels and folder/root attachments, including replacements with preserved file identities, exact JSON and unknown fields. Root contents remain isolated by source vault. Duplicate attachment identities, invalid label payloads and injected internal ownership markers are rejected before writing.
- Added Wi-Fi sync settings for local and MDBX vaults, invitation text/QR pairing, saved-device discovery, transfer direction, automatic sync while the page is open, status and cancellation. Pairing establishes trust before a separate transfer. Passkey portability restrictions require explicit review. LAN networking uses the local communication helper; MDBX storage is bundled.
- Connected native MDBX send/receive with encrypted operation recovery. The exact operation, content and assets are saved before writing; recovery after restart retrieves the original receipt without overwriting later edits. Repeated sync performs no duplicate writes. Fixed simultaneous listeners attempting to release a native session before cancellation had completed.
- Added retained MDBX trash/content/attachment synchronization, restoration and first-seen purge persistence while preserving ordinary deleted-content denial and security policies. Fixed incoming trash attachment replacements retaining stale local files. Native batches follow complete dependency groups and actual write limits instead of a fixed 32-record cutoff. Legacy folder names and unknown additional wire fields are retained.
- Verified real bidirectional LAN exchange with current ordinary Android: a browser-created Passkey signs with its original key on Android, counter zero is preserved, and password edits return to the browser. Isolated synthetic data exercised the real sync provider, encrypted storage and JNI transport.
- Native catalogs, folder/root tags, password records, labels, relations and attachments use complete inventories and revision checks with atomic adoption, attachment moves and identity-preserving replacements. Numeric precision, original Passkey keys/credential IDs and zero or existing positive counter history are preserved. Fixed stale folder-name markers and attachment replacement size mismatches. Incomplete projections explicitly block scanning so omitted content cannot become deletions.
- Fixed the MDBX offscreen document disconnecting unrelated Wi-Fi manager ports and historical native object UUIDs being rejected as session handles. Runtime session/operation handles keep strict validation. Cancelled operations cannot change a subsequent connection's state.
- Local-item synchronization retains exact source archives, including JSON, binary-encoded data, unknown formats and historical versions through adoption, edits, restart, portable-backup restore and subsequent copies. Archives stay encrypted and never automatically create remote connections or activate credentials.
- Pinned the extension ID by adding the public key to the manifest, so loading the unpacked build from any local directory without a store yields the same ID `lebnfedmijifofonogjdphpojihgohmc`; the OneDrive SPA redirect and native messaging hosts can be registered once for it. The previous path-derived ID is replaced, so export a backup before upgrading and restore it under the new ID.

Deferred work: some native archives/profiles, folder/root byte adoption in both Android editions, F-Droid acceptance, and Android UI/multicast discovery are unfinished. The extension follows Android's existing protocol; this folder fix requires no Android changes. Full Android parity also requires cross-backend conflict/recovery and real OneDrive acceptance. These unfinished items are not counted as completed by this stage. These changes have not been published.
