import { tr } from '../i18n';

export interface NearbyMessage { message: string; hint?: string }

const sameNetwork = () => tr('请确认两台设备连接同一个 Wi-Fi，关闭 VPN，并且路由器未开启访客网络或 AP 隔离。');
const phoneSyncNow = () => tr('在手机上打开 Monica 的附近设备同步并点按“立即同步”，然后在此重试。');

/** Explain a fixed nearby code. Unknown codes stay generic but keep the code for support. */
export function nearbyErrorMessage(code: string): NearbyMessage {
  switch (code) {
    case 'native-host-not-installed':
      return { message: tr('尚未安装 Monica 本机助手。'), hint: tr('Wi-Fi 同步需要本机助手建立局域网连接。请按 README 中的说明安装本机助手后重试。') };
    case 'native-host-forbidden':
      return { message: tr('本机助手未授权当前 Monica 扩展。'), hint: tr('请重新运行本机助手安装脚本，以登记当前扩展 ID。') };
    case 'native-host-disconnected': case 'closed':
      return { message: tr('与本机助手的连接已断开。'), hint: tr('请重试；如果持续出现，请重新安装或更新本机助手。') };
    case 'host-update-required': case 'native-host-incompatible':
      return { message: tr('本机助手版本过旧，不支持附近设备同步。'), hint: tr('请更新本机助手后重试。') };
    case 'vault-locked': case 'session-closed': case 'session-expired': case 'session-changed': case 'stale-session':
      return { message: tr('密码库已锁定或会话已变化。'), hint: tr('解锁密码库后重试。') };
    case 'busy':
      return { message: tr('另一个附近同步操作仍在进行。'), hint: tr('请等待当前操作完成，或取消后重试。') };
    case 'peer-not-found':
      return { message: tr('未在当前网络中找到已配对的手机。'), hint: `${phoneSyncNow()} ${sameNetwork()}` };
    case 'discovery-unavailable':
      return { message: tr('当前网络不支持设备发现。'), hint: `${phoneSyncNow()} ${sameNetwork()}` };
    case 'connection-failed': case 'connection-closed': case 'transfer-timeout': case 'transfer-failed':
      return { message: tr('无法与手机建立或保持连接。'), hint: `${sameNetwork()} ${tr('如果系统防火墙询问，请允许 Monica 本机助手访问专用网络。')}` };
    case 'listen-failed':
      return { message: tr('本机助手无法开始监听局域网连接。'), hint: tr('请允许 Monica 本机助手通过系统防火墙访问专用网络，然后重试。') };
    case 'no-local-network':
      return { message: tr('这台电脑没有可用的局域网连接。'), hint: tr('请连接 Wi-Fi 或有线局域网后重试。') };
    case 'local-network-only':
      return { message: tr('只能连接局域网内的私有地址。'), hint: sameNetwork() };
    case 'invalid-invitation': case 'invalid-peer': case 'invalid-endpoint':
      return { message: tr('配对链接无效。'), hint: tr('请在手机上重新生成配对链接，并完整复制以 monica-lan:2: 开头的内容。') };
    case 'unsupported-protocol':
      return { message: tr('手机上的 Monica 版本过旧。'), hint: tr('请将 Monica 安卓版更新到最新版本后重新配对。') };
    case 'pairing-expired':
      return { message: tr('配对码已过期。'), hint: tr('请重新生成配对码。') };
    case 'authentication-failed': case 'pairing-rejected': case 'invalid-pairing-key': case 'invalid-key': case 'peer-key-changed':
    case 'unexpected-peer': case 'different-device':
      return { message: tr('设备身份验证失败。'), hint: tr('如果手机曾重置或重新安装，请在两端移除此设备并重新配对。') };
    case 'peer-forgotten':
      return { message: tr('此设备已被移除。'), hint: tr('请重新配对后再同步。') };
    case 'peer-limit':
      return { message: tr('最多只能配对 8 台设备。'), hint: tr('请先移除不再使用的设备。') };
    case 'sync-direction-conflict': case 'sync-direction-unsupported':
      return { message: tr('两台设备的同步方向不兼容。'), hint: tr('例如两端都设为“仅发送”。请调整其中一台设备的同步方向。') };
    case 'source-changed':
      return { message: tr('同步期间密码库内容发生了变化。'), hint: tr('请重试，新的修改会包含在下一次同步中。') };
    case 'review-stale': case 'not-ready':
      return { message: tr('同步准备已过期。'), hint: tr('请重新开始同步。') };
    case 'local-provider-required':
      return { message: tr('附近设备同步需要启用 Monica 本地库。') };
    case 'unsupported-vault-content': case 'different-vault': case 'different-content-type':
      return { message: tr('对方发送的内容与此密码库不兼容。'), hint: tr('请将两端的 Monica 更新到最新版本。') };
    default:
      return { message: tr('附近设备同步未完成（{0}）。', { 0: code }), hint: tr('请重试；如果持续出现，请导出脱敏诊断并反馈。') };
  }
}

/** Why the background ended this page's lease. `cancelled` is user initiated and reconnects silently. */
export function nearbyClosedMessage(reason: string): NearbyMessage | undefined {
  switch (reason) {
    case 'cancelled': case 'manager-closed': return undefined;
    case 'manager-busy': return { message: tr('附近设备同步已在另一个 Monica 标签页中打开。'), hint: tr('请关闭其他标签页中的附近设备同步页面后重试。') };
    case 'vault-locked': case 'session-expired': case 'session-changed': return nearbyErrorMessage('vault-locked');
    case 'background-suspended': return { message: tr('浏览器暂停了扩展后台。'), hint: tr('请重新连接。') };
    default: return { message: tr('附近设备同步连接已关闭。'), hint: tr('请重新连接。') };
  }
}

const stages: Record<string, () => string> = {
  waiting: () => tr('等待手机就绪'),
  connecting: () => tr('正在连接手机'),
  authenticating: () => tr('正在验证加密连接'),
  checking: () => tr('正在核对同步内容'),
  transferring: () => tr('正在传输加密内容'),
  received: () => tr('正在保存收到的内容'),
  confirming: () => tr('等待手机确认'),
  completed: () => tr('同步完成')
};
export function nearbyStageLabel(stage: string | undefined): string {
  return (stage && stages[stage]?.()) || tr('正在同步');
}
