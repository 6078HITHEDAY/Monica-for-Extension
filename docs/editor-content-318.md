# 新建页补充内容统一

2026-10-10，浏览器插件 0.1.37。已更新本地 `dist`。

参考 Android 的 `EntryContentPanel` / `EntryEditorSection`：主编辑页显示内容摘要，点击进入独立编辑层，完成或返回后继续编辑原项目。浏览器侧共用 `EditorContentSection`，统一图标、标题、状态摘要、右箭头、圆角和点击区域。

登录项目的支付、个人信息、地址、两步验证、登录方式、自定义字段、备注、其他凭据组和更多选项使用相同入口。关联笔记和恢复备注在同一编辑层；收藏、归档及免解锁填写集中到更多选项。内容排序单独打开，API/SSH/GPG/二维码和完整副本集中到添加内容选择页。现有内容的删除、附件、未知字段保护及顺序存储继续保留。

银行卡、证件、地址、支付账户复用相同入口组件，保留上下移动操作。独立 API 密钥、安全笔记和验证器的底部补充内容也使用相同编辑层。验证器未新增自定义字段能力。

子页面字段仍属于当前项目草稿，返回不丢失；只有主页面的加密保存才写入项目。Enter 不会意外提交主表单，Esc 关闭当前编辑层。摘要不显示密钥或自定义字段秘密值。移除了页面强制 320px 最小宽度，避免窄屏原生滚动条占用空间后产生横向溢出。

## 设计和验证

- [本地 M3E Canvas 草图](design/editor-content-318.md)，对应 JSON 已保存；三个页面通过本地编辑器导入和真实 Edge 渲染。
- [最终浅色页面](../.artifacts/editor-content-edge-verified/editor-content-supplementa-23dcf--editors-that-retain-drafts/content-list-light.png)、[深色页面](../.artifacts/editor-content-edge-verified/editor-content-supplementa-23dcf--editors-that-retain-drafts/content-list-dark.png)、[320px / 200% 字段](../.artifacts/editor-content-edge-verified/editor-content-supplementa-23dcf--editors-that-retain-drafts/custom-fields-320-large.png)已检查。
- 14 个不同的真实 Edge 场景通过，使用隔离合成密码库。覆盖添加/排序/保存/重开、主密码项目自定义字段完整保留、API 密钥、钱包字段及排序、OTP 绑定与解除、HOTP/剪贴板失败、锁定清理、8 种语言大字号布局。
- 最终批次先通过 13/14；剩余用例错误地点击排在第一位的内容的“上移”禁用按钮，改成选择可用方向并验证实际顺序变化后，两项新用例通过（14.5s）。此前错误的创建按钮定位、失败日志和横向溢出诊断均保留。没有延长超时或放宽验证。
- 两套项目 TypeScript、E2E TypeScript、生产构建、236 个图标、3 个入口资源校验及安全审计通过。日志：`.artifacts/editor-content-build-verified.log`、`editor-content-e2e-types-final.log`、`editor-content-security-final.log`、`editor-content-edge-final.log`、`editor-content-edge-verified.log`。

此 UI 批次未改变同步格式、Passkey ID/密钥/签名计数、发布版本或 Android UI。Android 备份标志修复的两版构建和单元测试已独立完成，实际系统登录验收仍待继续；本报告不代表整体跨端互通完成。未发布或推送。
