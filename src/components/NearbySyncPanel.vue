<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import '@m3e/web/progress-indicator';
import { locale, tr } from '../i18n';
import { materialOptionTag, materialSelectTag } from '../lib/material-controls';
import { createQrDataUrl } from '../core/otp-qr';
import { NearbyManagerClient, NearbyManagerError } from '../nearby/manager-client';
import { nearbyClosedMessage, nearbyErrorMessage, nearbyStageLabel, type NearbyMessage } from '../nearby/manager-messages';
import type { NearbyCoordinatorView } from '../nearby/local-coordinator';
import type { NearbyPasskeyReview } from '../nearby/passkey-consent';
import type { NearbyPreferencesView, NearbySyncMode } from '../nearby/preferences';

type Action = '' | 'pair' | 'connect' | 'sync' | 'save';
const connection = ref<'connecting' | 'ready' | 'closed'>('connecting');
const notice = ref<NearbyMessage>();
const success = ref('');
const preferences = ref<NearbyPreferencesView>();
const view = ref<NearbyCoordinatorView>({ phase: 'idle' });
const action = ref<Action>('');
const activePeer = ref<string>();
const searching = ref(false);
const pairingQr = ref<string>();
const pairingLink = ref('');
const copied = ref(false);
const invitationInput = ref('');
const nameDraft = ref('');
const review = ref<NearbyPasskeyReview>();
const forgetting = ref<string>();
const automaticNote = ref('');
let decide: ((accepted: boolean) => void) | undefined;
let automaticTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
/** Set when an automatic round needs a Passkey decision that only the user can make. */
let automaticNeedsReview = false;

const client = new NearbyManagerClient({ ready: connected, closed });
const busy = computed(() => !!action.value);
const peers = computed(() => [...(preferences.value?.peers ?? [])].sort((a, b) => a.name.localeCompare(b.name)));
const activePeerName = computed(() => view.value.peerName || peers.value.find(peer => peer.deviceId === activePeer.value)?.name || tr('手机'));
const progressValue = computed(() => {
  const transport = view.value.transport;
  return transport && transport.total > 0 ? Math.min(100, Math.round(transport.transferred / transport.total * 100)) : undefined;
});
const stageText = computed(() => {
  if (searching.value) return tr('正在局域网中查找 {0}', { 0: activePeerName.value });
  if (view.value.phase === 'preparing') return tr('正在准备同步内容');
  if (view.value.phase === 'saving') return tr('正在保存收到的内容');
  if (action.value === 'pair') return tr('等待手机扫描配对二维码');
  if (action.value === 'connect' && view.value.phase !== 'transferring') return tr('正在连接手机');
  return nearbyStageLabel(view.value.transport?.stage);
});
const modes: Array<{ value: NearbySyncMode; label: () => string }> = [
  { value: 'bidirectional', label: () => tr('双向同步') },
  { value: 'send_only', label: () => tr('仅发送到手机') },
  { value: 'receive_only', label: () => tr('仅从手机接收') }
];
const intervals = [0, 60, 300, 900, 3600];
function intervalLabel(seconds: number): string {
  if (!seconds) return tr('有更改时尽快同步');
  return seconds < 3600 ? tr('每 {0} 分钟', { 0: seconds / 60 }) : tr('每小时');
}
function syncedAt(value: number): string {
  return value ? tr('上次同步：{0}', { 0: new Date(value).toLocaleString(locale.value) }) : tr('已配对，尚未同步');
}
function code(error: unknown): string { return error instanceof NearbyManagerError ? error.code : 'operation-failed'; }
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

function connected(): void {
  connection.value = 'ready';
  void loadPreferences().then(() => scheduleAutomatic(1_000));
}
function closed(reason: string): void {
  connection.value = 'closed';
  clearTimeout(automaticTimer);
  decide?.(false); decide = undefined; review.value = undefined;
  pairingQr.value = undefined; pairingLink.value = ''; searching.value = false;
  if (disposed) return;
  const message = nearbyClosedMessage(reason);
  if (message) notice.value = message;
  // User cancellation ends the lease; reopen a fresh one for the next action.
  else reconnectTimer = setTimeout(reconnect, 250);
}
function reconnect(): void {
  if (disposed || client.connected) return;
  connection.value = 'connecting';
  client.open();
}
async function loadPreferences(): Promise<void> {
  try {
    preferences.value = await client.request<NearbyPreferencesView>({ type: 'preferences' });
    nameDraft.value = preferences.value.name;
  } catch (error) { if (client.connected) notice.value = nearbyErrorMessage(code(error)); }
}

