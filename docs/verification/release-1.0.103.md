# 1.0.103 发布验证

日期：2026-10-31。扩展版本 1.0.103，Windows x64 可选助手 0.1.5。
正式标签为 `v1.0.103`，指向 `6596e003cefe0fd8b8b32e3645adf6eccd86961a`。
正式 Release 于 2026-10-31 14:28:20 UTC（北京时间 22:28:20）公开，
已设为最新正式版本，`draft=false`、`prerelease=false`。
[公开 Release](https://github.com/Monica-Pass/Monica-for-Extension/releases/tag/v1.0.103)
ID 为 `429980594`。

## 发布准备

- `package.json`、lockfile 两个根版本及浏览器 manifest 同步为 1.0.103；
  Host crate 及其 lockfile 同步为 0.1.5，没有更新其他 Rust 依赖版本。
- 本机 TypeScript、完整扩展构建、内置 WASM 来源和页面资源检查通过；
  本版构建标识为 `14ab010da0d35b85e20e`。
- 既有业务验证为 347 个文件、4,423 项单元测试及 119 项 Native Host
  测试通过；实际 Edge 的八项 Bitwarden 与五项首次导入回归通过。
  发布前界面收尾另有 15 项视觉/交互及三次设置菜单复测通过。
  此处既有测试不冒充版本切换后的完整 CI 结果，来源见
  [发布就绪检查](extension-release-readiness-20261031.md)与
  [安全跟进](extension-integration-security-20261031.md)。
- 本版中英文说明归档到
  [1.0.103 发行说明](../releases/Monica-Extension-1.0.103.md)；
  1.0.102 已发布归档保持原样，下一版说明仅记录后续新增改动。

## 发布条件与附件

正式发布使用版本提交上通过完整 Linux 发布门禁及 Windows Edge/Host
验证的 CI 核心文件和 Host。上传前核对两个 ZIP 的 SHA-256、内嵌源提交、干净工作树、
版本及清单；正式标签与产物源提交相同。只上传扩展 ZIP、可选助手 ZIP
及各自 `.sha256`，SBOM/许可证/来源 JSON 保留在 ZIP 内。
Firefox 未签名 XPI 保留在 CI artifact，不作为正式公开安装附件。

普通 MDBX 使用扩展内置 WASM；助手为 Wi-Fi 同步等本机能力的可选组件。
旧 Native Host 工作副本保留原后端，迁移需明确操作。

## 验证范围

测试使用隔离合成数据，不读取个人浏览器配置或密码库。
原反馈的官方 Bitwarden 云账号、Windows Hello 故障设备和真实 OneDrive
账号互通仍待确认；模拟服务和无提示协议探测不等于真实账号或物理硬件验收。
早期 CI/自动化失败及历史扫描误报归因保留在相关验证记录中，跳过用例不计通过。

## 最终门禁结果

[CI 41206087999](https://github.com/Monica-Pass/Monica-for-Extension/actions/runs/41206087999)
在上述发布提交上全部通过，包含 Linux、Windows 及滚动 Preview 更新。

| 检查 | 最终结果 |
| --- | --- |
| Linux 全量单元测试 | 347 个文件、4,423 项通过 |
| Bitwarden 合约互通 | 2 项通过 |
| 安全测试及审计 | 703 项通过；230 条运行命令和管理端口边界通过 |
| Linux Chromium E2E | 162 项通过，227 项按平台/显式开关跳过；跳过不计验收 |
| Native Host 测试 | Linux、Windows 各 119 项通过；Clippy 通过 |
| Windows 实际 Edge 核心验收 | 13 项通过 |
| Windows Passkey 用例 | 2 项通过；不作原反馈设备或实体硬件验收 |
| 版本切换后本机 Edge | Bitwarden/首次导入 13 项通过，1.8 分钟；14 个独立配置清理完成 |
| 最终 Wi-Fi 安装包下载入口 | 实际 Edge 1 项通过，8.6 秒；下载字节与内嵌安装 ZIP 一致，配置清理完成 |
| Firefox | 独立未签名构建和包检查通过；本轮未额外做 Firefox UI 验收 |
| CodeQL、Secret Scan、Scorecard | 发布提交上均通过 |
| 扩展及 Host 包验证 | 来源、清单、哈希和两次独立打包一致；安装脚本策略检查通过 |

前轮 `41205447509` 在版本提交替代它后取消，未冒充完整通过结果。
本机首次 Host 验证误传了验证器不支持的 `--output-dir`，导致读取默认
`release/` 时找不到文件；按默认目录重打包后验证通过。Wi-Fi 单项首次
筛选使用了不适用于完整测试名的开头锚点，未找到测试；修正筛选后取得上述
实际通过结果。原失败命令不计通过，日志留在 workspace `.codex-tmp/`。

## Windows 完整扩展包

Linux CI 通用 ZIP 的 `nearby-helper/availability.json` 为 false，未附带
Windows 通信组件安装 ZIP。正式包保留该 CI 的所有 JS/CSS/WASM 和页面文件，
通过现有 `build-nearby-setup.mjs` 将同次 Windows CI 的 0.1.5 Host 二进制
补入 `nearby-helper/monica-wifi-windows-x64.zip`，并将可用状态设为 true。
内嵌二进制与单独发布的 CI Host ZIP 内二进制逐字节相同。

与 CI 归档相比，1,147 个已有文件逐字节不变；新增内嵌安装 ZIP、更新
其可用状态，并由标准打包器重新生成四个发布证据文件。源码工作树保持干净，
源提交和版本没有改变。最终包再次通过页面、安全审计、独立重复打包和实际
Edge 下载入口验证。普通 MDBX 仍使用内置 WASM，安装通信组件仍为可选操作。

CI 原始通用 ZIP 的 SHA-256 为
`d56c365c923e4a4752334d32cf4c8f3ff4a3497fc9df0014f1cb282b196c4961`。
其 GitHub 来源证明已用 `gh attestation verify --deny-self-hosted-runners`
验证，来源为该提交的 GitHub hosted CI。此证明覆盖 CI 原始 ZIP；
补入 Windows 安装包后的正式 ZIP 使用下表的最终哈希及本机打包/上传校验记录。

下载的 CI Host 做了临时隔离目录中的无提示 `host.hello` 和 `hello.status`
探测：实际报告版本 0.1.5、协议 2、附近传输协议 2，Windows Hello 本机
能力为不可用，没有注册或读取个人绑定；临时目录已清理。

## 公开附件

| ZIP | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| `monica-extension-1.0.103.zip` | 14,001,977 | `47ddf7b090a9c06c634c0e9cceb873383c13ba15d485d63797e57b88547bc7d8` |
| `monica-mdbx2-host-windows-x64-0.1.5.zip` | 3,703,235 | `98796a1702d7a54d2ab7c90c7ae98357b8e77845456e07dd654f536d00e13508` |

只公开上述两个 ZIP 和各自的 `.zip.sha256`。四个附件全部重新下载，字节、
大小和 GitHub 记录的 SHA-256 与上传源文件一致；标签、内嵌来源和版本匹配。
中英文发行说明已归档，下一版记录已清空并保留为版本待定，未提前切换 1.0.104。
