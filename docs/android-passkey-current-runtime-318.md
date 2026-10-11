# 当前 Android / Edge 的 MDBX Passkey 往返验收

2026-10-10：当前普通 Android `1.0.318` 与扩展 `0.1.37` 完成一轮新的 MDBX 密钥往返。真实 Edge 新建的 RSA Passkey 可导入 Android 的受保护存储并签名，回传后可再次在 Edge 登录及重启后登录。**这是 MDBX、应用仓储/签名辅助方法及真实浏览器的局部验收，不代表 Android 系统 Credential Manager 或所有后端已通过。**

## 实际经过的链路

1. Android 应用生成 ES256、RSA 各一把密钥，经真实仓储写入 MDBX，私钥保存为受保护引用，再导出加密文件。
2. 扩展核心验证 Android 签名，追加 ES256、RSA 两把密钥；同时对原始合成样本设置非默认备份标志，以及一条计数 41 的正计数历史探针。
3. 当前 Android 导入四条记录到本地投影，读取受保护私钥签名并回传。独立 Node/Native 验证密钥摘要、凭据 ID、签名与保留的存储计数。
4. 实际 Edge 导入文件，登录四条记录、检查可发现凭据选择和取消，再通过 `navigator.credentials.create()`、扩展确认页面及 Native Messaging 创建第五把 RSA 密钥。登录、排除重复注册、关闭/重启浏览器、解锁本机副本、再次登录及导出通过。
5. Android 导入 Edge 的五条记录，受保护私钥签名和加密回传通过；独立验签确认五把密钥及稳定 MDBX 对象 ID 全部保留。
6. 另一个全新 Edge 配置导入 Android 回传文件，五条凭据均可登录，选择/取消和再次重启后登录通过。

两次成功 Edge 流程各有 **10 次实际 WebAuthn 断言**通过独立公钥验签，页面异常为零。零计数密钥保持零；正历史探针在浏览器中从 41 递增至 45，经过 Android 导入/导出时保留存储值。

Android 测试直接调用应用的 authenticator-data / 签名辅助方法，并由测试传入零计数。它**没有**经过 Android 的完整认证活动、真实 UV 或计数更新路径，因此 `androidCounterPolicyVerified` 明确为 `false`。本轮没有修改 Android 产品代码、凭据 ID、密钥或刻意设计的零计数策略。

## 仍然保留的差异

两条合成探针的显式 BE/BS 状态分别对应 flags `0x05`、`0x0d`。MDBX 和浏览器保留并正确使用这些状态，但当前 Android 签名辅助方法固定返回 `0x1d`。两项差异在 `compatibilityGaps` 中保留，`interoperabilityComplete` 仍为 `false`。不能据有效签名推定这些非默认标志能被所有 RP 接受。

本轮没有验证 Android 系统凭据选择器、真实网站的 Android 登录、当前 F-Droid、KDBX/WebDAV/Bitwarden 的当前版本链路或 OneDrive 真实账号。之前 GitHub Bitwarden Passkey 登录及响应速度的用户确认继续作为独立证据。

## 版本与构建来源

| 层 | 实际身份 |
| --- | --- |
| 扩展 | 当前未提交 `0.1.37`；HEAD `18dd08d79a5ac454cac5512f85e0dbf55141e395`，复用已构建 `dist` |
| 浏览器 | Microsoft Edge `154.0.4258.62`，三个独立配置目录（包括一次失败重试） |
| Native Host SHA-256 | `781fa5b077ff2f3b5d8ecdb392d26b42dfe865c480bc82c8e00b55f17eee6df5` |
| Android | `d7702cac415af9ca02318971aa33d61d8ec30ab8`，`1.0.318-26100912-03` |
| 运行 APK SHA-256 | `b6a3ab4d75234caafe928780be27b69c469fcfee6e950368015108c2defe223f` |
| 本轮测试 APK SHA-256 | `bab5ca5d6a30d75c20d0b6b22e745669c46be6c88e3eacac8d183f4b300b71ef` |
| 公共设备 | 已启动的 `Monica_Issue136_API_32` / `emulator-5554` / user 0 |

专用测试包使用已保存、校验过的 `83664b` 编译 API；运行 APK 始终是当前 `d7702ca`。`scripts/interop-reviewed-runtime.mjs` 重新核对先前成功构建及设备证据的哈希、当前 APK、干净产品源码、Git 树，以及两版之间唯一且精确的 `VaultOverviewConfig.scope` 默认值变更。两份 APK 始终分别记录，没有把旧编译 APK 当作新运行 APK。

构建只更新测试包，耗时 2m23s；不重新编译应用 Kotlin/Java。新增可选精简测试清单，合并后的清单没有被排除源文件对应的测试 provider；保留 AndroidX 测试运行组件。运行前检查公共设备是否空闲、当前应用及测试包哈希；测试包恢复前再次确认没有其他任务替换它。

## 结果与证据

- Android 三个阶段分别通过：生成/导出 8.865s，首次导入/签名 6.899s，Edge 返回导入/签名 8.587s。
- 三个 Native/Node 验证阶段通过：准备 2.10s、首次回传 1.57s、最终回传 2.58s。
- Edge 新建/重启通过：22.6s；最终回传/重启通过：20.0s。
- 六种错误版本/APK/构建/源码树/设备证据的负向校验均拒绝，没有尝试安装。
- 专项浏览器 TypeScript、interop TypeScript 及差异空白检查通过。本轮仅改验收工具，无需重建扩展产品。

原始证据：`.tmp/android-passkey-runtime-318/`、`.tmp/android-passkey-runtime-return-318/`；日志与浏览器追踪：`.artifacts/passkey-runtime-*318*`。当前来源/输出清单：`.artifacts/passkey-runtime-manifest-318.json`。

最终回传浏览器测试首次失败，是断言要求默认 `true` 的备份标志必须显式存储。新建凭据允许省略默认标志，应用签名逻辑已有明确默认值；已修正测试按实际语义比较，显式 `false` 仍严格检查。随后五条实际登录、签名 flags 和重启验证通过。保留原始失败及新测试源码哈希，不将首次结果改为通过。

另外，首次备份测试 APK 时 Node 默认输出缓冲不足，尚未安装任何包即终止；提高二进制读取限额后完成备份和哈希校验。首次专项 tsc 调用的 PowerShell 逗号参数错误也保留于日志，修正引号后通过。这些是验收工具问题。

原测试包 SHA-256 `980efe819f16d679356af70fc70f0e66da67718396c18cd7b906ff184682ecba` 已恢复，应用 APK 未变。三个临时 Native Messaging 注册均恢复；本任务 Edge 进程为零，配置保留。公共 AVD 原本就在运行，未停止。没有发布、推送、打标签、交付 APK 或重试先前被拒绝的缓存清理。

设置页统一及最新 `dist` 的交付见 [设置页验收](settings-pages-318.md)。Bitwarden 删除恢复、Android KDBX 分组范围、OneDrive 真实同步和完整类型/生命周期矩阵仍待完成。
