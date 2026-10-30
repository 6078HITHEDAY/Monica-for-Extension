# Current Android system Passkey acceptance — 2026-10-10

## 中文

普通版 `1.0.318-26101012-05` 已完成真实 Android API35 系统凭据管理器验收。浏览器原先创建并经 MDBX 导出的 RSA 凭据，在系统选择器和实际主密码验证后通过原始公钥校验。另验证两种明确的备份标志。Android 产品源码、私钥、凭据 ID 和有意设计的零计数签名策略均未修改。

| 场景 | 结果 |
| --- | --- |
| 原始 Edge RSA、旧 NULL 备份字段 | 签名、挑战、原生应用证书来源、userHandle、ID、flags29、count0 全部通过；数据库继续保留 NULL，不重写旧记录 |
| BE=true／BS=false，零计数 RSA | flags13 及原始公钥签名通过 |
| BE=false／BS=false，原有计数43的 ES256 | flags5、ID及签名正确；Android仍返回0，严格要求计数增长的测试RP拒绝43→0，保留此兼容限制 |
| 错误主密码 | 实际“密码错误”界面，无认证响应；所有记录的身份、密钥引用、计数和使用次数不变 |
| 系统取消及 Monica 页面的取消 | 均返回 TYPE_USER_CANCELED；Monica取消不再打开密码对话框；存储不变 |
| 不存在的 allowCredentials ID | 生产服务实际返回0条Monica凭据，系统只显示其他设备选项；用户关闭该提示后返回TYPE_USER_CANCELED，无签名和存储变化 |

最后一项不冒充 TYPE_NO_CREDENTIAL。独立检查请求中的未知ID、服务新增日志、系统实际XML、无认证响应及数据库快照；原有签名验证器未放宽凭据匹配和计数规则。

验收使用已有 `Pixel_Fold_API_35`、emulator-5560。最终夹具6.662秒完成并正常退出，随后所有认证由普通应用进程处理；三个系统签名通过独立公钥校验。五条Room记录的ID、用户信息、算法、备份字段及受保护密钥引用摘要保持一致；只允许三个成功签名产生的既定计数及使用次数变化。未选中的两条记录完全不变。五次只读SQLite快照均通过完整性检查。

### 来源与边界

- App SHA256：`aa18da859855ae330eeec3f88ccaadd7fdfac27bc8dc56865d629926ec37b74b`；复用最新筛选修复后的普通版构建输出，没有重新构建应用。
- 复用编译API SHA256：`820a8672904dd04675b39cf54d1bc38281486eb00a7dd0ef69ff2624e7ee7ea6`。
- 最终专用测试APK SHA256：`d7ca5b6121c5c46c6fbd1747d0ff19a5609b83ff0955e0b2e56da0812de2dc11`。
- 测试编译前后及最终核对保存3076个当前应用源文件摘要；修复报告覆盖的源码中仅列表页面已被后续筛选任务更新，未把旧报告当作全部源码来源证明。
- 使用此前真实Edge导出的同一合成MDBX，SHA256为`19954a4768355d6395756791ab7360c1fcd7a724936830eb21b054e86054f296`。这次没有重新注册浏览器凭据。
- 原生RP独立签名，不注入origin、clientDataHash或认证响应；不声称已测试Android浏览器来源、DAL、生物识别硬件、真实网站、F-Droid新构建或全部后端。
- 两轮均只安装基线不存在的三个测试包，随后核对包摘要、卸载测试包并恢复凭据提供方和输入法设置。任务启动的API35已关闭，公共API32继续保留。

### 测试基础设施修正

第一轮交互等待达到20分钟，夹具超时后清理记录，因此其三个签名及取消结果只保留为部分证据，不能证明完整生命周期通过。最终改为显式的fresh-install seed-only模式，由主机安装日志负责最终卸载；完整重跑成功。旧日志保存在`.tmp/android-current-system-318/`，未覆盖。

拼音输入法曾将注入字符留在组合区，快速输入也发生字符重排。最终自动操作切换到已观察的英文子类型，逐字输入并核对实际文本，之后再点击确定。首次独立断言误将旧NULL字段当作false；已要求原始Edge案例精确保留NULL及其历史true/true签名语义，显式字段仍要求精确0/1，其他存储比较未放宽。

最终证据：`.tmp/android-current-system-final-318/{baseline,build-evidence,verification,system-acceptance,unknown-empty-proof,restored,ui-observations}.json`及原始响应、SQLite快照、截图。日志：`.artifacts/current-system-final-*.log`。可复用脚本：`scripts/interop-current-system-{318,ui-318,verify-318}.mjs`。

完整跨端对齐仍未完成：真实OneDrive账户、其他当前后端和F-Droid系统链路、KDBX分组及完整字段／生命周期矩阵继续跟踪。

## English

Current ordinary Android build05 passed actual API35 system selection and master-password authentication for three imported credentials. Original public keys verify all signatures and backup flags5/13/29. Legacy NULL fields retain their historical true/true behavior. Unknown allow-list requests yield zero Monica entries; dismissing the platform's alternative-device prompt returns user cancellation. Wrong passwords and both cancellation paths preserve all recorded identities, key references, counters and usage.

The intentional zero-counter policy is unchanged. The strict RP still rejects the positive-history43→0 case; full RP acceptance is explicitly false. No product changes, F-Droid system claims, live-site or real-account claims. The first live fixture timed out; a fresh standalone-seed run completed successfully. Test packages and provider/keyboard settings were restored, and the task-started API35 AVD was stopped.
