<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import QRCode from 'qrcode';
import { tr } from '../i18n';
import { materialOptionTag, materialSelectTag } from '../lib/material-controls';
import { NearbyManagerClient, NearbyManagerClientError, type NearbyManagerCommand } from '../nearby/manager-client';
import type { NearbyCoordinatorView, NearbyDiscoveryView, NearbyDiscoveredPeer, NearbyEndpoint } from '../nearby/local-coordinator';
import type { NearbyPreferencesView, NearbySyncMode } from '../nearby/preferences';
import type { NearbyManagerChange } from '../nearby/manager-contract';

const preferences = ref<NearbyPreferencesView>(), view = ref<NearbyCoordinatorView>({ phase: 'idle' });
const busy = ref(false), connected = ref(false), searching = ref(false), discovered = ref<NearbyDiscoveredPeer[]>([]);
const sources = ref<{id:string;name:string;kind:string}[]>([]), qr = ref('');
const error = ref(''), invitation = ref(''), target = ref(''), name = ref(''), copied = ref(false), forgetId = ref('');
let client: NearbyManagerClient | undefined, disposed = false, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
let nextAutomatic = 0, automaticCursor = 0, searchStarted = 0, waitingStarted = 0, pendingEndpoint: NearbyEndpoint | undefined;
const active = computed(() => ['pairing', 'preparing', 'review', 'ready', 'transferring', 'saving'].includes(view.value.phase));
const editable = computed(() => connected.value && !busy.value && !active.value && !searching.value);
const phaseText = computed(() => tr(({ idle: '准备同步', pairing: '等待配对设备', preparing: '正在准备同步', review: '请检查 Passkey 兼容性', ready: '准备完成', transferring: '正在连接或传输', saving: '正在安全保存', completed: '同步完成', failed: '同步未完成', cancelled: '同步已取消' })[view.value.phase]));
function errorText(code: string): string {
  const messages: Record<string, string> = {
    'host-update-required': '请更新 Monica 本机通信组件后重试。',
    'native-host-not-installed': 'Wi-Fi 同步需要 Monica 本机通信组件。MDBX 数据库本身已内置于插件。',
    'native-host-forbidden': '浏览器阻止了 Monica 本机通信组件，请检查安装配置。',
    'source-paired': '切换同步密码库前，请先移除现有配对设备。', 'recovery-required': '请先恢复当前数据库未完成的接收，再切换密码库。',
    'source-changed': '同步期间密码库发生了修改，请重新同步。', 'native-source-changed': '同步期间密码库发生了修改，请重新同步。',
    'stale-session': '设置已更新，请重新连接同步页面。', 'manager-busy': '另一窗口正在使用 Wi-Fi 同步，请先关闭该窗口的同步页面。',
    'vault-locked': '密码库已锁定，请解锁后重新进入同步页面。', 'session-expired': '密码库已锁定，请解锁后重新进入同步页面。',
    'session-changed': '密码库已锁定，请解锁后重新进入同步页面。', 'session-closed': '同步会话已结束，请重新连接。',
    'invalid-invitation': '配对邀请无效，请粘贴另一端显示的完整邀请。', 'local-network-only': '请输入局域网 IPv4 地址。',
    'invalid-endpoint': '请输入局域网 IPv4 地址。', 'peer-limit': '最多保存 8 台设备，请先移除不再使用的设备。',
    'transfer-failed': '连接未完成，请确认两端在同一网络并同时打开同步页面。',
    'native-projection-incomplete': '此数据库包含暂时无法完整同步的内容，已停止发送以保护原始数据。',
    'operation-failed': '同步未完成，请检查本机通信组件和另一端状态后重试。',
    'cancelled': '同步已取消。', 'connection-closed': '同步连接已关闭，请重新连接。',
    'operation-timeout': '同步等待超时，请重新连接。', 'connection-timeout': '同步连接超时，请重新连接。'
  };
  return tr(messages[code] ?? '同步未完成，请检查本机通信组件和另一端状态后重试。');
}
function report(e: unknown) { if (!disposed) { error.value = errorText(e instanceof NearbyManagerClientError ? e.code : 'operation-failed'); view.value = {phase:'failed'}; searching.value=false; } }
async function request<T>(command: NearbyManagerCommand): Promise<T> {
  if (!client) throw new NearbyManagerClientError('connection-closed');
  const current = client, result = await current.request<T>(command);
  if (disposed || current !== client) throw new NearbyManagerClientError('session-closed');
  return result;
}
async function run(work: () => Promise<void>) {
  if (busy.value || disposed) return;
  const operationGeneration = generation;
  busy.value = true; error.value = ''; copied.value = false;
  try { await work(); } catch (e) { if (!disposed && operationGeneration === generation) report(e); }
  finally { if (operationGeneration === generation) busy.value = false; }
}
function deferAutomatic() { nextAutomatic = Date.now() + Math.max(60, preferences.value?.intervalSeconds || 300) * 1000; }
async function loadPreferences() {
  preferences.value = await request<NearbyPreferencesView>({ type: 'preferences' }); name.value = preferences.value.name;
}
async function connect() {
  if (busy.value || disposed) return;
  generation++;
  await run(async () => {
    client?.close();
    const current = new NearbyManagerClient(reason => { queueMicrotask(() => {
      if (disposed || client !== current) return;
      connected.value = false; searching.value = false; invitation.value = ''; copied.value = false;
      view.value = { phase: 'cancelled' }; if (reason !== 'cancelled') error.value = errorText(reason);
    }); });
    client = current; await current.ready;
    if (disposed || client !== current) { current.close(); return; }
    connected.value = true; await loadPreferences(); sources.value = await request({type:'sources'}); view.value = { phase: 'idle' }; deferAutomatic();
  });
}
async function change(change: NearbyManagerChange) {
  if (!preferences.value || !editable.value) return;
  await run(async () => {
    preferences.value = await request<NearbyPreferencesView>({ type: 'update', epoch: preferences.value!.epoch, change });
    name.value = preferences.value.name; view.value = { phase: 'idle' }; discovered.value = []; forgetId.value = ''; deferAutomatic();
  });
}
function value(event: Event) { return (event.target as HTMLInputElement).value; }
async function pair(join: boolean) {
  if (!editable.value) return;
  await run(async () => { view.value = await request({ type: 'pair', ...(join ? { invitation: invitation.value.trim() } : {}) }); invitation.value = ''; waitingStarted = Date.now(); });
}
async function discover() {
  if (!editable.value) return;
  await run(async () => { const result = await request<NearbyDiscoveryView>({ type: 'discover', ...(target.value.trim() ? { target: target.value.trim() } : {}) }); searching.value = result.searching; discovered.value = []; searchStarted = Date.now(); });
}
async function startPrepared() {
  view.value = await request({ type: 'start', ...(pendingEndpoint ? { endpoint: pendingEndpoint } : {}) }); waitingStarted = Date.now();
}
async function synchronize(peerId: string, address?: NearbyEndpoint) {
  pendingEndpoint = address;
  view.value = await request({ type: 'prepare', peerId });
  if (view.value.phase === 'ready') await startPrepared();
}
async function sync(peerId: string) {
  if (!editable.value) return;
  await run(() => synchronize(peerId, discovered.value.find(row => row.deviceId === peerId)?.endpoint)); deferAutomatic();
}
async function confirm() {
  const review = view.value.review; if (!review) return;
  await run(async () => { view.value = await request({ type: 'confirm', reviewId: review.id }); await startPrepared(); });
}
function cancel() {
  generation++;
  client?.close(); client = undefined; connected.value = false; searching.value = false; busy.value = false;
  view.value = { phase: 'cancelled' }; discovered.value = []; invitation.value = ''; pendingEndpoint = undefined; error.value = ''; deferAutomatic();
}
async function copyInvitation() {
  const text = view.value.pairing?.invitations[0]; if (!text) return;
  try { await navigator.clipboard.writeText(text); copied.value = true; } catch { error.value = tr('复制失败，请选择邀请文本手动复制。'); }
}
async function tick() {
  if (disposed) return;
  try {
    if (connected.value && !busy.value) {
      if (searching.value) await run(async () => {
        if (Date.now() - searchStarted > 15_000) { cancel(); error.value = tr('查找设备超时，请重新连接。'); return; }
        const result = await request<NearbyDiscoveryView>({ type: 'discovery-progress' }); searching.value = result.searching; discovered.value = result.devices;
      });
      else if (['pairing', 'transferring', 'saving'].includes(view.value.phase)) await run(async () => {
        const state = await request<NearbyCoordinatorView>({ type: 'progress' }); view.value = state; if (state.error) error.value = errorText(state.error);
        if (state.phase === 'completed') { await loadPreferences(); deferAutomatic(); }
        else if (Date.now() - waitingStarted > 180_000) { cancel(); error.value = tr('同步等待超时，请重新连接。'); }
      });
      else if (!active.value && preferences.value?.enabled && preferences.value.intervalSeconds > 0 && preferences.value.peers.length && Date.now() >= nextAutomatic) {
        deferAutomatic();
        // No automatic consent: a Passkey review remains visible until approved.
        const peers = preferences.value.peers, peer = peers[automaticCursor++ % peers.length];
        await run(() => synchronize(peer.deviceId, discovered.value.find(row => row.deviceId === peer.deviceId)?.endpoint));
      }
    }
  } finally { if (!disposed) timer = setTimeout(tick, 800); }
}
watch(() => view.value.pairing?.invitations[0], async text => { qr.value=''; if (!text) return; const result=await QRCode.toDataURL(text,{width:240,margin:2,errorCorrectionLevel:'M'}); if (!disposed && view.value.pairing?.invitations[0]===text) qr.value=result; });
onMounted(() => { void connect(); timer = setTimeout(tick, 800); });
onUnmounted(() => { disposed = true; clearTimeout(timer); client?.close(); client = undefined; invitation.value = ''; view.value = { phase: 'idle' }; });
</script>