/** Follow native progress until the operation settles. `busy` only means a
 * previous request is still running in the background. */
async function follow(): Promise<NearbyCoordinatorView> {
  for (;;) {
    await delay(700);
    if (!client.connected) throw new NearbyManagerError('manager-closed');
    let next: NearbyCoordinatorView;
    try { next = await client.request<NearbyCoordinatorView>({ type: 'progress' }); }
    catch (error) { if (code(error) === 'busy') continue; throw error; }
    view.value = next;
    if (next.phase === 'completed' || next.phase === 'failed' || next.phase === 'cancelled') return next;
  }
}

const quietCodes = new Set(['peer-not-found', 'discovery-unavailable', 'connection-failed', 'connection-closed', 'transfer-timeout']);
async function run(name: Exclude<Action, ''>, task: () => Promise<void>, quiet = false): Promise<boolean> {
  if (action.value || connection.value !== 'ready') return false;
  action.value = name;
  if (!quiet) { notice.value = undefined; success.value = ''; automaticNote.value = ''; }
  try { await task(); return true; }
  catch (error) {
    const failure = code(error);
    view.value = { phase: 'failed', error: failure };
    // A closed lease explains itself through `closed`.
    if (client.connected) {
      if (quiet && quietCodes.has(failure)) automaticNote.value = tr('暂未连接到手机，稍后会自动重试。');
      else notice.value = nearbyErrorMessage(failure);
    }
    return false;
  } finally {
    action.value = ''; activePeer.value = undefined; searching.value = false;
    pairingQr.value = undefined; pairingLink.value = ''; copied.value = false;
  }
}

async function showPairing(): Promise<void> {
  await run('pair', async () => {
    view.value = await client.request<NearbyCoordinatorView>({ type: 'pair' });
    pairingLink.value = view.value.pairing?.invitations[0] ?? '';
    pairingQr.value = pairingLink.value ? await createQrDataUrl(pairingLink.value) : undefined;
    const done = await follow();
    if (done.phase === 'completed') { success.value = tr('已与 {0} 配对。现在可以同步。', { 0: done.peerName || tr('手机') }); await loadPreferences(); }
  });
}
async function connectInvitation(): Promise<void> {
  const invitation = invitationInput.value.trim();
  if (!invitation) return;
  if (invitation.length > 512 || !invitation.startsWith('monica-lan:')) { notice.value = nearbyErrorMessage('invalid-invitation'); return; }
  const ok = await run('connect', async () => {
    view.value = await client.request<NearbyCoordinatorView>({ type: 'pair', invitation });
    const done = await follow();
    if (done.phase === 'completed') { success.value = tr('已与 {0} 配对。现在可以同步。', { 0: done.peerName || tr('手机') }); await loadPreferences(); }
  });
  if (ok) invitationInput.value = '';
}
async function copyLink(): Promise<void> {
  try { await navigator.clipboard.writeText(pairingLink.value); copied.value = true; } catch { copied.value = false; }
}

