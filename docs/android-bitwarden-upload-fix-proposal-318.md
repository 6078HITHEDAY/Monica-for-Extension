# Android Bitwarden 单项 Passkey 上传覆盖：修复提案

2026-10-10，待确认扩大 Android 修改范围。当前未改 Android 产品代码。

## 已复现问题

当前普通版 `d7702ca` / APK `b6a3ab4d…` 的真实 `CipherUploadProcessor.updatePasskey` 用单个 Passkey 生成新建请求，再直接转换为整个 Cipher 的更新请求。请求没有合并该 Cipher 的其他 FIDO2 条目、密码、用户名、项目字段、URI 等原有内容。

在合成数据中：一个密码项目成员包含两把不同 Passkey，取消移除后另有一份独立保留副本。Android 正确导入了三条记录（两把不同密钥），编辑备注并上传全部三条记录时，向同一个原 Cipher 连续发出两次单凭据 PUT。最后重新导入空库只剩两条记录，而且属于同一把密钥：**不同密钥从 2 把变为 1 把**。原 Cipher 的密码、用户名、项目分组、自定义字段和 URI 也发生变化。服务器是测试中的 MockWebServer，执行正常的完整 Cipher 替换；不是生产云服务，也没有使用用户数据。

源码位置：普通版及 F-Droid 的 `app/src/main/java/takagi/ru/monica/bitwarden/service/CipherUploadProcessor.kt:541`，特别是 560 行单项 `mapper.toCreateRequest` 与 568 行 `encryptedCreate.toUpdateRequest`。F-Droid 当前 `2a4d8297…` 包含相同路径；本次未运行 F-Droid APK。

独立凭据的 ID、密钥和备注往返可用：当前 Android 正确处理真实 Edge 注册的 16 字节 UUID 表示，以及扩展核心生成的旧式 32 字节 `b64.` 表示。Android 回传后，真实 Edge 的两把凭据均能登录，重启后再次登录。这个通过结果不能覆盖上述共用 Cipher 的覆盖缺陷。

## 拟实施范围

1. 只修普通版及 F-Droid 的已有 Passkey 更新路径；新建、零签名计数、凭据 ID、原私钥与发布版本不变。
2. 更新前获取并核实当前 Cipher 原始内容，使用其实际账户/组织/Cipher 密钥上下文。按归一化凭据字节精确定位唯一目标；缺失、重名、已删除、不可解密或远端身份变化时保留待同步内容并报错，不能创建替代凭据。
3. 在原 Cipher 上合并目标 FIDO2 条目，保留其他 FIDO2 条目、密码、用户名、OTP、URI 与匹配规则、项目/未知字段、附件、目录/集合和其他原生属性。备注仅依照明确的现有编辑语义更新，不把单项新建模板当作整个登录项。
4. 每次更新使用最新回读与服务器已有版本约束；同一 Cipher 的多个条目更新串行合并，响应丢失后先核对。不能通过重建 ID、删掉其他凭据、清空原字段或降低安全检查解决。
5. 补 Android 单元/仪器回归；重复当前真实应用导入→编辑→上传→空库重建→独立验签及 Edge 返回。加入同一 Cipher 的两个 Passkey、带密码/OTP/项目字段、并发远端变更、失联与失败保留测试。发布说明只写各自未发布记录，不改 F-Droid 已发布 `1.0.318` 内容。

## 可审阅证据

- [当前运行验收](android-bitwarden-current-runtime-318.md)。
- 输入：`.tmp/android-bitwarden-copies-runtime-318/{direct,copies-complete,copies-cancel}-input.json`，仅合成密钥。
- Android 输出：同目录 `android-bitwarden-copies.json`；真实应用导入/上传的逐项结果和请求类型。
- 独立核对：同目录 `independent-*.json`，记录缺失凭据、不同密钥数量及变化字段名，不用日志输出明文密码或私钥。
- 回归：`tests/interop/android318-bitwarden-copies.interop.ts` 保留三项失败；仪器测试位于扩展自有 `tests/interop/android-app/src/takagi/ru/monica/credentialexchange/ExtensionBitwardenCopyInteropTest.kt`。

## 为何需要范围确认

现有 [SPEC.md](../.codex-tasks/android-interop-315/SPEC.md) 将 Android 产品修改限于此前批准的 Passkey ID、允许列表、取消、备注显示和备份元数据修复，并明确写着 **“Other Android changes remain outside this authorization.”** 本提案涉及整个 Bitwarden Cipher 的上传合并与并发控制，超出那次限定范围，因此请求一次明确授权。待确认的 Android KDBX 分组问题仍是另一项，不以本次授权替代。
