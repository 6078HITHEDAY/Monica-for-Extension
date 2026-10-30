# 0.1.39 阶段发布验证

## 中文

2026-10-14，按用户要求收尾已完成阶段，发布 0.1.39 Preview。改动限于附近同步后台生命周期、本地元数据／删除标记及便携备份恢复回执，还有可选字体生成依赖修复。Native Host 与内置 MDBX 的原生源码和二进制未变，继续使用已发布 Host 0.1.3；0.1.38 标签与资产保持不变。

- 元数据阶段全量单元测试首轮 301 个文件，3,693／3,694 通过。一项既有 Bitwarden 项目批处理用例在并发下达到 5 秒超时，其整个四用例文件随后单独运行通过。之后增加五项回归；没有宣称重跑过第二轮全量测试。最终受影响范围 9 个文件、199 项不同用例通过，其中 14 项专门覆盖元数据、回放、旧分类映射、备份恢复、身份保留和分页项目删除。
- 真实 Edge 155.0.4283.45、两个隔离配置、正式 dist 后台及实际 Native Messaging／Noise 验收通过。保留嵌套同名文件夹、空分类、根标签、不损失精度的 JSON 和空删除标记；600,000 字节附件、原凭据 ID／私钥与原公钥验签通过。两个浏览器与本机进程重启后复用配对，返回修改仍落入原项目。正计数 19 凭据被禁止导出，源计数保留 0／19；未把它记作正计数网站登录验收。最终流程 14.1 秒通过。
- 生产连接生命周期另通过真实锁定、会话过期、设置变化和管理页关闭的取消检查，覆盖加密提交前的会话保护与重启恢复。详细证据见[连接管理](../nearby-manager-owner-320.md)和[本地元数据](../nearby-local-metadata-320.md)。
- 0.1.39 版本整理后，16 项发布准备检查、项目与互操作 TypeScript、正式构建、固定 MDBX 引擎来源及供应链检查通过；生产 npm 审计为 0 已知漏洞。产物安全审计通过，覆盖 219 个命令、24 个管理页专用项目命令与独立附近同步管理端口。
- 可选 fonttools 4.60.1 的已确认漏洞修复为 4.60.2；237 个图标及原字体哈希核验通过。没有重新生成字体，也没有把可选 Python 工具计入插件运行依赖。

发布封包使用干净版本提交，核对 ZIP、dist 与解压目录的每个文件，并通过两次独立重新封包验证逐字节一致性。实际源码提交、锁文件及内容哈希以随包的 SECURITY-EVIDENCE.json、RELEASE-METADATA.json 和 SHA-256 文件为准。GitHub 资产还核对远端摘要和大小；日志与发布结果保留在本地 `.artifacts/release-0139-*`。

本次没有读取用户 Chrome／真实账户或密码库，没有修改 Android 或重编译原生助手。已在 0.1.38 验收且未受本阶段改动影响的生成器、自动填充、网站登录、Steam 与 MDBX 流程保留原证据，不重复声称本次全部运行。未完成附近同步界面、完整原生 MDBX 接收、来源归档、当前 Android/F-Droid、真实 OneDrive 和跨后端矩阵；不宣称完整 release:windows 稳定门禁通过。日志保留首轮失败及修复结果，不以缺少现场验收的能力作为已完成特性。

## English

User-authorized stage Preview 0.1.39, reviewed on 2026-10-14. Scope: nearby owner/lifecycle cancellation, local metadata/tombstones, portable-backup receipt recovery and the optional font generator dependency fix. Native Host and bundled MDBX native sources/binaries are unchanged; reuse released Host 0.1.3. Preserve the 0.1.38 tag and assets.

- The metadata full unit run passed 3,693 of 3,694 tests across 301 files. One existing Bitwarden project-batch test reached its five-second timeout under concurrency; its whole four-test file passed in isolation. Five regressions were added afterward; there was no second full run. Final affected coverage passed 199 distinct tests in nine files, including 14 dedicated metadata regressions.
- Installed Edge 155.0.4283.45 used two isolated profiles, production dist background and actual Native Messaging/Noise. Final 14.1-second acceptance preserved nested same-name folders, empty categories, root tags, lossless JSON, tombstones, a 600,000-byte attachment, original credential/private-key bytes and a signature checked with the original public key. Both browser/native processes restart, reuse pairing and return edits into the original item. A positive-19 credential is excluded from export, preserving source counters 0/19; this is not positive-counter website-login acceptance.
- Separate production owner acceptance verifies lock, expiry, preference changes and manager-close cancellation, session checks before encrypted writes and restart recovery. See the linked implementation evidence above.
- After the version update, 16 release-readiness tests, project/interop TypeScript, production build, pinned MDBX provenance and supply-chain checks passed. Production npm audit reported zero known vulnerabilities. Package security audit passed for 219 commands, 24 manager-only project commands and the dedicated nearby manager port.
- Optional fonttools is patched from 4.60.1 to 4.60.2; all 237 icons and original font hashes were verified unchanged. No font regeneration or Python runtime dependency was introduced.

Packaging uses a clean version commit, checks every ZIP/dist/unpacked file and compares two independent repackages byte for byte. Embedded evidence and SHA-256 sidecars bind source, lockfile and content. Remote GitHub asset digests/sizes are checked against local files; evidence is retained locally under `.artifacts/release-0139-*`.

No user Chrome, real accounts/vaults, Android changes or new native build. Unaffected 0.1.38 generator/autofill/site-login/Steam/MDBX acceptance is retained as prior evidence, not claimed as rerun here. Nearby UI, full native MDBX adoption, archived origins and current Android/F-Droid, real OneDrive and cross-backend matrices remain incomplete. This does not claim the complete release:windows stable gate. Initial failures and repairs remain recorded.


## 2026-10-14 下载附件精简

经用户明确确认，移除发布页三个重复的 JSON 附件。删除前逐项核对远端 SHA-256、大小和 ZIP 内副本，内容完全相同；删除后核对发布页只剩插件 ZIP 和 `.zip.sha256`，两者的资产 ID、大小、摘要及下载 URL 未变。源码标签和已发布 ZIP 未重建；两个 GitHub 自动生成的源码下载项保留。发行说明改为明确告知审计材料已包含在 ZIP 中。上文五附件验证是最初发布时的历史记录。

Evidence: `.artifacts/release-0139-assets-before-simplify.json` and `.artifacts/release-0139-assets-after-simplify.json`. Future publication follows `docs/RELEASE.md`: upload only the install ZIP and checksum; preserve JSON inventories locally/in CI and inside the ZIP.