<template>
  <section class="nearby-settings" aria-label="Wi-Fi 同步" data-nearby-settings>
    <p class="supporting">{{ tr('通过同一 Wi-Fi 或局域网加密同步选定密码库。云端密码源仍使用各自的同步设置。') }}</p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <m3e-button v-if="!connected" variant="filled" :disabled="busy" @click="connect">{{ tr('重新连接') }}</m3e-button>
    <template v-if="preferences">
      <div class="nearby-rows">
        <m3e-form-field v-field-label variant="filled" hide-subscript="always" class="nearby-row"><label slot="label">{{ tr('同步密码库') }}</label><component :is="materialSelectTag" :disabled="!editable || preferences.peers.length>0" :aria-label="tr('同步密码库')" @change="change({kind:'source',providerId:value($event)})"><component v-for="source in sources" :key="source.id" :is="materialOptionTag" :value="source.id" :selected.prop="preferences.localProviderId===source.id">{{ source.name }} · {{ source.kind==='mdbx2' ? 'MDBX' : tr('本机') }}</component></component></m3e-form-field>
        <p v-if="preferences.peers.length" class="nearby-row supporting">{{ tr('切换同步密码库前，请先移除现有配对设备。') }}</p>
        <label class="nearby-row name-row"><span>{{ tr('设备名称') }}</span><input v-model="name" maxlength="64" autocomplete="off" :disabled="!editable" :aria-label="tr('设备名称')" /><m3e-button :disabled="!editable || name === preferences.name || !name.trim()" @click="change({kind:'preferences',name:name.trim()})">{{ tr('保存') }}</m3e-button></label>
        <m3e-form-field v-field-label variant="filled" hide-subscript="always" class="nearby-row">
          <label slot="label">{{ tr('同步方向') }}</label><component :is="materialSelectTag" :disabled="!editable" :aria-label="tr('同步方向')" @change="change({kind:'preferences',mode:value($event) as NearbySyncMode})">
            <component v-for="mode in ([['bidirectional','双向同步'],['send_only','仅发送'],['receive_only','仅接收']] as const)" :key="mode[0]" :is="materialOptionTag" :value="mode[0]" :selected.prop="preferences.mode === mode[0]">{{ tr(mode[1]) }}</component>
          </component>
        </m3e-form-field>
        <div class="nearby-row toggle-row"><div><strong id="nearby-auto-label">{{ tr('页面打开时自动同步') }}</strong><small>{{ tr('锁定密码库或离开此页面后停止。') }}</small></div><m3e-switch :checked.prop="preferences.enabled" :disabled="!editable" aria-labelledby="nearby-auto-label" @beforeinput.prevent="change({kind:'preferences',enabled:!preferences.enabled,intervalSeconds:preferences.intervalSeconds || 300})" /></div>
        <m3e-form-field v-if="preferences.enabled" v-field-label variant="filled" hide-subscript="always" class="nearby-row"><label slot="label">{{ tr('同步间隔') }}</label><component :is="materialSelectTag" :disabled="!editable" :aria-label="tr('同步间隔')" @change="change({kind:'preferences',intervalSeconds:Number(value($event))})"><component v-for="seconds in [0,60,300,900,3600]" :key="seconds" :is="materialOptionTag" :value="String(seconds)" :selected.prop="preferences.intervalSeconds === seconds">{{ seconds ? tr('{0} 分钟',{0:seconds/60}) : tr('手动') }}</component><component v-if="![0,60,300,900,3600].includes(preferences.intervalSeconds)" :is="materialOptionTag" :value="String(preferences.intervalSeconds)" :selected.prop="true">{{ tr('{0} 秒',{0:preferences.intervalSeconds}) }}</component></component></m3e-form-field>
      </div>
      <section class="nearby-section" aria-labelledby="nearby-peers"><h2 id="nearby-peers">{{ tr('已配对设备') }}</h2>
        <p v-if="!preferences.peers.length" class="supporting">{{ tr('先在两端完成一次配对，再同步密码库。') }}</p>
        <div class="nearby-rows"><div v-for="peer in preferences.peers" :key="peer.deviceId" class="nearby-row peer-row"><m3e-icon name="devices" /><div><strong>{{ peer.name || tr('Monica 设备') }}</strong><small>{{ discovered.some(row=>row.deviceId===peer.deviceId) ? tr('附近可连接') : tr('等待另一端开启同步') }} · {{ peer.lastSyncedAt ? new Date(peer.lastSyncedAt).toLocaleString() : tr('尚未同步') }}</small></div><m3e-button variant="tonal" :disabled="!editable" :data-nearby-sync="peer.deviceId" @click="sync(peer.deviceId)">{{ tr('同步') }}</m3e-button><m3e-icon-button :disabled="!editable" :aria-label="tr('移除设备 {0}',{0:peer.name})" @click="forgetId = peer.deviceId"><m3e-icon name="link_off" /></m3e-icon-button><div v-if="forgetId===peer.deviceId" class="forget"><span>{{ tr('移除后需要重新配对，密码库内容保持原样。') }}</span><m3e-button :disabled="!editable" @click="change({kind:'forget',deviceId:peer.deviceId})">{{ tr('确认移除') }}</m3e-button><m3e-button @click="forgetId=''">{{ tr('取消') }}</m3e-button></div></div></div>
        <div class="nearby-actions"><m3e-button variant="tonal" :disabled="!editable || !preferences.peers.length" @click="discover">{{ searching ? tr('正在查找…') : tr('查找附近设备') }}</m3e-button><small v-if="discovered.length">{{ tr('找到 {0} 台已配对设备',{0:discovered.length}) }}</small></div>
        <details><summary>{{ tr('通过局域网地址查找') }}</summary><label>{{ tr('另一端 IPv4 地址') }}<input v-model="target" inputmode="decimal" autocomplete="off" :disabled="!editable" placeholder="192.168.1.10" /></label><p class="supporting">{{ tr('组播发现受路由器限制时，可填写另一端同步页面显示的地址后再次查找。') }}</p></details>
      </section>
      <section class="nearby-section" aria-labelledby="nearby-pair"><h2 id="nearby-pair">{{ tr('配对新设备') }}</h2><p class="supporting">{{ tr('在 Android 的附近设备同步页面显示配对邀请，复制完整邀请到此处；也可让 Android 扫描本机邀请。配对过程仅建立信任，随后点击同步才传输内容。') }}</p><label>{{ tr('配对邀请') }}<textarea v-model="invitation" :disabled="!editable" rows="2" maxlength="512" autocomplete="off" spellcheck="false" :aria-label="tr('配对邀请')" /></label><div class="nearby-actions"><m3e-button variant="filled" :disabled="!editable || !invitation.trim()" @click="pair(true)">{{ tr('连接设备') }}</m3e-button><m3e-button variant="tonal" :disabled="!editable || preferences.peers.length>=8" @click="pair(false)">{{ tr('显示本机邀请') }}</m3e-button></div></section>
    </template>
    <section class="nearby-section nearby-progress" aria-labelledby="nearby-status"><h2 id="nearby-status">{{ tr('同步状态') }}</h2><p role="status" aria-live="polite" data-nearby-phase>{{ phaseText }}<span v-if="view.peerName"> · {{ view.peerName }}</span><span v-if="view.applied"> · {{ tr('已保存 {0} 条记录',{0:view.applied}) }}</span></p>
      <template v-if="view.pairing?.invitations.length"><img v-if="qr" :src="qr" width="240" height="240" :alt="tr('本次配对邀请二维码')" /><label>{{ tr('本次配对邀请') }}<textarea readonly :value="view.pairing.invitations[0]" rows="3" :aria-label="tr('本次配对邀请')" spellcheck="false" /></label><m3e-button @click="copyInvitation">{{ copied ? tr('已复制') : tr('复制邀请') }}</m3e-button><small>{{ tr('邀请仅供可信设备使用。取消或离开页面后失效。') }}</small></template>
      <p v-if="view.endpoint" class="supporting">{{ tr('等待连接：{0}',{0:view.endpoint.addresses.map(address=>`${address}:${view.endpoint!.port}`).join(' · ')}) }}</p>
      <p v-if="view.recoveryOnly" class="supporting">{{ tr('正在恢复上次未完成的接收，完成后再次同步即可发送本机修改。') }}</p>
      <template v-if="view.review"><p>{{ tr('以下 Passkey 存在跨设备限制。原始密钥、凭据 ID 和计数历史会保留。') }}</p><ul><li v-for="issue in view.review.issues" :key="issue.id"><strong>{{ issue.account }}</strong> · {{ issue.relyingParty }}<p>{{ tr(issue.skipForCounter ? '已有正计数历史，本次跳过发送，保留本机凭据。' : issue.restriction==='device-only' ? '仅本机可用，另一端只能收到凭据引用。' : issue.restriction==='backup-restricted' ? '此凭据限制备份，另一端的可用性取决于网站策略。' : '另一端可能不支持此密钥算法。') }}</p></li></ul><m3e-button variant="filled" :disabled="busy" @click="confirm">{{ tr('了解限制并继续同步') }}</m3e-button></template>
      <m3e-button v-if="active || searching || busy" variant="tonal" @click="cancel">{{ tr('取消同步') }}</m3e-button>
    </section>
  </section>
