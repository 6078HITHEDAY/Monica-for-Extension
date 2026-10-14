# Monica Extension — 下一版 / Next release

> 0.1.39 已归档至[发行说明](releases/Monica-Extension-0.1.39.md)和[验证记录](verification/release-0.1.39.md)。已发布历史保持原样。

## 中文

- 新增 Wi-Fi 同步设置页，支持选择本机或 MDBX 密码库、邀请文本／二维码配对、查找已配对设备、同步方向、页面打开时自动同步、状态显示和取消。配对只建立信任，实际传输另行开始；Passkey 跨端限制需要明确确认。局域网通信需要本机通信组件，MDBX 数据库本身已内置。
- 接通 MDBX 收发与加密事务恢复：保存原始操作、内容及附件后再写入，重启恢复原回执不会覆盖后续修改。重复同步不重复写入。修复两端同时等待连接时，取消监听尚未完成就释放会话导致的连接失败。
- MDBX 原生目录、文件夹／根标签、密码项目、标签、关系和附件采用完整目录及版本检查，支持整笔接收、带附件移动和保留附件身份的替换；保留数值精度、Passkey 原密钥、凭据 ID 与零计数／已有正计数历史。修复重名文件夹旧标记导致名称回退，以及附件初始大小与当前大小不同造成的误判。无法完整处理的内容会明确阻止扫描，避免遗漏被误认成删除。
- 修复 MDBX 后台文档误断开 Wi-Fi 管理端口，以及旧版原生对象 UUID 被误当作会话句柄而拒绝的问题；会话与操作句柄仍使用原有严格校验。取消后的旧操作不再改变新连接状态。
- 本机项目同步保留原始来源归档，包括精确 JSON、二进制编码、未知格式和历史版本；接收、编辑、重启、便携备份恢复及再次复制均保留原文。归档保持加密，不自动创建远端连接或启用凭据。

Wi-Fi 完整收尾仍在进行：原生回收站内容、部分原生归档及文件夹附件／配置，以及当前 Android/F-Droid 双向应用验收尚未完成。完整 Android 对齐还包含跨后端冲突、恢复与真实 OneDrive 验收。本记录不表示已发布。

## English

- Added Wi-Fi sync settings for local and MDBX vaults, invitation text/QR pairing, saved-device discovery, transfer direction, automatic sync while the page is open, status and cancellation. Pairing establishes trust before a separate transfer. Passkey portability restrictions require explicit review. LAN networking uses the local communication helper; MDBX storage is bundled.
- Connected native MDBX send/receive with encrypted operation recovery. The exact operation, content and assets are saved before writing; recovery after restart retrieves the original receipt without overwriting later edits. Repeated sync performs no duplicate writes. Fixed simultaneous listeners attempting to release a native session before cancellation had completed.
- Native catalogs, folder/root tags, password records, labels, relations and attachments use complete inventories and revision checks with atomic adoption, attachment moves and identity-preserving replacements. Numeric precision, original Passkey keys/credential IDs and zero or existing positive counter history are preserved. Fixed stale folder-name markers and attachment replacement size mismatches. Incomplete projections explicitly block scanning so omitted content cannot become deletions.
- Fixed the MDBX offscreen document disconnecting unrelated Wi-Fi manager ports and historical native object UUIDs being rejected as session handles. Runtime session/operation handles keep strict validation. Cancelled operations cannot change a subsequent connection's state.
- Local-item synchronization retains exact source archives, including JSON, binary-encoded data, unknown formats and historical versions through adoption, edits, restart, portable-backup restore and subsequent copies. Archives stay encrypted and never automatically create remote connections or activate credentials.

Wi-Fi closeout remains in progress: retained native trash, some native archives and folder assets/profiles, and current Android/F-Droid bidirectional application acceptance are unfinished. Full Android parity also requires cross-backend conflict/recovery and real OneDrive acceptance. These changes have not been published.
