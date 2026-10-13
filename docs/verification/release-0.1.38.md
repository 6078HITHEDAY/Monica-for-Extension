# 0.1.38 阶段发布验证

## 中文

2026-10-15，用户要求先收尾一个阶段并发布供试用的版本。扩展为 0.1.38，Windows 可选本机助手为 0.1.3。保留旧标签与原 0.1.38–0.1.45 开发文档；本次说明位于 `docs/releases/Monica-Extension-0.1.38.md`。此阶段不修改 Android、不读取用户 Chrome 或真实密码库。

- 全量单元测试首轮：299 个文件、3,652 项通过，1 项失败。失败来自旧权限清单遗漏内置数据库必需的 `offscreen`；补齐后该文件 6 项复测通过。未忽略失败，也未削减实际权限检查。
- 真实 Edge 155.0.4283.45 的 30 项发布重点场景首轮 27 项通过、3 项失败。修复自动填充开关保存时临时禁用导致的键盘焦点丢失，另修正性能测试启用 Edge 后的两处旧引用；失败的 3 项复测全部通过。覆盖生成器轨道点击、自动填充选择／键盘／来源限制／锁定／HOTP、延迟 Windows Hello 不阻塞启动、无助手 MDBX 新建及重启、两浏览器 WebDAV 损坏与中断恢复、ES256／RSA／Bitwarden Passkey 注册及登录、取消与排除列表、分页搜索、组件销毁及图标渲染。最后的焦点外观复核保留 M3E 自带指示，去除宿主重复描边。
- 82 项 Native Host 测试、严格 Clippy、Windows x64 release 构建通过。无弹窗 Windows Hello 探针正确报告本测试环境没有可用平台验证器，并拒绝损坏绑定；没有把软件探针算作硬件认证验收。
- 两种 Bitwarden/Vaultwarden 服务契约配置通过 2 项验收，覆盖登录、Cipher、组织路由、附件、Passkey 计数与空库同步。它们是状态化契约夹具，不代表真实云账户验收。
- 供应链、固定引擎来源、版本／锁文件、TypeScript 与正式构建检查通过。生产依赖审计为 0 已知漏洞；产物安全审计覆盖 219 个运行时命令（含 24 个管理页专用命令），未发现测试秘密或源映射进入产品包。
- 沿用并更新本地 M3E Canvas 设置草图，检查了实际设置页面及焦点。草图和截图仅留本地，不进入发布文件或源码提交。此前同一源码阶段的附近同步 306 条记录恢复、300 条修改回传属于内部测试，仍不计为可用产品界面或 Android 应用验收。

本阶段没有重跑所有历史 Playwright、真实 Android/F-Droid、实际 OneDrive 登录、真实网站账号或 Windows Hello 硬件流程，也没有宣称完整 `release:windows` 稳定版门禁通过。已通过的分阶段原生字段、迁移和恢复证据保留在对应文档中；未完成能力在发行说明中明确列出。

发布包在干净的版本提交上生成，分别验证插件与助手的文件清单、源码提交、哈希及两次独立封包的一致性。实际源码提交及校验值以发布包中的 `SECURITY-EVIDENCE.json`／`HOST-METADATA.json` 和随包 `.sha256` 文件为准。安装包只包含运行时文件和许可证／来源资料，排除密码库、测试记录、浏览器配置与设计截图。

本轮本地日志为 `.artifacts/release-0138-*`，保留首轮失败与复测记录。GitHub 发布不等于浏览器商店更新。

## English

User-authorized stage preview reviewed on 2026-10-15: extension 0.1.38 and optional Windows native helper 0.1.3. Historical tags and development documents remain intact. No Android changes, user Chrome profiles or real vaults were used.

- The full unit run passed 3,652 of 3,653 tests across 299 files. Its only failure was the old permission inventory missing the required bundled-database `offscreen` permission; the corrected file passed all six tests.
- Installed Edge 155.0.4283.45 passed 27 of 30 selected release scenarios initially. A real keyboard-focus regression in the inline-autofill setting and two test-only Edge-launch references were corrected; all three failed cases then passed. Coverage includes generator clicks, autofill/HOTP/security boundaries, startup, helper-free MDBX, WebDAV recovery, ES256/RSA/Bitwarden Passkey flows, cancellation, pagination, component cleanup and icon rendering. Final focus styling keeps the M3E indicator without the duplicate host outline.
- All 82 native tests, strict Clippy and Windows x64 release compilation passed. The prompt-free Windows Hello probe correctly reported unavailable platform authentication and rejected damaged bindings; no hardware-authentication claim is made.
- Both stateful Bitwarden/Vaultwarden server-contract profiles passed. These fixtures are not live cloud-account acceptance.
- Supply-chain/source checks, TypeScript and production build passed. Production dependency audit reported zero known vulnerabilities. The built-package security audit covered 219 commands, including 24 manager-only commands, without fixture secrets or source maps in the product.
- Local editable Canvas and actual settings rendering were inspected. Design files/screenshots stay local. Prior nearby pagination and reciprocal recovery evidence remains internal and does not establish product UI or Android application acceptance.

This scoped preview does not claim the complete historical E2E suite or `release:windows` stable gate. Current Android/F-Droid, real OneDrive sign-in, live-account and Windows Hello hardware matrices remain incomplete and are disclosed in the release notes.

Packages are generated from a clean version commit and checked for contents, provenance, hashes and identical independent repackaging. Exact commits and checksums are in the embedded security/host metadata and SHA-256 sidecars. Vaults, test evidence, browser profiles and design screenshots are excluded. Local logs retain initial failures and repairs under `.artifacts/release-0138-*`. Browser stores are not updated by this GitHub release.