</template>

<style scoped>
.nearby-settings { display:grid;gap:16px;min-width:0; }
.nearby-settings p { margin:0;line-height:1.5; }.supporting,small { color:var(--md-sys-color-on-surface-variant);font-size:.875rem;line-height:1.5; }
.nearby-section { display:grid;gap:12px;min-width:0; }.nearby-section h2 { margin:0;font-size:1rem;font-weight:600; }
.nearby-rows { display:grid;gap:4px; }.nearby-row { margin:0;padding:10px 14px;background:var(--md-sys-color-surface-container);border-radius:4px;min-width:0; }
.nearby-row:first-child {border-top-left-radius:24px;border-top-right-radius:24px;}.nearby-row:last-child{border-bottom-left-radius:24px;border-bottom-right-radius:24px;}
.toggle-row,.name-row{display:flex;align-items:center;gap:12px;}.toggle-row>div{flex:1;}.toggle-row small,.peer-row small{display:block;}.name-row input{min-width:0;flex:1;width:80px;}
.peer-row{display:grid;grid-template-columns:24px minmax(0,1fr) auto auto;gap:10px;align-items:center;}.peer-row strong{overflow-wrap:anywhere;}.forget{grid-column:1/-1;}
.nearby-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}.nearby-settings label{display:grid;gap:6px;font-size:.875rem;}.nearby-settings label.name-row{display:flex;}
.nearby-settings :is(input,textarea){box-sizing:border-box;max-width:100%;font:inherit;color:var(--md-sys-color-on-surface);background:var(--md-sys-color-surface-container-high);border:0;border-radius:12px;padding:10px 12px;outline:none;}.nearby-settings textarea{width:100%;resize:vertical;overflow-wrap:anywhere;}.nearby-settings :is(input,textarea):focus-visible{outline:2px solid var(--md-sys-color-primary);outline-offset:1px;}
.nearby-settings m3e-form-field{--m3e-form-field-container-color:transparent;}.nearby-settings summary{cursor:pointer;font-size:.875rem;line-height:2;}.nearby-settings details[open]{display:grid;gap:8px;}.nearby-progress{padding-top:8px;}.nearby-progress>m3e-button{justify-self:start;}.nearby-progress li{margin-bottom:10px;}.nearby-settings :disabled{opacity:.6;}
@media(max-width:520px){.peer-row{grid-template-columns:minmax(0,1fr) auto auto;}.peer-row>m3e-icon{display:none;}.name-row{flex-wrap:wrap;}.name-row>span{width:100%;}}
</style>
