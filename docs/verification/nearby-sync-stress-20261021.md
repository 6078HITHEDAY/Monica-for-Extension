# Android 与 Edge 附近同步压力验证

2026-10-21；扩展 0.1.48，未提交或推送。使用已安装 Edge 155.0.4283.62、公共 AVD `Monica_Issue136_API_32`（Android 32 / x86_64）以及普通版 `1.0.321-26102112-25`。全部业务数据为合成数据，Android 使用独立内存 Room/Steam 库，扩展使用隔离浏览器配置与原生助手目录。

## Android 实际互通

基础互通通过；压力用例完成 **19 轮内容交换**，另有配对与一次采纳前取消。不是只检查传输成功：每个场景分别读取 Android 数据库和浏览器密码库核对内容。

| 场景 | 实际结果 |
| --- | --- |
| 双端批量新增 | Android 220 条、浏览器 230 条密码双向交换；逐条核对密码、用户名、备注 |
| 特殊内容 | 中文、emoji、换行、引号、反斜杠、首尾空白均保留；同名不同账号分别存在 |
| 重复同步 | 连续三轮无操作同步后，两端记录 ID 与数量不变 |
| 取消与重试 | 连接后、应用采纳前取消；Android 无部分采纳；重建 provider、重载管理页后重试成功 |
| 双端离线冲突 | 密码与备注来自同一个完整候选，两轮后双端收敛 |
| 仅接收 | 手机改动传入；浏览器本地改动未传出；恢复双向后再发送保留改动 |
| 仅发送 | 浏览器改动传出；手机改动暂未采纳；恢复双向后再接收 |
| 错误 TOTP 删除事故模型 | 先同步正确密钥；只改坏插件密钥并清空插件回收站；手机正确密钥仍存在且未删除 |
| 历史删除确认 | 未选择不能启动；取消不影响手机；跳过保留手机项目；明确包含后删除生效，设置开关仍开启 |
| 手机删除再恢复 | 插件采纳手机回收站状态；恢复后使用原插件记录 ID |
| Passkey | 每次 Android 采纳后用原始私钥签名验签；计数保持零；最终插件私钥字节与原值一致 |
| Android 321 字段 | 网址规则、凭据组独立备注、三种卡包模板往返；未知 JSON 整数 `9007199254740993`、前导零、时区字符串保留；明确移除的卡包字段未复活 |

基础命令：

```powershell
$env:MONICA_ANDROID_INTEROP='1'
npx playwright test tests/e2e/nearby-android321.spec.ts
```

压力命令另设 `$env:MONICA_SYNC_STRESS='1'`。最终压力运行约 3 分钟；Android instrumentation 报告 `OK (1 test)`，证据记录 `stressCompletedRounds: 19`。Android 控制 socket 只监听模拟器回环地址，通过临时 adb 转发连接；实际内容仍走生产 provider、JNI、Noise 和浏览器生产协调器。

## 测试发现并修复的扩展缺陷

真实 Edge → MDBX 测试复现：MDBX 项目删除、明确同步删除后，在另一端恢复项目并再次同步，双方显示完成，但 MDBX 对象仍在回收站。

原因是采纳前的原生重扫套用了发送删除保护。重扫从副本取到刚合并、尚未写入数据库的恢复记录，将它当作本地影子记录扫描，提前清除了待采纳状态。传输成功因而掩盖了数据库未恢复。

修复只在扩展协调器：已有待采纳记录时不先进行这种重扫；接收批次从完整且版本已校验的原生清单更新写入 guard，不将入站副本重新扫描成已采纳内容。实际数据库写入完成后才应用回执。共享 Rust 引擎与 Android 生产源码未修改。

修复前真实用例失败；修复后同一用例通过，核对原 MDBX 对象 ID、恢复后的密码及 **600,000 字节附件 SHA256**。随后扩展运行分页、文件夹层级、重启与恢复回归。

## 验证记录

| 检查 | 结果 |
| --- | --- |
| 修改前全量 `vitest run --maxWorkers=4 --testTimeout=30000` | 325 文件、4192 测试通过 |
| `cargo test --locked --manifest-path native/mdbx2-host/Cargo.toml` | 113 测试通过；本轮未修改 Rust |
| 修复后的附近同步及安全定向测试 | 19 文件、364 测试通过 |
| E2E 与层级夹具 TypeScript 检查 | 0 diagnostics |
| `npm run build` | 通过，更新 dist，包含页面资源、MDBX 库存和助手校验 |
| 最终 Edge 扩展矩阵 | 10 个套件、18 个用例全部通过，包含 300 项分页中断恢复、原对象与 600KB 附件恢复、260 项及三层文件夹删除/重启恢复/移动、原生配置转发 |

首轮 Edge 12/14 通过，失败涉及过时的弹窗拒绝响应断言和默认删除传播假设。测试现检查明确的 `closed/manager-context-invalid` 拒绝、按设备 ID 选监听方，并区分默认删除保护与明确包含历史删除。MDBX 恢复失败另行复现并修复，未作为夹具错误略过。

最终矩阵的十个文件为 `nearby-coordinator`、`nearby-native-coordinator`、`nearby-native-transport`、`nearby-native-adoption`、`nearby-manager-owner`、`nearby-manager-ui`、`nearby-native-hierarchy`、`nearby-native-metadata-assets`、`nearby-native-profiles`、`nearby-profile-sync`（均为 `tests/e2e/*.spec.ts`）。层级用例明确关闭增量发送以测试完整删除传播，按真实 ID 选择监听方；260 项重启恢复链路耗时约 4.2 分钟。默认增量保护由独立真实传输用例验证。十次临时原生注册的恢复证据均为 `restored: true`。

Android 扩展夹具两处补齐正式协调器语义：取消后等待原生任务终态再 release；根据 `receive_content` 决定是否采纳入站文件。原生 cancel 是异步操作；仅接收对端不会发送文件。明确 purge 在 Android 上移除数据库行，区别于保留 deleted 行的 trash；断言核对没有对应活动记录。原始失败日志均保留。

## 环境与证据

原始日志、Playwright trace、各轮 evidence.json、构建记录及任务追踪放在 `%TEMP%/monica-sync-stress-20261021/`。关键子目录：`android-baseline`、`android-stress`、`android-stress-retry`、`android-stress-direction`、`android-stress-final`、`edge-baseline`、`edge-recheck`、`edge-native-final`、`edge-native-restore-fix`、`edge-final-matrix`。

本会话仅替换测试 APK，已恢复测试前备份并拉取校验 SHA256 为 `ab9579bab76c1c1aca4da0c6c05bf060192e9e2fc4f3349392ed82b9bb52e12e`。未清空应用数据、重装普通版或访问用户业务库。测试于 15:05:13 写入通过证据，记录应用版本 `…-25`；Android 主会话随后于 15:05:46 安装 `…-26`，本会话保留其新版，没有回退应用。测试启动前公共 AVD 已在运行，本会话不停止它。临时 adb 转发已移除；Edge 测试临时原生注册由夹具核对并恢复。

## 尚未覆盖

本报告不代表实体手机、F-Droid、真实 Wi-Fi 断网或多播发现、长期自动调度、真实账户数据、用户手机回收站恢复以及 Android 文件夹/根目录附件的完整验收。Android 使用 provider 重建和管理页重载模拟恢复，没有强杀整个 Android 进程；浏览器完整退出重启由单独 Edge 用例覆盖。附件哈希与复杂原生层级在 Edge/MDBX 链路验证，不冒充 Android 附件验收。原事故的具体历史时间线仍无法唯一确定。