function askReview(next: NearbyPasskeyReview): Promise<boolean> {
  review.value = next;
  return new Promise(resolve => { decide = accepted => { review.value = undefined; decide = undefined; resolve(accepted); }; });
}
async function syncPeer(peerId: string, quiet = false): Promise<boolean> {
  let completed = false;
  const ok = await run('sync', async () => {
    activePeer.value = peerId;
    let prepared = view.value = await client.request<NearbyCoordinatorView>({ type: 'prepare', peerId });
    if (prepared.phase === 'review' && prepared.review) {
      // Restricted Passkeys always need an explicit, per-device decision.
      // Release the prepared snapshot and wait for a manual Sync now instead of retrying.
      if (quiet) { automaticNeedsReview = true; client.cancel(); return; }
      if (!await askReview(prepared.review)) { client.cancel(); return; }
      prepared = view.value = await client.request<NearbyCoordinatorView>({ type: 'confirm', reviewId: prepared.review.id });
    }
    searching.value = true;
    view.value = await client.request<NearbyCoordinatorView>({ type: 'start' });
    searching.value = false;
    const done = await follow();
    if (done.phase === 'completed') {
      completed = true; automaticNote.value = '';
      if (!quiet && automaticNeedsReview) { automaticNeedsReview = false; scheduleAutomatic(60_000); }
      if (!quiet || done.applied) success.value = done.applied
        ? tr('已与 {0} 同步，保存了 {1} 项更改。', { 0: done.peerName || activePeerName.value, 1: done.applied })
        : tr('已与 {0} 同步。', { 0: done.peerName || activePeerName.value });
      await loadPreferences();
    }
  }, quiet);
  return ok && completed;
}
function cancel(): void {
  decide?.(false);
  client.cancel();
}

async function update(change: { name?: string; enabled?: boolean; mode?: NearbySyncMode; intervalSeconds?: number } | { kind: 'forget'; deviceId: string }): Promise<void> {
  await run('save', async () => {
    const body = 'kind' in change ? change : { kind: 'preferences' as const, ...change };
    for (let attempt = 0; ; attempt++) {
      try {
        preferences.value = await client.request<NearbyPreferencesView>({ type: 'update', epoch: preferences.value!.epoch, change: body });
        nameDraft.value = preferences.value.name;
        return;
      } catch (error) {
        // A sync may have saved newer trust; reload once and apply the same change.
        if (attempt || code(error) !== 'stale-session') throw error;
        preferences.value = await client.request<NearbyPreferencesView>({ type: 'preferences' });
      }
    }
  });
  forgetting.value = undefined;
  scheduleAutomatic(1_000);
}
function saveName(): void {
  const name = nameDraft.value.trim();
  if (!preferences.value || !name || name === preferences.value.name || [...name].length > 64) { nameDraft.value = preferences.value?.name ?? ''; return; }
  void update({ name });
}
function selected(event: Event): string { return (event.target as HTMLElement & { value: string }).value; }

/** Automatic rounds run only while this page holds the lease. A phone that is
 * not reachable is retried quietly; tapping Sync now there is picked up here. */
function scheduleAutomatic(milliseconds: number): void {
  clearTimeout(automaticTimer);
  if (disposed || !preferences.value?.enabled) { automaticNote.value = ''; return; }
  if (automaticNeedsReview) { automaticNote.value = tr('需要确认 Passkey 传输限制后才能自动同步。请点按“立即同步”。'); return; }
  automaticTimer = setTimeout(() => void automaticRound(), milliseconds);
}
async function automaticRound(): Promise<void> {
  const current = preferences.value;
  if (!current?.enabled || connection.value !== 'ready') return;
  if (action.value || review.value) { scheduleAutomatic(5_000); return; }
  let synced = current.peers.length > 0;
  for (const peer of peers.value) {
    if (!preferences.value?.enabled || connection.value !== 'ready') return;
    synced = await syncPeer(peer.deviceId, true) && synced;
  }
  const interval = Math.max(60, preferences.value?.intervalSeconds ?? 0);
  scheduleAutomatic(synced ? interval * 1_000 : 30_000);
}

onMounted(() => client.open());
onUnmounted(() => {
  disposed = true; clearTimeout(automaticTimer); clearTimeout(reconnectTimer);
  decide?.(false); client.close();
});
</script>

