# 统一设置入口与二级页面

> 历史方案。2026-10-11 已按用户反馈改为常用设置直接操作、合并重复入口及紧凑分组，当前实现见 [设置分组与紧凑布局](settings-arrangement-318.md)。以下保留当时的验收记录。

2026-10-09，浏览器插件 0.1.37，本地构建已更新 `dist`。

设置首页的十个入口统一为图标、标题、说明和右箭头，统一圆角、间距、背景和点击区域。语言、外观、自动同步、表单旁自动填充、排除项、Windows Hello、加密备份、保护方式、明文迁移、安全边界全部进入二级页面。

二级页统一返回栏；进入时聚焦标题并回到顶部，返回时恢复入口焦点和列表滚动位置。首页不再混用展开面板、开关、表单和外观弹窗。具体操作仍保留必要的导出密码与安全确认对话框。离开保护方式或备份页时清空未提交的密码与所选恢复文件。

窄屏排除项表单改为单列，保护方式与恢复密码使用可换行的完整标签；外观显示模式改用纵向单选，避免 320px / 200% 字号下丢失文字。移除了外观页重复说明和设置首页空白工具栏高度。

## 设计与真实渲染

- [本地 M3E Canvas 可编辑草图](design/settings-pages-318.md)，JSON 为 `design/settings-pages-318.m3e.json`。六页草图已通过本地编辑器导入和 Edge 渲染。
- [真实桌面设置首页](../.artifacts/settings-pages-edge-verified/settings-pages-all-setting-fa1fc-return-at-desktop-and-320px/settings-dark-desktop.png)。
- [200% 字号密码页顶部](../.artifacts/settings-pages-edge-verified/settings-pages-all-setting-fa1fc-return-at-desktop-and-320px/protection-320-200-top.png)及[底部操作](../.artifacts/settings-pages-edge-verified/settings-pages-all-setting-fa1fc-return-at-desktop-and-320px/protection-320-200-bottom.png)。
- [200% 字号完整显示模式选项](../.artifacts/settings-pages-edge-verified/settings-pages-all-setting-fa1fc-return-at-desktop-and-320px/appearance-modes-320-200.png)。

## 验证

- 真实安装的 Edge 154，隔离测试配置和合成密码库；14 个不同场景通过。首轮 13/14 通过，设备密钥恢复测试仍定位旧 hint 插槽；更新定位后该场景单独通过（6.4s）。记录：`.artifacts/settings-pages-edge-final.log`、`.artifacts/settings-device-key-verified.log`。
- 最后外观单选调整后，4 项相关复验通过（28.4s）：入口和焦点、全部二级页、320px / 200% 大字号、实际设置保存/导出、主题持久化和大字号布局。记录：`.artifacts/settings-pages-edge-verified.log`。
- 原有流程回归覆盖语言与弹出页联动、开关写入失败及重试、主密码轮换与旧密码拒绝、加密备份原子恢复、设备密钥模式恢复、导出取消与密码不一致拒绝、排除项保存/取消、Windows Hello 设置与确认重试。Hello 可用性和注册确认使用测试响应，不表示实体生物识别验收。
- TypeScript 两套配置、生产构建、234 个图标和 3 个入口资源检查通过：`.artifacts/settings-pages-build-verified.log`。
- 安全审计通过，212 条命令、24 条仅管理页命令：`.artifacts/settings-pages-security-verified.log`。
- Canvas 的新增 radio 草图曾误用 selected，改为 checked 后六页导入渲染通过；保留失败记录与最终 `.artifacts/settings-pages-canvas-accepted.log`、`.codex-tasks/android-interop-315/raw/settingshome318-canvas.json`。

本轮为设置界面整理，未修改 Android、Passkey 密钥/ID/计数、版本或发布状态。未推送或发布。本轮通过不代表此前 Android、真实 OneDrive 或 Bitwarden 互通待办全部完成。测试浏览器已关闭，隔离配置与证据保留。
