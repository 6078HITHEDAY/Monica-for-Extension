# 当前 Android Bitwarden Passkey 往返：可用性通过，字段保留失败

> 历史失败记录。2026-10-10 已在新修复版重跑：三组 Android 往返、14 份独立签名及所有回传副本的真实浏览器登录通过，见[当前验收](android-bitwarden-repaired-runtime-318.md)。下文保留旧版本失败证据。

2026-10-10：当前 Android `1.0.318-26100912-03` 与扩展 `0.1.37` 的新证据确认：单独存放的浏览器 Passkey 可经 Android 导入、签名、备注上传、空库重新导入，回传后继续在 Edge 登录。但 Android 更新单个 Passkey 会用单项模板覆盖整个 Cipher，导致共享密码和其他 Passkey 丢失。**完整互通未通过。**

## 输入与真实执行层

三份输入均由当前扩展代码生成，HTTP 响应是隔离合成数据：

| 场景 | 输入 | Android 结果 |
| --- | --- | --- |
| direct | 真实 Edge 注册的一把 ES256（16 字节 ID）与扩展核心生成的一把 ES256（32 字节 `b64.` 旧式 ID），分别保存 | 两把密钥导入、受保护存储、签名、备注上传和空库重建通过；URI 被改写，字段保留失败 |
| copies-complete | 真实 Edge/MV3 执行项目移除后生成的两个独立原生副本，0/23 存储计数 | 两把密钥和备注保持；父登录用户名、自定义字段、URI 被改写，字段保留失败 |
| copies-cancel | 同一原始 Cipher 两把 Passkey，加取消后留下的一份独立副本 | 导入三条记录成功；上传后原 Cipher 仅剩一把，空库只有两条记录且属于同一密钥，不同密钥从 2 把降为 1 把；密码及项目字段也改变 |

Android 运行真实 `CipherSyncProcessor`、Room、`PasskeyPrivateKeyStore`、`PasskeyRepository.updatePasskey` 和 `BitwardenSyncService.uploadModifiedEntries`。每个场景使用独立合成保险库及 MockWebServer，上传请求直接交给模拟的标准 Cipher 完整替换接口。没有连接真实 Bitwarden/Vaultwarden 云服务。

签名调用当前应用真实 authenticator-data 和签名辅助方法，测试传入计数零；不宣称 Android 系统 Credential Manager、真实 UV 或完整计数策略通过。存储的 0/23 计数在仍存活的条目上保持不变。**没有修改 Android 的刻意零计数设计。**

## 通过与失败分别记录

- 浏览器准备：项目移除和取消两条真实 Edge 流程通过；新注册/旧式 ID 两把密钥分别在重启前后登录，共 4 次实际 WebAuthn 断言通过。
- Android 一个仪器测试中三个场景均执行完毕：direct 与 copies-complete 的凭据及备注断言通过；copies-cancel 在空库数量断言失败。整个仪器测试按 **失败** 记录，不拆成整体通过。
- 独立 Node 验证所有已保存的 **11 份 Android 签名均有效**。进一步比较上传前后的原生 Cipher，三个场景的字段保留断言全部失败，真实失败保留为回归要求。
- Android 回传的 direct 场景在另一独立 Edge 配置中，两把凭据重启前后均能登录，另有 4 次实际 WebAuthn 断言通过。两次浏览器流程合计 8 次断言；没有把缺失凭据场景计为通过。
- 备注包含多行、`---` 和 Unicode，当前 Android 与扩展精确回读通过，旧版备注缺陷的历史结论不再用于当前版本。
- 扩展 E2E TypeScript、interop TypeScript 与测试包构建完成；本轮只增加验收工具和测试，没有修改扩展产品代码或重新构建 `dist`。

## 来源与恢复

| 项目 | 身份 |
| --- | --- |
| 扩展 HEAD | `18dd08d79a5ac454cac5512f85e0dbf55141e395` 上当前未提交 0.1.37 |
| Android HEAD | `d7702cac415af9ca02318971aa33d61d8ec30ab8` |
| 运行 APK SHA-256 | `b6a3ab4d75234caafe928780be27b69c469fcfee6e950368015108c2defe223f` |
| 专用测试 APK SHA-256 | `028a35a1621a0ede7aed8e2c2cf17f3eb27d7012199627340636ee34b064608d` |
| 已恢复的原测试 APK | `980efe819f16d679356af70fc70f0e66da67718396c18cd7b906ff184682ecba` |
| 浏览器 | 实际 Microsoft Edge 154.0.4258.62，隔离配置 |
| 设备 | 已启动公共 `Monica_Issue136_API_32` / emulator-5554 / user 0 |

测试包构建 54s，沿用此前严格核实的 83664b 编译 API 与当前 d7702ca 运行时差异证明；应用 APK 没有重装，运行前后哈希一致。每个合成库及其受保护私钥由测试清理，公共 AVD 原本就在运行并保持运行。原测试包已恢复，未清空应用数据。

证据目录 `.tmp/android-bitwarden-copies-runtime-318/`，日志与浏览器追踪 `.artifacts/bw-android-snapshot-*`；最终索引 `.artifacts/bw-android-snapshot-manifest.json`。初次新浏览器测试关闭了自动同步却未显式同步，创建停留在本地；补上正常同步调用后通过。首轮 TypeScript 指出了新夹具的 `createPasskey` 参数名错误，已修正；失败日志保留。

## 下一步

覆盖缺陷及普通版/F-Droid 的候选修复范围见[修复提案](android-bitwarden-upload-fix-proposal-318.md)。当前 Android 产品代码未改，F-Droid 只检查了对应源码路径，未做运行验收。整体目标和 Bitwarden 项目移除待办继续保持未完成；OneDrive 真实账号、系统凭据管理器、Android KDBX 分组范围和其他后端矩阵仍需继续处理。