<template>
  <section class="settings-content nearby-sync" aria-labelledby="nearby-status-heading" data-nearby-sync>
    <div class="nearby-heading">
      <span class="nearby-heading-icon"><m3e-icon name="wifi" aria-hidden="true" /></span>
      <div><h2 id="nearby-status-heading">{{ tr('与 Monica 安卓版进行 Wi-Fi 同步') }}</h2>
        <p class="settings-safety-note">{{ tr('在同一 Wi-Fi 下点对点加密同步，无需云端中转。主密码不会被发送。') }}</p></div>
    </div>

    <p v-if="connection === 'connecting'" class="supporting" aria-live="polite">{{ tr('正在连接附近设备同步服务…') }}</p>
    <div v-if="notice" class="nearby-notice" role="alert">
      <m3e-icon name="error" aria-hidden="true" />
      <div><strong>{{ notice.message }}</strong><p v-if="notice.hint">{{ notice.hint }}</p></div>
      <m3e-button v-if="connection === 'closed'" variant="tonal" @click="notice = undefined; reconnect()"><m3e-icon slot="icon" name="refresh" />{{ tr('重新连接') }}</m3e-button>
    </div>
    <p v-if="success" class="nearby-success" role="status"><m3e-icon name="check_circle" aria-hidden="true" />{{ success }}</p>

    <div v-if="review" class="nearby-review" role="group" aria-labelledby="nearby-review-heading">
      <h3 id="nearby-review-heading">{{ tr('确认 Passkey 传输限制') }}</h3>
      <p>{{ tr('以下 Passkey 来自受限来源。确认后，它们会发送到 {0}；带有使用计数的副本仍只保留在本机。', { 0: activePeerName }) }}</p>
      <ul><li v-for="issue in review.issues" :key="issue.id"><m3e-icon name="passkey" aria-hidden="true" /><span>{{ issue.account || tr('未命名账号') }} · {{ issue.relyingParty }}<small v-if="issue.skipForCounter">{{ tr('不会发送（已有使用计数）') }}</small></span></li></ul>
      <div class="nearby-actions"><m3e-button variant="filled" @click="decide?.(true)">{{ tr('确认并同步') }}</m3e-button><m3e-button variant="text" @click="decide?.(false)">{{ tr('取消') }}</m3e-button></div>
    </div>

    <div v-else-if="busy && action !== 'save'" class="nearby-progress" aria-live="polite">
      <strong>{{ stageText }}</strong>
      <m3e-linear-progress-indicator v-if="progressValue !== undefined" :value.prop="progressValue" :max.prop="100" :aria-label="stageText" />
      <m3e-linear-progress-indicator v-else mode="indeterminate" :aria-label="stageText" />
      <small v-if="view.applied">{{ tr('已保存 {0} 项更改', { 0: view.applied }) }}</small>
      <m3e-button variant="text" @click="cancel"><m3e-icon slot="icon" name="close" />{{ tr('取消') }}</m3e-button>
    </div>
    <p v-else-if="automaticNote" class="supporting" aria-live="polite">{{ automaticNote }}</p>
  </section>

  <section class="settings-content" aria-labelledby="nearby-devices-heading">
    <h2 id="nearby-devices-heading">{{ tr('已配对设备') }}</h2>
    <p v-if="preferences && !peers.length" class="supporting">{{ tr('还没有配对的设备。请在下方添加你的手机。') }}</p>
    <ul v-else class="nearby-peers">
      <li v-for="peer in peers" :key="peer.deviceId">
        <span class="nearby-peer-icon"><m3e-icon name="smartphone" aria-hidden="true" /></span>
        <span class="nearby-peer-copy"><strong>{{ peer.name || tr('手机') }}</strong><small>{{ syncedAt(peer.lastSyncedAt) }}</small></span>
        <span class="nearby-actions">
          <template v-if="forgetting === peer.deviceId">
            <m3e-button variant="filled" :disabled="busy" @click="update({ kind: 'forget', deviceId: peer.deviceId })">{{ tr('确认移除') }}</m3e-button>
            <m3e-button variant="text" @click="forgetting = undefined">{{ tr('取消') }}</m3e-button>
          </template>
          <template v-else>
            <m3e-button variant="tonal" :disabled="busy || connection !== 'ready'" @click="syncPeer(peer.deviceId)"><m3e-icon slot="icon" name="sync" />{{ tr('立即同步') }}</m3e-button>
            <m3e-icon-button :aria-label="tr('移除 {0}', { 0: peer.name || tr('手机') })" :disabled="busy" @click="forgetting = peer.deviceId"><m3e-icon name="delete" /></m3e-icon-button>
          </template>
        </span>
      </li>
    </ul>
    <p v-if="forgetting" class="settings-safety-note">{{ tr('移除后不会删除任何密码；之后需要重新配对。也请在手机上移除这台浏览器。') }}</p>
  </section>

  <section class="settings-content" aria-labelledby="nearby-add-heading">
    <h2 id="nearby-add-heading">{{ tr('添加设备') }}</h2>
    <p class="settings-safety-note">{{ tr('在手机上打开 Monica 的附近设备同步，选择“添加设备”，然后扫描这里的二维码；或在手机上生成配对链接并粘贴到下方。') }}</p>
    <div v-if="action === 'pair' && pairingQr" class="nearby-pairing">
      <img :src="pairingQr" width="240" height="240" :alt="tr('配对二维码')" />
      <div class="nearby-pairing-copy">
        <p>{{ tr('用手机扫描此二维码。配对只交换设备密钥，不会传输密码。') }}</p>
        <m3e-button variant="text" @click="copyLink"><m3e-icon slot="icon" name="content_copy" />{{ copied ? tr('已复制') : tr('复制配对链接') }}</m3e-button>
      </div>
    </div>
    <div class="nearby-actions">
      <m3e-button variant="filled" :disabled="busy || connection !== 'ready'" @click="showPairing"><m3e-icon slot="icon" name="qr_code_2" />{{ tr('显示配对二维码') }}</m3e-button>
    </div>
    <form class="nearby-invitation" @submit.prevent="connectInvitation">
      <label for="nearby-invitation">{{ tr('或粘贴手机生成的配对链接') }}</label>
      <m3e-form-field variant="filled" hide-required-marker hide-subscript="always">
        <input id="nearby-invitation" v-model="invitationInput" type="text" autocomplete="off" spellcheck="false" maxlength="600" placeholder="monica-lan:2:…" />
      </m3e-form-field>
      <m3e-button variant="tonal" :disabled="busy || connection !== 'ready' || !invitationInput.trim()" @click="connectInvitation"><m3e-icon slot="icon" name="link" />{{ tr('连接') }}</m3e-button>
    </form>
  </section>

  <section v-if="preferences" class="settings-content" aria-labelledby="nearby-settings-heading">
    <h2 id="nearby-settings-heading">{{ tr('同步设置') }}</h2>
    <div class="nearby-switch-row">
      <strong id="nearby-automatic-label">{{ tr('打开此页面时自动同步') }}</strong>
      <m3e-switch :checked.prop="preferences.enabled" :disabled="busy" aria-labelledby="nearby-automatic-label" aria-describedby="nearby-automatic-description" @beforeinput.prevent="update({ enabled: !preferences.enabled })"></m3e-switch>
      <p id="nearby-automatic-description">{{ tr('保持此页面打开时，会定期与已配对的手机同步。手机上也需要打开 Monica。') }}</p>
    </div>
    <div class="nearby-field">
      <label for="nearby-device-name">{{ tr('此浏览器在手机上显示的名称') }}</label>
      <m3e-form-field variant="filled" hide-required-marker hide-subscript="always">
        <input id="nearby-device-name" v-model="nameDraft" type="text" maxlength="64" autocomplete="off" :disabled="busy" @change="saveName" @keydown.enter.prevent="saveName" />
      </m3e-form-field>
    </div>
    <m3e-form-field v-field-label variant="filled" hide-required-marker hide-subscript="always" data-settings-select>
      <label slot="label">{{ tr('同步方向') }}</label>
      <component :is="materialSelectTag" :aria-label="tr('同步方向')" :disabled="busy" @change="update({ mode: selected($event) as NearbySyncMode })">
        <component :is="materialOptionTag" v-for="mode in modes" :key="mode.value" :value="mode.value" :selected.prop="preferences.mode === mode.value">{{ mode.label() }}</component>
      </component>
    </m3e-form-field>
    <m3e-form-field v-field-label variant="filled" hide-required-marker hide-subscript="always" data-settings-select>
      <label slot="label">{{ tr('自动同步频率') }}</label>
      <component :is="materialSelectTag" :aria-label="tr('自动同步频率')" :disabled="busy" @change="update({ intervalSeconds: Number(selected($event)) })">
        <component :is="materialOptionTag" v-for="seconds in intervals" :key="seconds" :value="String(seconds)" :selected.prop="preferences.intervalSeconds === seconds">{{ intervalLabel(seconds) }}</component>
      </component>
    </m3e-form-field>
    <p class="settings-safety-note">{{ tr('同步频率会与已配对的手机共享，以最新的修改为准。') }}</p>
  </section>

  <section class="settings-content" aria-labelledby="nearby-help-heading">
    <h2 id="nearby-help-heading">{{ tr('使用说明与排障') }}</h2>
    <ol class="nearby-help">
      <li>{{ tr('安装 Monica 本机助手。浏览器扩展本身无法打开局域网连接，Wi-Fi 同步由本机助手完成。') }}</li>
      <li>{{ tr('让电脑和手机连接同一个 Wi-Fi，关闭 VPN；访客网络或开启 AP 隔离的路由器会阻止设备互连。') }}</li>
      <li>{{ tr('首次使用时扫描配对二维码。之后在手机上点按“立即同步”并在这里点按“立即同步”，或开启自动同步。') }}</li>
      <li>{{ tr('如果系统防火墙询问，请允许 Monica 本机助手访问专用网络。') }}</li>
      <li>{{ tr('Bitwarden 与 KeePass 来源使用各自的同步方式，不会通过 Wi-Fi 同步发送。') }}</li>
    </ol>
  </section>
