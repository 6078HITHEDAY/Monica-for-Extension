# 旧 mock UI 清理验证（issue #26）

基线：`0a0a3509cd780b741b004cda992251f4994805cf`，扩展 1.0.103。[Issue #26](https://github.com/Monica-Pass/Monica-for-Extension/issues/26) 提出的四个文件共 1,767 行。

## 引用核对与清理范围

- 解析 TypeScript 与 Vue SFC script 中的静态、动态导入，四个文件只有 5 条内部导入边，没有外部调用方；源码没有通过 `import.meta.glob` 或组件名注册动态加载它们。管理页仍从 `main.ts`、`App.vue` 到 `connectLiveVault` 取得实际数据。
- 删除 `src/lib/api.ts`、`src/lib/modules.ts`、`src/components/DataTable.vue`、`src/components/ProjectDetail.vue`。原 mock 快照、类型和模块注册表一起退役。
- 旧 `formatRelative`、`formatDateTime` 只服务于这条代码链，一并删除；`formatBytes` 的函数体与基线逐字一致，其现行调用点保留。
- 旧 `t` / `MessageKey` 及 `src/i18n/en.ts`、`src/i18n/zh-CN.ts` 已无消费者，一并删除。两份旧表各 284 个键，合计 568 个键值条目；不会保留只剩定义的 `modules.*`、`metrics.*`、`groups.*` 等旧键。
- 当前 `tr`、语言偏好、加载/切换逻辑及八种语言资源保留；7 份实际 UI JSON 资源（英文与六种离线附加语言）SHA-256 与基线一致，简体中文继续使用源码原文。运行中的 `VaultItemDetail.vue` 有自己的日期格式化函数，不受旧 helper 删除影响。
- 保留原来的 38 条路由和说明，归档到[历史路由规划](../architecture/legacy-server-api-reference.md)，标明来自旧 mock 的规划参考，未据此宣称服务器已经实现这些端点。

## 验证

- 全量 Vitest：353 个文件、4,465 项测试通过，耗时 259.60 秒，包含既有语言资源完整性、参数保留与切换回归。
- 实际安装的 Edge：首批 23 项通过（2.7 分钟），覆盖管理页新增入口、编辑草稿、键盘/弹层、设置保存/重试、备份导出、登录填写及 Passkey 注册/签名/取消；第二批 2 项通过（21.3 秒），覆盖八语言菜单在两种主题下保持账号原文，以及无 Native Host 的 MDBX 创建、读取、导出、锁定、重启、解锁和重新导入。
- 本轮共 25 项浏览器功能检查通过，未跳过、未修改已有断言，也没有失败后重跑的情况。两批 23 + 2 个自有测试配置目录均完成自动清理。

完整构建和 TypeScript production/interop 检查通过，build ID 为 `ee41ae427e083eab6406`；运行时共 231 条命令，29 项正负向审计用例通过，实际 bundle 安全审计通过。构建仍有既有大 chunk 提示。

本轮使用既有测试验证活跃界面和接口，没有增加仅检查“文件不存在”的镜像测试。真实 Edge 验证使用合成账号/库，不能代替真实云账号、Windows Hello 硬件或所有网站兼容测试。

版本、加密格式、密码源绑定、原生组件可选性及已发布说明均保持。原始导入图、路由和翻译清单、原始日志保存在本地忽略的 `.codex-tasks/20261101-issue-26-mock-cleanup/`；验证后另清理 4 处编译缓存和测试构建副本，释放 25.8 MiB，保留现行构建、Release 包、依赖和证据。
