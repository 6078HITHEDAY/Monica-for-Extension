# Monica Extension — 下一版 / Next release

> 0.1.39 已归档至[发行说明](releases/Monica-Extension-0.1.39.md)和[验证记录](verification/release-0.1.39.md)。已发布历史保持原样。

## 中文

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

Wi-Fi 完整收尾仍在进行：部分原生归档与文件夹配置、Android 两版文件夹／根目录附件收发，以及 F-Droid、Android 界面与组播发现验收尚未完成。插件优先兼容 Android 现有协议；本次文件夹修复不要求 Android 修改。完整 Android 对齐还包含跨后端冲突、恢复与真实 OneDrive 验收。本记录不表示已发布。

## English

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

Wi-Fi closeout remains in progress: some native archives/profiles, folder/root byte adoption in both Android editions, F-Droid acceptance, and Android UI/multicast discovery are unfinished. The extension follows Android's existing protocol; this folder fix requires no Android changes. Full Android parity also requires cross-backend conflict/recovery and real OneDrive acceptance. These changes have not been published.
