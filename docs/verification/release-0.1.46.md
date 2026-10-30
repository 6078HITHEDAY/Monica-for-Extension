# 0.1.46 Chrome 测试版发布验证

## 中文

2026-10-20，按用户要求发布 0.1.46 测试版，并在发布页声明**仅支持 Chrome**。本版汇总 0.1.39 之后尚未发布的改动，并首次把扩展 ID 固定为 `lebnfedmijifofonogjdphpojihgohmc`。0.1.39 及更早标签、资产与历史说明保持不变。

- **版本与身份**：`package.json`、`package-lock.json` 与 `public/manifest.json` 均为 `0.1.46`。重新构建后从 `dist/manifest.json` 读取的公钥与 `public/manifest.json` 逐字节一致，按 Chrome 扩展 ID 规则计算得到 `lebnfedmijifofonogjdphpojihgohmc`；manifest 继续声明 `minimum_chrome_version` 128。
- **构建**：`npm run build` 通过，转换 435 个模块；4 个扩展页面通过本地资源引用检查；MDBX2 Host 固定提交 `90005c8c608c952093a4522ffa507a562e2e39a4`、8 个显式扩展覆写与 180 个 vendored 文件校验通过；内置 Windows Wi-Fi 安装组件能力握手通过，SHA-256 为 `15d8a52a9bcd2d40338825023b3ca85101ff19105f7eb6e93a0e4ccf739827b5`。
- **单元测试**：全量 `npm test` 共 321 个文件、4,109 项，4,106 项通过。两个 Bitwarden 文件中的 3 项在并发负载下达到既有 5 秒超时（`bitwarden-keepass-move.test.ts`、`bitwarden-project-batch.test.ts`）；这两个文件单独重跑共 29／29 通过，本记录不宣称重跑过第二轮全量测试。该现象与 0.1.39 记录过的并发超时一致。
- **安全审计**：`node scripts/security-audit.mjs` 通过，检查 218 个运行时命令（含 24 个仅管理页可用的密码项目命令），并核对独立附近同步管理端口的文档归属、请求上限、脱敏与生命周期取消。
- **打包**：发布包从干净的版本提交生成，`npm run package:release` 与 `npm run package:verify` 校验 ZIP、SHA-256、解压目录和两次独立重封包的逐字节一致性；实际源码提交、锁文件与内容哈希以随包的 `SECURITY-EVIDENCE.json`、`RELEASE-METADATA.json` 和 `.zip.sha256` 为准。下载页只上传插件 ZIP 与校验文件。

**未运行／未验收**：没有运行完整 `release:check`（包含联网 npm 审计、Rust 测试和 Playwright E2E），没有在真实 Chrome 中执行 OneDrive 登录，也没有连接真实手机重新验收 Wi-Fi 同步。OneDrive 的 Entra SPA 回调虽已登记，真实登录、令牌刷新与 Graph 读写仍未验证；外部账号可能受发布者验证或管理员同意限制。Firefox 不支持，Edge 未在本版验收。不宣称通过稳定版全量门禁。

## English

User-authorized Chrome-only beta 0.1.46, reviewed on 2026-10-20. This release collects the changes unpublished since 0.1.39 and pins the extension ID to `lebnfedmijifofonogjdphpojihgohmc` for the first time. The 0.1.39 and earlier tags, assets and release notes are unchanged.

- **Version and identity**: `package.json`, `package-lock.json` and `public/manifest.json` are all `0.1.46`. After rebuilding, the public key read from `dist/manifest.json` is byte-identical to `public/manifest.json`; applying Chrome's extension-ID derivation yields `lebnfedmijifofonogjdphpojihgohmc`. The manifest still requires Chrome 128+.
- **Build**: `npm run build` passed with 435 transformed modules; all four extension pages passed local-asset checks; the MDBX2 Host pin `90005c8c608c952093a4522ffa507a562e2e39a4`, 8 explicit extension overlays and 180 vendored files verified; the bundled Windows Wi-Fi helper capability handshake passed with SHA-256 `15d8a52a9bcd2d40338825023b3ca85101ff19105f7eb6e93a0e4ccf739827b5`.
- **Unit tests**: the full `npm test` run covered 321 files and 4,109 tests; 4,106 passed. Three tests in two Bitwarden files hit the existing five-second timeout under concurrent load (`bitwarden-keepass-move.test.ts`, `bitwarden-project-batch.test.ts`); both files passed 29/29 when rerun in isolation. No second full run is claimed. This matches the concurrency timeout recorded for 0.1.39.
- **Security audit**: `node scripts/security-audit.mjs` passed, covering 218 runtime commands (including 24 manager-only password-project commands) and the dedicated nearby manager port's ownership, request bounds, redaction and lifecycle cancellation.
- **Packaging**: artifacts are produced from a clean version commit. `npm run package:release` and `npm run package:verify` check the ZIP, SHA-256, unpacked directory and byte-identical output of two independent repackages. The authoritative source commit, lockfile and content hashes are in the embedded `SECURITY-EVIDENCE.json`, `RELEASE-METADATA.json` and `.zip.sha256`. Only the extension ZIP and checksum are uploaded.

**Not run / not accepted**: the complete `release:check` (online npm audit, Rust tests and Playwright E2E), real OneDrive sign-in in Chrome, and a fresh real-phone Wi-Fi acceptance. The Entra SPA redirect is registered, but real sign-in, token refresh and Graph read/write remain unverified; external accounts may still be limited by publisher verification or admin consent. Firefox is unsupported and Edge is not accepted here. This does not claim the full stable-release gate.
