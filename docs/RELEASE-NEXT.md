# Monica for Extension — 下一版 / Next release

> 0.1.38 阶段改动已归档至 [发行说明](releases/Monica-Extension-0.1.38.md)和[累计记录](releases/Monica-Extension-0.1.38-changelog.md)。后续新增改动从这里继续记录。 / The 0.1.38 stage is archived; subsequent changes will be recorded here.

## 中文

- 将可选字体生成工具 fonttools 升级至 4.60.2，修复已确认的 varLib 任意文件写入与 XML 注入漏洞；现有字体文件及其生成记录保持不变，插件运行和正常构建不依赖 Python。
- 接通附近同步的生产后台连接管理：仅当前完整管理页能持有同步连接，锁定、会话过期、关闭页面或修改同步设置时关闭传输；加密保存前再次检查取消状态。完成真实 Edge 双端中断、重启和原始 Passkey 签名验收。此阶段仍无附近同步界面或自动同步入口。

完整 Android 对齐仍在开发：附近同步界面、完整 MDBX 接收、来源归档与文件夹元数据，以及当前 Android/F-Droid、真实 OneDrive 和跨后端矩阵验收尚未完成。这些待办不作为已发布可用功能。

## English

- Updated the optional fonttools generator dependency to 4.60.2 to address the confirmed varLib arbitrary-file-write/XML-injection advisory. Existing font assets and generation provenance are unchanged; Python is not required by the extension or its normal build.
- Integrated production background ownership for nearby transfers. Only the active full manager can own a connection; lock, session expiry, page disposal and preference changes close it, with cancellation checked again before encrypted commits. Real two-client Edge interruption/restart and original-Passkey signature acceptance passed. There is still no nearby UI or automatic-sync entry point.

Full Android parity remains in development: nearby UI; complete MDBX adoption, source archives and folder metadata; current Android/F-Droid, real OneDrive and cross-backend acceptance. These pending items are not advertised as available features.
