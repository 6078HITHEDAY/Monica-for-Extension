# 独立导入与导出页面

2026-10-23，开发版本为 1.0.102；本次内容已纳入正式发布说明和验证记录，不单独创建旧版本标签。

## 行为与范围

设置中的“导入与导出”独立于“加密备份与恢复”。导入先读取和预览，确认后才新增本地副本；重新生成项目 ID、重映射关联、移除远端 provider 引用，不覆盖既有项目。导出显示当前格式可承载的项目数量，每次通过现有主密码或 Windows Hello 验证路径取得可导出的数据；取消和离开页面会清理临时文件密码。

| 格式 | 导入 | 导出与限制 |
| --- | --- | --- |
| Monica ZIP | 明文及 Monica 加密 ZIP | 可选独立文件密码；复用 Android 备份编解码 |
| KeePass KDBX | 密码和可选密钥文件 | 必须设置密码；保留分类、笔记与 OTP 参数 |
| Monica JSON | 本地项目及凭据 JSON | 保留插件项目字段 |
| Bitwarden JSON | 未加密登录、笔记、卡片、身份和 SSH 项目 | 转换为本地可编辑、可删除项目；加密导出提示先解密 |
| CSV | Chrome、KeePass、Bitwarden、Proton Pass 等常见列名及验证器 CSV | 登录项；保留引号、换行、账号和密码空格、OTP 与分类 |
| Aegis | 明文和 scrypt/AES-GCM 加密备份 | 明文 TOTP/HOTP JSON |
| Stratum | 明文 JSON、现代 Argon2id/GCM 与旧版 PBKDF2/CBC、TXT/HTML URI | 明文 TOTP/HOTP JSON |
| OTP URI | TOTP/HOTP、Steam 等现有 OTP 解析器支持的 URI | 文本 URI 列表 |
| Steam maFile | 明文文件及多账户 maFile ZIP | 单账户 maFile，多账户 ZIP；保留原始 Steam 元数据 |

手动迁移不包含附件二进制、连接配置或回收站。ZIP/KDBX 内发现附件时会提示；未知记录显示只读范围，无法识别的 CSV 行及不支持的验证器会统计跳过数量。完整插件恢复继续使用原来的加密整库备份。Android 对 Steam maFile 要求 serial_number；只有验证码密钥的记录不能凭空补出此元数据。

文件大小上限 64 MB，密钥文件 1 MB，项目数量 100,000；复用 ZIP 安全检查并限制 Aegis 派生参数。HTML 仅提取 URI，不执行或插入 HTML。中文及英文新文案齐全，其他六套离线词库的新文案使用英文回退，原有本地化内容保留。

## 设计与实际渲染

本地 M3E Canvas 使用项目标识 `extension-import-export`，三页分别为格式入口、导入预览、导出文件，采用 listItem、select、textField 和 button 组件。草图 JSON、完整 `#docz=` 链接及预览截图保存在本地 `docs/design/import-export/`，均被忽略，不入库。打开 `canvas-url.txt` 中的完整链接可重建草图；`scripts/verify-file-transfer-output.mjs` 验证实际载入的标题、页数和组件数量，并进入单页预览。

真实 Edge 检查了桌面、390px 窄屏与 320px/200% 字号，无横向溢出。测试截图仅保存在被忽略的测试输出目录。

## Android 实际互通

复用公共 `Monica_Issue136_API_32`，使用现有测试用户 10。应用从当前 Android 源码构建为 `1.0.321-26102312-02`；测试采用独立临时 KDBX 目标，最后只删除自身创建的测试库，不清空公共应用数据。Android 源码未因本任务修改。

1. 插件生成含中文、emoji、引号、CRLF 和首尾空格的合成文件。
2. Android 实际读取插件 ZIP、KDBX、CSV、Aegis、Stratum、OTP URI、Steam maFile，全部通过。
3. Android 从 ZIP 导入目标导出加密 ZIP 和 KDBX；另打开插件 KDBX 再导出一份 KDBX。
4. 插件逐一读取以上三份 Android 返回文件，均为 3 项，账号、密码、笔记内容及 SHA256/8 位/60 秒 OTP 参数精确一致。

ZIP/KDBX 完成双向返回验证；CSV/Aegis/Stratum/OTP/maFile 完成插件到 Android 的实际读取验证。Aegis 和 Stratum 加密格式另用独立合成加密样本验证正确密码、错误密码、篡改和资源限制，不把它们描述为第三方应用真机验证。

原始结果：`.tmp/file-transfer-interop/android-instrumentation.txt`、`android-result.json`、`extension-readback.json`。可提交的无敏感结果摘要见同目录文档旁的 `import-export-20261023-results.json`。

## 重复验证

最终结果：118 个相关单元测试文件、1,704 项测试通过；3 项真实 Edge 流程通过；Android 独立 instrumentation 和三份返回文件的严格回读通过；生产构建、类型检查与安全审计通过。安全审计解析 224 条运行时命令，确认 24 条管理页专用命令的边界。大并发首轮中两项附近同步测试触发默认五秒超时，限制为两个测试 worker 后整组通过，未修改附近同步实现或放宽断言。

整理后的互通脚本另在公共 AVD 重启后完成复跑，验证了启动既有测试用户再导入文件的流程。复验完成后关闭本次重新启动的 AVD，保留其配置和数据盘。

```powershell
pwsh -File tests/interop/android-file-transfer/run.ps1
npx vitest run src/manager src/providers/keepass src/providers/webdav src/security src/i18n --maxWorkers=2
npm run build
node scripts/security-audit.mjs
npx playwright test tests/e2e/import-export-settings.spec.ts tests/e2e/settings-pages.spec.ts
node scripts/verify-file-transfer-output.mjs
```

互通脚本要求已启动公共 AVD，复用现有用户；默认构建应用和测试包，已完成相同源码构建时可传 `-SkipBuild`。需要本机 Android SDK、Android Studio JBR 及 Android 项目已配置的构建依赖。脚本明确检查 instrumentation 的 `OK (1 test)`，不以 adb 退出码判定测试成功。

Edge 流程验证错误文件密码不产生预览、确认前密码库为空、导入后的项目无远端引用、错误主密码被拒绝并清空输入、JSON/ZIP/KDBX 每次重新验证后真实下载，以及原有设置导航和加密整库备份未回归。测试浏览器使用隔离配置并在结束时清理。
