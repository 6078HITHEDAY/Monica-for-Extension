# Monica for Extension — 下一版 / Next release

> 0.1.38 阶段改动已归档至 [发行说明](releases/Monica-Extension-0.1.38.md)和[累计记录](releases/Monica-Extension-0.1.38-changelog.md)。后续新增改动从这里继续记录。 / The 0.1.38 stage is archived; subsequent changes will be recorded here.

## 中文

- 将可选字体生成工具 fonttools 升级至 4.60.2，修复已确认的 varLib 任意文件写入与 XML 注入漏洞；现有字体文件及其生成记录保持不变，插件运行和正常构建不依赖 Python。
- 接通附近同步的生产后台连接管理：仅当前完整管理页能持有同步连接，锁定、会话过期、关闭页面或修改同步设置时关闭传输；加密保存前再次检查取消状态。完成真实 Edge 双端中断、重启和原始 Passkey 签名验收。此阶段仍无附近同步界面或自动同步入口。
- 附近同步本地接收现可保留独立文件夹、空分类、嵌套路径、根标签及空删除标记，分页往返更新保留原项目和分类身份；同时修复恢复便携备份后旧同步回执错误阻止新设备修改的问题。真实 Edge 双端验证附件与原 Passkey 密钥、签名、0／19 计数保持正确。

完整 Android 对齐仍在开发：附近同步界面、完整 MDBX 接收及其文件夹／根元数据落库、来源归档，以及当前 Android/F-Droid、真实 OneDrive 和跨后端矩阵验收尚未完成。这些待办不作为已发布可用功能。

## English

- Updated the optional fonttools generator dependency to 4.60.2 to address the confirmed varLib arbitrary-file-write/XML-injection advisory. Existing font assets and generation provenance are unchanged; Python is not required by the extension or its normal build.
- Integrated production background ownership for nearby transfers. Only the active full manager can own a connection; lock, session expiry, page disposal and preference changes close it, with cancellation checked again before encrypted commits. Real two-client Edge interruption/restart and original-Passkey signature acceptance passed. There is still no nearby UI or automatic-sync entry point.
- Local nearby adoption now retains standalone/empty folders, nested paths, root tags and empty tombstones, preserving original item/category identities through paginated reciprocal updates. Fixed stale receipt history blocking edits after portable-backup restore. Real two-client Edge acceptance preserved attachments, original Passkey keys/signatures and source counters 0/19.

Full Android parity remains in development: nearby UI; complete MDBX adoption and native folder/root metadata application; source archives; current Android/F-Droid, real OneDrive and cross-backend acceptance. These pending items are not advertised as available features.
