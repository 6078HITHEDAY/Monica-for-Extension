# Monica for Extension — 下一版 / Next release

> 未发布 / Unreleased。当前开发构建仍为 0.1.37；已发布说明保持原样。

## 中文

- 去掉设置页语言和显示模式下拉框的内层聚焦包边；鼠标悬停及展开菜单只轻微提亮整行，键盘定位保留单层整行提示，并适配系统高对比度。
- 整理设置页：语言、显示模式、自动同步和表单旁自动填充可在首页直接操作；按通用、同步与填充、密码库与安全分组，二级入口由十个缩减为四个。合并 Windows Hello 与保护方式、备份与迁移，移除重复的显示模式及独立安全说明入口。收紧分组间距与留白，语言/显示模式行由约 108px 缩至 72px，保留大字号下的完整文本和操作空间；补齐编辑内容页遗漏的多语言词条。
- 加固设备密钥隔离：将旧存储中的设备密钥迁移至扩展专属 IndexedDB，网页内容脚本不能读取；迁移成功提交后才清理旧副本，保留原密钥与密码库数据，重试不会用旧副本覆盖已迁移密钥。迁移后的设备密钥模式不能直接降级到旧构建，建议保留密码保护的备份。
- 修复诊断脱敏遗漏带引号的密码、多词口令及提供方 token／密钥字段的问题；无效的已解密 JSON 不再把原文片段带入错误消息。缩短密码库明文字节缓冲区的存活时间。
- 更新有已知漏洞的测试依赖；本次完整 npm 依赖审计无已知漏洞告警。审查范围与剩余限制见安全审查报告；设备密钥模式仍依赖浏览器及操作系统保护，推荐使用强主密码。
- 修复 Android／Bitwarden 的标准加密 maFile 附件在插件显示“不可用”：兼容标准附件及旧 Monica 格式，新上传使用 Bitwarden 标准格式，已准备的旧上传可继续恢复。附件读取失败后，即使服务器版本号未变也会重试；成功后复用缓存。完整保留数字 SteamID，修复普通网页 URL 干扰密钥读取、缺少附件大小时跳过加载的问题。Steam Guard 验证码不依赖会话 token。
- 修复 Steam 登录项丢失验证码编码信息、`encoder=steam` 条目未显示的问题；读取 Android 标记的 KDBX maFile 附件，无法读取密钥的已识别条目继续显示为不可用。
- 密码库筛选使用原生文件夹身份，支持 Steam、Passkey 等页面按数据库和文件夹筛选。不同数据库的同名文件夹保持独立，KeePass 路径正确显示，根目录可单独筛选。各页面选择保存在加密密码库中，重新打开后恢复。
- Passkey 兼容标记在列表与详情往返时立即复用；会话缓存有容量和有效期限制，密钥变化或锁定后重新检查，减少重复计算和标记闪烁。
- 无待写入修改的本地 MDBX 不再周期性触发同步任务；编辑后的本地写回与云端同步继续保留。
- 修复 MDBX 批量传输把 Passkey“复制”执行为“移动”的问题：副本保留原凭据 ID、私钥及计数，来源记录不变。目标数据库已有相同凭据时提前阻止；受限条目可取消或跳过，复制中断后可重试。

以上是已实现的改动，完整 Android 对齐仍在进行。Passkey／Steam 页面直达的统一移动／复制入口，以及以本地库、KeePass、Bitwarden 为目标的完整传输流程尚未补齐；不据此宣称所有数据库之间已完成互通。尚未发布新安装包或更新商店。

## English

- Removed the nested focus outline from language and display-mode settings. Hovering or opening a menu subtly highlights the row; keyboard navigation keeps a single row-level indicator, including system high-contrast mode.
- Reorganized settings into General, Sync and autofill, and Vault and security. Language, display mode and the sync/autofill switches work directly on the home page; secondary destinations are reduced from ten to four. Combined Windows Hello with protection settings, and backups with migration. Removed duplicate display-mode controls and the separate security explanation page. Reduced spacing and empty field hints, bringing standard language/display rows from about 108px to 72px while preserving enlarged-text usability. Completed missing editor translations.
- Isolated device keys in extension-origin IndexedDB, inaccessible to content scripts. Legacy keys migrate unchanged; old copies are removed only after commit, and retries never replace an already migrated key with a legacy copy. Direct downgrade of a migrated device-key profile to an older build is unsupported; retain a password-protected backup.
- Fixed diagnostic redaction of quoted passwords, multiword passphrases and provider token/key fields. Invalid decrypted JSON no longer includes source fragments in errors. Reduced the lifetime of plaintext vault byte buffers.
- Updated vulnerable test dependencies; the full npm audit reports no known advisories at review time. See the security review for scope and remaining limitations. Device-key mode still relies on browser and OS protection; a strong master password is recommended.
- Fixed Android/Bitwarden standard encrypted maFile attachments appearing unavailable. The reader supports both standard Bitwarden and historical Monica attachments; new uploads use the standard format and prepared historical uploads remain recoverable. Failed attachment reads retry even when the server revision is unchanged, while successful reads stay cached. Numeric SteamIDs retain their full precision, unrelated website URLs no longer override the secret, and missing attachment sizes no longer prevent bounded reads. Steam Guard codes do not require session tokens.
- Fixed Steam login projections losing secret encoding and omitting `encoder=steam` entries. Android-marked KDBX maFile attachments are read, while recognized entries with unavailable keys remain visible with an unavailable state.
- Vault filtering uses native folder identities across Steam, Passkey and other pages. Identically named folders in separate databases remain distinct; KeePass paths are decoded for display and root entries can be filtered separately. Each page's selection is saved inside the encrypted vault and restored on reopening.
- Passkey compatibility labels reuse completed checks immediately on list/detail navigation. A bounded session cache expires results and rechecks changed keys or a new unlock session, reducing repeated work and flicker.
- Clean local MDBX databases no longer schedule periodic synchronization. Pending local writes and cloud synchronization remain supported.
- Fixed MDBX batch transfer treating a Passkey copy as a move. Copies retain the credential ID, private key and counter while preserving the source. Existing credentials in the destination are blocked before transfer; unavailable entries can be cancelled or skipped, and interrupted copies can be retried.

Full Android parity remains in progress. A shared transfer entry point directly on Passkey/Steam pages and complete transfer workflows targeting the local vault, KeePass and Bitwarden remain unfinished. This update does not claim interoperability between every database. No new release package or store update has been published.
