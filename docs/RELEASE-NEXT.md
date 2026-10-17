# Monica for Extension — 下一版 / Next release

> 0.1.39 阶段改动已归档至[发行说明](releases/Monica-Extension-0.1.39.md)及[验证记录](verification/release-0.1.39.md)。0.1.38 历史记录保持原样。 / The 0.1.39 stage is archived; 0.1.38 historical records are unchanged.

## 中文

- 新增“设置与备份 → 附近设备同步”页面：二维码／配对链接配对、设备列表、立即同步、移除、同步方向与频率、Passkey 限制确认、进度与取消，以及针对本机助手、网络和防火墙问题的具体提示。
- 修复大型密码库的界面卡顿：打开动态验证码页的最长主线程阻塞从约 3.1 秒降至约 0.37 秒，列表、搜索与详情也更流畅。详见 [PERFORMANCE.md](PERFORMANCE.md)。
- 修复与 Android 的 Wi-Fi 同步：遵循 Android 的设备 ID 角色规则，在对方监听时由浏览器发现并主动连接，避免双方同时等待；记住对方地址用于单播探测；保留真实错误代码；本机助手按 Android 格式广播同步请求与设置版本。详见 [nearby-wifi-sync-321.md](nearby-wifi-sync-321.md)。

完整 Android 对齐仍在开发：浏览器端 mDNS 在线广播（Android 自动同步发现）、完整 MDBX 接收及文件夹／根元数据落库、来源归档、跨后端冲突与恢复，以及当前 Android/F-Droid、真实 OneDrive 和跨后端矩阵验收。

## English

- New Settings → Nearby sync page: QR/link pairing, paired devices, Sync now, remove, direction and frequency, restricted-Passkey review, progress and cancel, with actionable guidance for helper, network and firewall problems.
- Fixed UI freezes with large vaults: the longest main-thread block when opening the OTP page dropped from about 3.1 s to about 0.37 s; lists, search and details are smoother too. See [PERFORMANCE.md](PERFORMANCE.md).
- Fixed Wi-Fi sync with Android: follow Android's device-ID role rule so the browser discovers and dials a listening phone instead of both sides waiting; remember the peer address for unicast probes; keep real error codes; the Host advertises sync requests and settings versions in Android's format. See [nearby-wifi-sync-321.md](nearby-wifi-sync-321.md).

Full Android parity remains in development: browser mDNS presence for Android automatic discovery; complete MDBX adoption and native folder/root metadata; archived origins; cross-backend conflict/recovery; and current Android/F-Droid, real OneDrive and cross-backend acceptance.
