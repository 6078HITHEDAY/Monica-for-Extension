# 顶部统一筛选验证（2026-10-21）

列表上方移除数据库选择、收藏快捷按钮、筛选摘要及清除按钮，统一使用搜索栏旁的“筛选”。结果数和 Passkey／Steam 批量传输入口保留。登录项页不再显示可见标题和解锁说明，保留供辅助技术读取的一级标题。

筛选弹窗先展示可组合的常用条件，再展示项目类型、数据库及文件夹。桌面范围选择并排，窄窗口单列；选中条件显示勾选状态，底部固定展示结果数、清除和完成。无条件时禁用清除。修正 M3E 选择器空值导致“全部类型”不显示的问题，隐藏无内容的辅助行。

## 设计

已先在本地 M3E Canvas 制作、载入并检查单页预览，再实施原生界面。以下设计文件和图片只留在本地，不提交：

- 可编辑 JSON：`docs/design/unified-filters-20261021.m3e.json`
- 完整本地编辑链接：[Canvas 链接文件](../design/unified-filters-20261021-url.txt)，使用 `http://127.0.0.1:5186/?project=monica-unified-filters-20261021#docz=…`。
- 预览：`docs/design/unified-filters-20261021-canvas.png`

## 验证

- `npm run build` 通过，更新 `dist`；保留现有产物体积警告。扩展页面和原生组件清单检查通过。
- `npx vitest run src/manager/folder-scope.test.ts src/manager/login-source-scope.test.ts src/i18n/runtime.test.ts`：3 文件、33 项通过。
- 实际安装的 Edge：`vault-navigation.spec.ts`、`password-flat-list.spec.ts`、`wallet-content-order.spec.ts`、`section-transfer.spec.ts`，5 项通过。
- 修正默认类型与放大文字样式后，导航及钱包 2 项复验通过；最后修正辅助行隐藏参数后，导航场景再次通过。
- 覆盖数据库、收藏和类型组合，文件夹筛选，切换数据库重置文件夹，零结果，清除全部条件，导航范围持久化，以及 Escape、Tab 循环和关闭后的焦点返回。
- 保留旧版分组数据；验证登录列表、钱包嵌套编辑及 Passkey／Steam 筛选后的批量传输。
- 检查桌面浅色和登录列表深色截图、360px／125% 及 320px／200% 字号；弹窗无横向溢出，底部操作保持可见。临时 Edge 配置均已清理。
- `git diff --check` 通过。

首轮语言测试发现已有附近同步新增的两条英语键未覆盖其他语言，导致语言目录校验失败及回退英文；补齐六种语言后 33 项全部通过，最终 dist 也已包含补齐的语言包。

本地测试证据：`C:/Users/joyins/AppData/Local/Temp/monica-filter-redesign-20261021/`。最终界面截图在 `edge-compact/`，较早的完整回归在 `edge/`。本次未修改 Android、未使用虚拟机，未提交或发布代码。
