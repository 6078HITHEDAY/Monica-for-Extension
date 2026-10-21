# 密码源分组列表与设置开关居中（2026-10-21）

密码源的五个连接入口与设置首页共用 `GroupedSettingsList.vue`，统一为连续列表：相邻间隔 4px、外侧圆角 24px、相邻圆角 4px、圆形 40px 图标、每行左右 16px 留白。密码源内容宽度与设置页统一为最多 900px，连接入口保留名称、说明和箭头，支持原生按钮的键盘操作。已连接密码源的状态及管理操作保留。

CLI 联动、自动同步、表单旁自动填充的开关跨越标题和说明两行，说明在左列换行。开关轨道与这两行组成的整体垂直居中，错误或保存状态仍在行外显示。

## 本地设计

实施前已使用本地 M3E Canvas 制作并检查密码源和设置预览，设计与截图只留在本地：

- `docs/design/provider-settings-20261021.m3e.json`
- 完整编辑链接：[本地 Canvas 链接文件](../design/provider-settings-20261021-url.txt)
- `docs/design/provider-settings-20261021-canvas.png`
- `docs/design/provider-settings-20261021-switch-canvas.png`

## 验证

- `npm run build` 通过，已更新 `dist`。TypeScript、图标、原生组件清单及扩展页面检查通过；仅保留既有产物体积警告。
- 使用实际安装的 Edge 运行 `settings-pages.spec.ts`、`visual-polish.spec.ts`、`cli-management.spec.ts` 中相关 4 项场景，全部通过。
- 开关几何验证：桌面深色、桌面浅色、320px／200% 字号下，三个开关轨道与整行中心线偏差均不超过 1px，且不超出行边界。
- 验证分组圆角、间距、统一宽度、图标居中、360px／125% 及 320px／200% 字号下的连接文案换行和无横向溢出。
- 验证键盘 Enter 打开 MDBX2、WebDAV 对话框、设置页面焦点恢复、深浅模式与强制颜色下的焦点、开关保存、配置取消及加密备份导出。
- CLI 默认隐藏、偏好持久化、跨窗口更新及关闭时断开连接的已有场景通过。
- 已检查桌面密码源、深色设置及窄窗口实际截图；4 个临时 Edge 配置已清理。`git diff --check` 通过。

本地证据：`C:/Users/joyins/AppData/Local/Temp/monica-provider-settings-20261021/edge/`。本次只调整扩展界面，未使用 Android 虚拟机，未提交或发布代码。
