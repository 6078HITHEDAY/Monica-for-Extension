# 1.0.103 发布验证

日期：2026-10-31。扩展版本 1.0.103，Windows x64 可选助手 0.1.5。
目标正式标签为 `v1.0.103`。

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
验证的 CI 产物。上传前核对两个 ZIP 的 SHA-256、内嵌源提交、干净工作树、
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

正式发布后在此补记实际 CI、产物源提交和公开附件哈希。
