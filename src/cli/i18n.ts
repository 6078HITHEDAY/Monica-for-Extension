import { locale, tr as common } from '../i18n';

// Keep the optional CLI view's vocabulary local to its integration.
export const cliEnglish: Record<string, string> = {
  '辅助程序':'Helper', '协议':'Protocol',
  '移动条目':'Move entry', '删除条目':'Delete entry',
  '尚未注册 CLI 浏览器联动，请运行安装脚本。':'CLI browser integration is not registered. Run the installer.',
  '当前扩展 ID 未获准连接，请用此页面的扩展 ID 重新注册。':'This extension ID is not authorized. Register the ID shown on this page.',
  'CLI 辅助程序已退出，请运行安装诊断并核对保存结果。':'The CLI helper exited. Run installation diagnostics and check the save result.',
  'CLI 辅助程序版本或能力不兼容，请同时更新 CLI 和浏览器辅助程序。':'The helper version or capabilities are incompatible. Update both the CLI and browser helper.',
  '请先重新连接 CLI 并检查组件版本。':'Reconnect to the CLI and check its version.',
  '还有保存结果需要核对，请先检查下方回执。':'A save result needs verification. Check the receipts below first.',
  '密钥文件（可选，最多 32 KiB）':'Key file (optional, up to 32 KiB)',
  '需要密钥文件时，先选择文件再输入主密码。系统文件选择器会触发失焦锁定。':'Select the key file before entering your password. Opening the system file picker locks the CLI when focus leaves the page.',
  '已核对：保存成功。原操作未重发。':'Verified: saved successfully. The original operation was not resent.',
  '只读安装诊断':'Read-only installation diagnostics',
  '诊断区分注册、扩展 ID、宿主版本和 CLI 初始化状态，不读取保险库秘密。':'Diagnostics check registration, extension ID, host version and CLI setup without reading vault secrets.',
  '没有 AI 授权。':'No AI grants.',
  '生成 SSH 密钥':'Generate SSH key', '导入 SSH / GPG':'Import SSH / GPG',
  '创建 AI 授权':'Create AI grant', '续期 AI 授权':'Renew AI grant',
  '同步 CLI 数据库':'Sync CLI database', 'SSH / GPG 密钥':'SSH / GPG keys',
  '只显示密钥摘要和指纹。现有私钥、备注及密钥导出仍在 CLI 本人界面中管理。':'Only key summaries and fingerprints are shown. Manage existing private keys, notes and key exports in the CLI human interface.',
  '保存结果需要核对':'Save result needs verification',
  '连接中断后不会自动重发保存。重新解锁相应数据库后查询回执，结果未知时请先检查数据库内容。':'Saves are never resent automatically after a disconnect. Unlock the corresponding database to check receipts. Inspect its contents if the outcome remains unknown.',
  '核对保存结果':'Check save results',
  '操作已开始，但完成结果尚未确认。':'The operation started, but completion is unconfirmed.',
  '尚未找到回执；这不能证明写入没有发生。':'No receipt was found. This does not prove that no write occurred.',
  '等待重新解锁并核对。':'Waiting for unlock and verification.',
  '我已检查数据库内容':'I have checked the database contents',
  '密钥算法':'Key algorithm', '密钥格式':'Key format',
  '导入密钥内容（最多 32 KiB）':'Key text to import (up to 32 KiB)',
  '授权名称':'Grant name', '选择连接':'Select connection',
  '仓库范围（每行一个）':'Repository scope (one per line)',
  'Issue 操作需要精确仓库。通用 API 操作必须明确填写 *，代表整个服务。':'Issue operations require exact repository scopes. Generic API operations require an explicit *, covering the entire service.',
  '读取 Issue':'Read issues', '创建 Issue':'Create issues',
  '通用 API 读取':'Generic API read', '通用 API 写入':'Generic API write',
  '有效期（分钟）':'Validity (minutes)', '每分钟请求上限':'Requests per minute',
  '总调用次数（0 为不限次数，仍会到期）':'Total calls (0 removes the call cap; expiry still applies)',
  '人工批准':'Human approval', '写操作':'Write operations', '每次调用':'Every call', '不询问':'Do not ask',
  '续期保留原仓库、操作、期限、次数和人工批准设置，并立即使旧客户端凭据失效。需要重启 MCP 客户端。':'Renewal preserves the repository scopes, operations, duration, call cap and approval policy. It immediately invalidates the old client credential. Restart the MCP client.',
  '仅同步 CLI 已配置的 WebDAV，保留 ETag 与冲突检查。同步后锁定，超时后先核对回执。':'Sync only with the WebDAV already configured in the CLI, preserving ETag and conflict checks. The CLI locks afterward. Check the receipt after a timeout.',
  'WebDAV 密码（仅本次使用）':'WebDAV password (this operation only)',
  '此操作需要重新认证 CLI 数据库。主密码及密钥文件不会保存到浏览器。':'Authenticate the CLI database again for this operation. The password and key file are not persisted in the browser.',
  '重新输入 CLI 主密码':'Re-enter CLI master password',
  '使用本次解锁选择的密钥文件；更换文件请先锁定 CLI。':'Uses the key file selected for this session. Lock the CLI first to choose another file.',
  '同步已完成，请重新解锁并查看结果。':'Sync completed. Unlock again to inspect the result.'
};

export function tr(source: string): string {
  const translated=common(source);
  return translated===source && !locale.value.startsWith('zh') ? cliEnglish[source] ?? translated : translated;
}
