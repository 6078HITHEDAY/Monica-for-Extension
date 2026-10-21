# Monica CLI 联动

CLI 联动目前不完善，默认关闭。先在「设置与备份 → 通用」开启「CLI 联动」，再从侧栏进入「CLI 内容管理（不完善）」。开关仅保存在本机，关闭后隐藏入口并退出已打开的 CLI 管理页。

使用同版本 CLI 附带的 `monica-browser-host.exe` 和 `scripts/install-browser.ps1`；展开页面的「安装浏览器联动」可查看本扩展 ID 和安装命令。扩展已经具有 Native Messaging 权限，不增加网页主机权限。

支持浏览和切换 CLI 已保存的数据库、目录管理、密码新增和指定字段替换、GitHub/GitLab 连接新增/重命名/Token 替换，以及查看和撤销 AI 授权。所有实际存储和权限判断均在 CLI 内完成，不使用扩展的 MDBX 引擎直接操作 CLI 文件，也不复制到扩展密码库。

已有秘密字段不传入浏览器。密码编辑仅保存明确勾选的替换字段，未勾选内容保留。未来/未知类型保持只读，密码编辑核对原生版本，保护并发修改。删除需要确认，会在后续 CLI 同步中传播。Token 替换或删除关联连接会撤销旧授权。

主密码不持久化到浏览器，离开页面/切换标签/窗口失焦时关闭本地通道；CLI 辅助程序另设 5 分钟无请求、15 分钟最长会话限制。支持解锁前选择密钥文件（最多 32 KiB）：先选文件再输入密码，系统文件选择器会触发失焦锁定。锁定时清除会话内文件引用。

新增 SSH 生成、SSH/OpenPGP 粘贴导入、AI 授权创建/续期，以及同步 CLI 已配置的 WebDAV。这些操作均再次输入主密码，并重新提交本会话选择的密钥文件。默认授权仅含 Issue 读取；仓库、操作、有效期、次数及人工批准需本人明确设置。续期保留原权限并立即使旧客户端凭据失效。密钥摘要仅含标题、类型、算法与指纹，不返回已有秘密、备注、公钥或用户 ID。浏览器同步不会配置新远程地址或读取本机任意路径。

保存前持久化公开操作 ID，CLI 在执行前持久化 intent，执行后记录成功回执。断开/超时后不会重发请求；重新解锁对应库时自动查询回执并刷新内容。成功回执清除提示，未知或无回执则暂停该库新写入，需本人核对并点击「我已检查数据库内容」。浏览器存储仅含 ID、库身份/路径、操作类型和时间，没有原请求、标题、密码、Token 或密钥。CLI 最多保留 4096 个 ID 且不淘汰，浏览器最多保留 64 项未确认记录。

协议 2 要求 CLI ≥ 1.0.101、integration revision ≥ 2，先协商版本与能力再解锁，不兼容时拒绝继续。安装命令附加 `-Diagnose` 可检查宿主、注册、扩展 ID 和初始化状态。Edge/Chrome/Firefox manifest 独立保存。

当前安装脚本支持 Windows Edge/Chrome/Firefox。Firefox 需要包含固定附加组件 ID 启动支持的新版辅助程序，使用 `-FirefoxExtensionId 'monica@monica-pass.github.io'`；详见 [Firefox 说明](FIREFOX.md)。自定义 CLI `-C` 路径不由扩展任意选择；默认共享辅助程序所在便携安装的 `data/gateway.json`，或 CLI 系统默认配置。

新增 CLI 页面提供完整中文与英文。其他离线语言已翻译主要操作；新增的较长说明暂使用英文回退，不影响其余界面的既有翻译。

## English

CLI integration is incomplete and off by default. Enable **CLI integration** under **Settings and backup → General**, then open **Sidebar → CLI content management · Incomplete**. The preference is device-local; disabling it hides the entry and closes any open CLI management view.

Register the matching CLI helper using the extension ID and command shown under **Install browser integration**. The CLI owns all storage, unlock and authorization decisions.

Manage saved databases, folders, selective password replacement, connections, AI grants, SSH generation/import, OpenPGP import and configured WebDAV sync. Key/grant/sync changes require fresh authentication. Key files and imported text are bounded to 32 KiB. Existing secrets are not returned. Leaving the page, switching tabs or losing window focus disconnects the session.

Protocol 2 negotiates version and capabilities before unlock. Unknown write outcomes survive page closure as public operation identities; reconnect queries native receipts without replay. Unknown or missing receipts require manual inspection before new writes. The installer supports Windows Edge/Chrome/Firefox and read-only `-Diagnose`; independent browser manifests preserve each exact origin or Firefox add-on ID. Firefox requires the updated native helper and the fixed ID `monica@monica-pass.github.io`.
