# CLI 图形管理联动验证（2026-10-21）

CLI 联动仍默认关闭并标记「不完善」。协议 2 增加版本/能力协商、持久化写入回执、密钥文件认证、SSH 生成与 SSH/OpenPGP 导入、明确权限的 AI 授权创建/续期，以及同步 CLI 已配置的 WebDAV。数据库认证、Tiga 和实际写入仍由 CLI 负责，已有秘密不返回浏览器。

## 自动检查

- CLI 客户端、恢复记录、本地翻译与原全局翻译：40 项通过。本地完整性覆盖直接文案和动态错误/操作/标题映射，不跳过全局验证，不抬高 TypeScript target/lib。
- 严格全目标 Clippy 和 release 构建通过，CLI 与辅助程序均已生成；全量 `test --release --all-targets --locked -- --test-threads=1` 退出码 0：372 项通过、0 失败、3 项原有忽略（需独立 Android 合成夹具）。其中库测试 294、命令语法/输出 39、CLI 管理 22、兼容/剪贴板/语言/便携 17；15 项 browser/receipts 回归全部通过。`fmt --check` 通过；最终扩展 build 已通过并冻结在 d9854431c308eac1c210。
- 安装脚本实际验证双浏览器独立 manifest、单独更新 Edge 不影响 Chrome、兼容版本/能力、便携未初始化状态、缺失辅助程序和错误 origin；原注册表完整恢复。

## Edge 实际验收

Windows 安装版 Edge、临时便携配置和合成数据库运行 `MONICA_CLI_INTEROP=1 npx playwright test tests/e2e/cli-management.spec.ts`，最终 release host 共 2 项通过（约 1 分钟），使用冻结的生产扩展，含二进制密钥文件解锁、敏感操作重新提交认证因子及失焦清除；此前 debug host 一轮通过（5.8 分钟），另有两轮旧基线通过。默认关闭、启用后持久化、关闭后即时隐藏入口并退出管理页的用例也通过。

本轮丢弃实际成功写入的回复，再重连/解锁查回执；只发送一次且只新增一个目录。密码并发版本冲突产生未确认结果，重新解锁后需本人检查和确认，不自动重发。另覆盖目录/密码选择字段替换、连接创建、撤销授权、默认只读授权创建、续期轮换凭据并保留范围/次数、SSH 生成、GPG 私钥导入及仅摘要展示、页面离开与标签切换锁定。

额外 12 轮锁定/解锁与每三轮主动切换设置页均保持正确导航。历史 trace 曾出现解锁后落在设置页且开关仍启用，本次未复现；不宣称找到根因或已修复，未修改 App.vue。仅记录公开导航标签和操作 ID，不记录输入或秘密。

最终 release 证据：`%TEMP%/monica-cli-edge-g0RQ4v/`；随后将配置秘密排除断言放到换库前再跑实际联动，42 秒通过，证据 `%TEMP%/monica-cli-edge-8ihTPc/`；此前 debug 证据：`%TEMP%/monica-cli-edge-NESMth/`。`native-host-evidence.json` 确认注册恢复；profile 和复制的辅助程序已移除。设计使用本地 M3E Canvas，草图在 `docs/design/cli-recovery-20261021.m3e.json`，同名 URL 文本保留隔离 project 的本地链接。图片与草图仅留本地，不作为提交图片证据。

## 支持边界

Chrome 注册已验证，未单独运行 Chrome；其他操作系统未验收。共享同步的假 TLS WebDAV 测试覆盖密钥文件和库身份/路径固定，浏览器同步表单未连接真实服务验收。程序化文件选择与显式 blur 测试不等同于全部原生系统选择器验收。密钥文件/导入文本最多 32 KiB，大文件继续使用 CLI。

回执在调度前持久化 intent，跨进程独占，未知 intent 永不重放；日志不保存原请求或秘密。最多 4096 条且不淘汰旧 ID，满后改用 CLI；浏览器最多保留 64 项未确认公开身份。无回执不能推断没有写入，仍需本人核对。方法见 [CLI-INTEGRATION.md](../CLI-INTEGRATION.md)。

Rust 缓存整体迁至 E 盘，C 盘 target 为目录联接，复用约 11.14 GiB 缓存；迁移后 C 可用空间从约 35.25 GB 增至 44.93 GB。未创建第二套 target，未提交、推送或发布。
