# Firefox 桌面版

当前源码版本为 **1.0.101**，支持 Firefox **153 及以上**。最低版本来自敏感操作对浏览器原生 `documentId` 的要求；不会通过省略页面身份检查兼容更旧版本。Windows 上已使用 Firefox 155.0.1 验证，其他桌面系统和 Firefox Android 尚无实际验收证据。

## 构建与本地安装

```powershell
npm ci
npm run build:firefox
npm run package:firefox
```

Edge/Chrome 加载 `dist/`；Firefox 使用 `dist-firefox/`，不要混用清单。Firefox 打开 `about:debugging#/runtime/this-firefox`，选择“临时载入附加组件”，打开 `dist-firefox/manifest.json`。也可选择生成的 `.artifacts/firefox/monica-extension-1.0.101-firefox-unsigned.xpi`。临时加载的扩展在退出 Firefox 后需要重新载入，修改文件后需要在调试页面重新加载。

XPI 是本地未签名测试包。普通 Firefox 永久安装和分发需要 Mozilla 签名；当前未提交 AMO、未签名或发布。提交前还需按实际的可选同步、网站填充和认证数据用途填写 Mozilla 数据收集声明，不能未经核对声明所有功能都不传输数据。保留已有安装使用的附加组件 ID，避免新建平行密码库。

## 功能与本机组件

Firefox 使用自己的侧栏 API。内置 MDBX 引擎运行于私有后台 iframe，浏览器不支持的 Chromium offscreen、sidePanel、favicon 权限不进入 Firefox 清单。密码库页面、本地库、填充、Passkey、多选、备份和更新检测使用共同代码。

固定附加组件 ID：`monica@monica-pass.github.io`。设置页面自动生成 Firefox 安装命令，本机助手必须使用独立的 Mozilla Native Messaging 清单及 `allowed_extensions`，不能复用 Chromium 的 `allowed_origins`。

可选 MDBX/Windows Hello 助手和 Windows Wi-Fi 组件的安装脚本接受 `-FirefoxExtensionId 'monica@monica-pass.github.io'`，可与原有 Edge/Chrome 注册共存。Windows Hello 本机硬件验证未在这次验收中执行。

CLI 联动仍默认关闭，开启入口继续标注“不完善”。CLI 辅助程序需包含 Firefox 启动支持（集成修订 2），使用 CLI 项目的 `scripts/install-browser.ps1 -FirefoxExtensionId 'monica@monica-pass.github.io'` 安装；完整参数以设置页命令和 [CLI 联动说明](CLI-INTEGRATION.md)为准。旧版辅助程序需要更新。

OneDrive 的 Microsoft 应用必须将以下地址注册为 SPA 重定向 URI：

```text
https://f8bbc9f1d8ddc2cfc3d3e3082d3d44219d7d3b9b.extensions.allizom.org/onedrive
```

该地址来自固定附加组件 ID 的 Firefox `identity.getRedirectURL('onedrive')`。代码仅接受此精确 Firefox 主机，并保留 PKCE、state、路径及返回地址校验。微软应用注册由应用管理者配置；这次未使用真实云账户登录，不能把回调校验通过视为生产应用授权配置已完成。

## 验证

`npm run test:firefox` 构建并启动全新的任务测试配置，依次执行生产功能和 UI 验收。Windows 需安装 Firefox，并在工作区 `.tools/geckodriver/geckodriver.exe` 提供 geckodriver。UI 验收的本机握手还需要本扩展与 CLI 项目构建好的 Windows release 辅助程序。测试不会读取个人 Firefox 配置或密码，剪贴板测试使用内存替身。

更多范围与限制见 [Firefox 验证记录](verification/firefox-20261021.md)。