</template>

<style scoped>
.nearby-heading { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 16px; align-items: start; }
.nearby-heading p { margin: 6px 0 0; }
.nearby-heading-icon, .nearby-peer-icon { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container); }
.nearby-notice { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 12px; padding: 16px; border-radius: 16px; background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container); }
.nearby-notice p { margin: 4px 0 0; font-size: .875rem; line-height: 1.5; }
.nearby-notice m3e-button { grid-column: 2; justify-self: start; }
.nearby-success { display: flex; gap: 8px; align-items: center; margin: 0; color: var(--md-sys-color-primary); font-weight: 500; }
.nearby-progress { display: grid; gap: 8px; }
.nearby-progress m3e-button { justify-self: start; }
.nearby-progress small { color: var(--md-sys-color-on-surface-variant); }
.nearby-review { display: grid; gap: 12px; padding: 16px; border-radius: 16px; background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); }
.nearby-review h3, .nearby-review p { margin: 0; }
.nearby-review ul, .nearby-peers { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.nearby-review li { display: flex; gap: 8px; align-items: center; }
.nearby-review small { display: block; opacity: .8; }
.nearby-peers li { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; gap: 16px; align-items: center; padding: 8px 0; }
.nearby-peer-copy { display: grid; gap: 2px; min-width: 0; }
.nearby-peer-copy strong { overflow-wrap: anywhere; }
.nearby-peer-copy small { color: var(--md-sys-color-on-surface-variant); }
.nearby-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.nearby-pairing { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; }
.nearby-pairing img { width: 240px; height: 240px; max-width: 100%; border-radius: 16px; background: #fff; }
.nearby-pairing-copy { display: grid; gap: 8px; flex: 1 1 200px; min-width: 0; }
.nearby-pairing-copy p { margin: 0; }
.nearby-invitation, .nearby-field { display: grid; gap: 8px; min-width: 0; }
.nearby-invitation m3e-button { justify-self: start; }
.nearby-invitation label, .nearby-field label { font-size: .875rem; color: var(--md-sys-color-on-surface-variant); }
.nearby-switch-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: 16px; }
.nearby-switch-row p { grid-column: 1 / -1; margin: 4px 0 0; font-size: .875rem; line-height: 1.5; color: var(--md-sys-color-on-surface-variant); }
.nearby-help { margin: 0; padding-inline-start: 20px; display: grid; gap: 8px; line-height: 1.6; color: var(--md-sys-color-on-surface-variant); font-size: .875rem; }
@media (max-width: 480px) {
  .nearby-peers li { grid-template-columns: 40px minmax(0, 1fr); }
  .nearby-peers .nearby-actions { grid-column: 1 / -1; }
}
</style>
