# Monica for Extension 0.1.48 preview-beta

> **发布渠道**：GitHub 正式 Release（未标记 Pre-release，标签 `v0.1.48`）。
> **构建性质**：preview-beta 试用版，不是稳定版，也不代表浏览器商店已上架。
> **支持范围**：Chrome 128 及以上为声明目标；Firefox 不支持。
> **同步方向**：在 Android 端的“附近设备同步”设置中务必选择“双向同步”；选择“仅发送”或“仅接收”可能与电脑端方向不兼容，导致同步无法开始。

## 中文

### 本版修复

- 修复通过 Wi-Fi 同步到扩展的大量 TOTP 认证器显示“不可用”：解码时按 Monica Android `TotpDataResolver` 的读入规则修复旧记录，包括 `secret` 字段里存了整段 `otpauth://`/`steam://` URI、period 或 digits 越界、缺少 `otpType` 的 Steam 认证器，以及 `key`/`serviceName`/`account` 旧字段别名。
- 修复 Android 写出的认证器被解码成 4 位验证码的问题。Kotlin 序列化会省略等于默认值的字段，扩展原先把缺失的 `digits`/`period` 读成 0；现在按 Android 的默认值 6 位、30 秒解码。
- 修复 0.1.47 已导入的本地条目：解码修复无法追溯已写入密码库的 4 位参数，现在解锁时会用附近设备同步保留的原始 Android 记录重新核对，只修复 `item_data` 中确实没有 `digits` 字段的条目；Android 明确保存的位数（包括确实设为 4 位的钥匙）保持原样。回收站中的条目同样会修复，恢复后即可正常显示。
- 生成端不再把 Android 仍能正常显示的钥匙判为不可用：非正 period 回退 30 秒、digits 收敛到 4–10、不可用计数器按 0 处理、Base32 字母表外的字符按 Android 生成器的方式跳过。
- 登录条目里内嵌的 TOTP 现在按 Android 的上下文规则读取：网址（或标题）作为 issuer、用户名（或标题）作为账户名；Steam 登录自动切换到 5 位 Steam Guard 规则。
- 带 issuer 的 Yandex 钥匙只有在 PIN 可用时才切换到 YAOTP；没有 PIN 时保持数字验证码，不再变成不可用。
- 条目编辑页的 TOTP 密钥新增显示/隐藏切换，与详情页一致，便于定位异常记录。
- 以上修复只影响读取与显示；未改动的记录在同步写回时保持原始字节不变，不会因此覆盖 Android 端数据。

### 升级与安装

- 扩展 ID 仍为 `lebnfedmijifofonogjdphpojihgohmc`。替换文件并在扩展管理页重新加载即可；不需要重新导出／恢复密码库，也不需要重新运行 `install-wifi.ps1` 或 `install-host.ps1`。
- Chrome：`chrome://extensions` → Monica → **重新加载**。
- Edge：`edge://extensions` → Monica → **重新加载**。
- 本版取代 0.1.47 的发布 ZIP；0.1.47 的安装包包含上述 TOTP 解析缺陷。

### 验证范围

- 构建、全量单元测试、TOTP 回归测试、安全审计与可复现打包结果见[发布验证记录](https://github.com/Monica-Pass/Monica-for-Extension/blob/v0.1.48/docs/verification/release-0.1.48.md)。
- 修复覆盖 Wi-Fi 同步、KeePass KDBX 安全条目与登录内嵌三条读取路径，均由单元测试锁定；验证使用仓库内的合成 fixture，未读取或回放真实密码库数据。
- Chrome 128+ 仍是声明目标；真实手机首次同步、Android 自动调度与 OneDrive 真实登录仍未验收。
- 本版未运行完整 `release:check`（含联网 npm 审计、Rust 测试和 Playwright E2E），验证范围以记录为准。

### 反馈

请注明版本、浏览器、密码来源与复现步骤。不要上传真实密码、Passkey 私钥或密码库。安全问题请按 [SECURITY.md](https://github.com/Monica-Pass/Monica-for-Extension/blob/main/SECURITY.md) 私下报告。

## English

### Fixes

- Fixed the many TOTP authenticators synced over Wi-Fi that showed “unavailable”: decoding now repairs legacy records with Monica Android's `TotpDataResolver` read rules, including a whole `otpauth://`/`steam://` URI stored in `secret`, out-of-range period or digits, Steam authenticators without `otpType`, and the legacy `key`/`serviceName`/`account` aliases.
- Fixed Android-written authenticators decoding to a 4-digit code. Kotlin serialisation omits fields equal to their defaults, and the extension previously read the missing `digits`/`period` as 0; they now decode to Android's defaults of 6 digits and 30 seconds.
- Fixed local items already imported by 0.1.47: a decoder fix cannot retroactively correct digit counts persisted in the vault, so unlocking now re-checks the original Android record retained by Nearby Sync. Only items whose `item_data` has no `digits` field are repaired; a digit count Android explicitly stored (including a genuine 4-digit key) is left untouched. Trashed items are repaired too, so restoring one shows the correct code.
- Generation no longer rejects keys Android still renders: a non-positive period falls back to 30 s, digits are clamped into 4–10, an unusable counter is read as 0, and characters outside the Base32 alphabet are skipped the way Android's generator does.
- An inline TOTP on a login now follows Android's context rules: the website (or title) becomes the issuer and the username (or title) the account name; Steam logins switch to the 5-character Steam Guard rule.
- An issuer-based Yandex key only switches to YAOTP when a usable PIN is present; without one it keeps rendering the numeric code instead of becoming unavailable.
- The item editor gains a show/hide toggle for the TOTP secret, matching the detail page, so a failing record can be diagnosed in place.
- These fixes only change reading and display; unchanged records keep their original bytes on sync write-back, so Android data is not overwritten by the repair.

### Upgrade and install

- The extension ID remains `lebnfedmijifofonogjdphpojihgohmc`. Replace the files and reload the extension; no vault export/restore and no `install-wifi.ps1`/`install-host.ps1` rerun are required.
- Chrome: open `chrome://extensions` and click **Reload** for Monica.
- Edge: open `edge://extensions` and click **Reload** for Monica.
- This release supersedes the 0.1.47 ZIP, which contains the TOTP parsing defects above.

### Verification

- The [release verification record](https://github.com/Monica-Pass/Monica-for-Extension/blob/v0.1.48/docs/verification/release-0.1.48.md) covers the build, full unit suite, TOTP regression tests, security audit and reproducible packaging results.
- The fixes cover all three read paths — Wi-Fi sync, KeePass KDBX secure items and inline login keys — and are locked by unit tests. Verification used synthetic fixtures from the repository; no real vault data was read or replayed.
- Chrome 128+ remains the declared target. Real-phone first sync, Android automatic scheduling and real OneDrive sign-in remain unverified.
- This build does not run the complete `release:check` (online npm audit, Rust tests, Playwright E2E); the verification record defines the accepted scope.

### Feedback

Include the version, browser, password source and reproduction steps. Do not upload real passwords, Passkey private keys or vaults. Report security issues privately per [SECURITY.md](https://github.com/Monica-Pass/Monica-for-Extension/blob/main/SECURITY.md).
