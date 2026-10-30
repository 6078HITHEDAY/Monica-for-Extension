# Android 新修复版 Bitwarden Passkey 往返验收

2026-10-10，扩展 `0.1.37` 与普通版 Android `1.0.318-26101012-03`。

## 中文

此前 Android 编辑单个 Passkey 会覆盖父 Cipher 的缺陷，在当前已安装修复版上重新执行原失败场景后，**三组全部通过**。证据来自实际应用运行和独立比较。

| 场景 | Android 导入／编辑／上传／空库重建 | 原生字段保留 | Android 回传后的实际 Edge 登录 |
| --- | --- | --- | --- |
| direct：浏览器新注册 ES256 和核心生成的 32 字节旧式 ID | 2 条凭据完整 | 通过 | 重启前后 4 次 |
| copies-complete：完成项目移除后的独立副本 | 2 条凭据完整，存储计数 0／23 | 通过 | 重启前后 4 次；正计数 23→24→25 |
| copies-cancel：取消移除，原 Cipher 两把密钥和一个副本 | 3 条凭据完整，2 把不同的原始密钥均保留 | 通过 | 重启前后 6 次；重复 ID 明确选择来源 |

Android 运行实际 `CipherSyncProcessor`、Room、受保护密钥存储、`PasskeyRepository.updatePasskey` 和 `BitwardenSyncService.uploadModifiedEntries`。每组导入两次检查去重，编辑所有密钥的多行 Unicode 备注，再在另一份空合成库重建。上传经过 GET 原 Cipher、携带版本条件的 PUT、GET 回读；模拟服务执行完整替换，不替客户端补回丢失字段。

独立 Node 校验以原公钥验证 **14 份 Android 签名**，检查凭据 ID、RP、userHandle、私钥摘要、存储计数及受保护引用。完整比较父 Cipher（包括未建模字段），仅排除本次有意编辑的备注、服务器版本、请求控制字段及另外逐项验证的 FIDO2 数组。密码、用户名、分组、自定义字段、URI、父文件夹及兄弟凭据均保留。

真实 Edge 使用当前 `dist`、MV3、隔离配置和真实主密码验证窗口。准备阶段 3 个场景、回传阶段 3 个场景均通过。回传阶段共 **14 次 WebAuthn 断言**，连同直接输入准备时的 4 次，共 18 次；另有一次真实浏览器注册。复制场景原始密钥由扩展核心生成，不冒称全部由浏览器注册。

重复 ID 使用真实键盘选择具体来源；每次检查所选本地条目的使用次数，确认签的是对应副本。正计数写回后继续比较父登录内容及全部兄弟密钥。零计数保持零，正计数沿用扩展既有确认后递增策略。Android 签名调用真实辅助方法，测试传入零，**不等同于 Android 系统请求全链路验收**。

来源与恢复：

- 应用 SHA-256：`dff1248429bf65be9c3362c73cd2982dd6cbcb9f3b8dbfdb6780812d325edd6c`，与 Android 修复报告一致，未重新安装应用。
- 当前编译 API JAR：`c2cc5e46e1b65ec45f2e5f91a3ef1bbe0875fddcbe0bc3c5d6da188b41e9389f`，报告列出的相关源码摘要逐一核实。
- 专用测试 APK：`d48b2e526deef7adfe297201939396513633fd99e307a69aaf9c7e49dd8fb2f9`；仅编译测试包，51 秒完成。
- 原测试 APK：`b7f9d4939bfd7437a1053072e6ee3f44432ebc00faf149967cdaad07cf98b1f8`，已恢复。应用哈希及 AVD 启动 ID 保持一致。
- 复用已运行 `Monica_Issue136_API_32 / emulator-5554`，未清空应用数据。合成数据库由夹具清理，先前两个设备测试文件已恢复；公共 AVD 保持运行。

证据目录 `.tmp/android-bitwarden-repaired-318/`：`baseline.json`、`build-evidence.json`、`bitwarden-copies-evidence.json`、`restoration.json`、`independent-*.json`、`edge-return*.json`。日志前缀 `.artifacts/bw-repaired-`，最终清单 `.artifacts/bw-repaired-manifest-318.json`。Interop 与新增 E2E TypeScript 检查通过。

缓存清理未完成：本轮独立 `build` 目录约 0.37 GiB。路径及证据保留检查后的删除命令被自动审批以 `blocked by policy` 拒绝，未执行、未改用其他工具重试，目录和证据均保留。

首轮原生比较发现旧 Edge 模拟器将请求控制字段 `lastKnownRevisionDate` 回显成数据。它并非持久化的凭据内容，核对器已明确排除；密码、私钥和未知业务字段检查没有放宽。修正后独立核对 3/3 通过，初次失败日志保留。

这是普通版当前应用与浏览器的实际运行验收，HTTP 两侧仍使用隔离合成服务。尚未覆盖真实 Bitwarden/Vaultwarden、F-Droid 的同场景复跑、Android14+ 系统 Credential Manager 或真实网站跨设备登录。其他后端、OneDrive 真实账号、KDBX 分组及完整生命周期矩阵仍未完成，整体目标保持进行中。

## English

All three previously failing scenarios passed against the installed repaired Android application. Direct credentials, completed-removal copies and cancelled-removal copies survived import, edit, upload and fresh-vault reconstruction. Independent verification confirmed 14 Android signatures and preserved native parent fields, private keys and credential identities.

Every returned binding completed real Edge WebAuthn sign-in before and after restart: 14 assertions, including explicit duplicate-ID source selection and acknowledged positive-counter writes. Existing zero-counter behavior was preserved. Original instrumentation and pre-existing fixture files were restored; the application was not reinstalled.

HTTP services remain synthetic. This proves the current ordinary Android application/browser paths, not real-server, F-Droid, system Credential Manager or live-site coverage. The wider parity goal remains incomplete.
