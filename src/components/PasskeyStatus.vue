<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { PasskeyItem, ProviderAccount } from '../core/model';
import { capabilityLabel, capabilityReasonText, passkeyCapability, type KeyCapability } from '../passkey/capability';
import { managerPasskeyInspector } from '../manager/passkey-capability';
import { tr } from '../i18n';

const props = defineProps<{item: PasskeyItem; providers: ProviderAccount[]; detail?: boolean}>();
const key = ref<KeyCapability>('checking');
watch(() => [props.item.id, props.item.privateKeyPkcs8, props.item.algorithm] as const, async (_, __, onCleanup) => {
  let active = true;
  onCleanup(() => { active = false; });
  key.value = managerPasskeyInspector.peek(props.item) ?? 'checking';
  const result = await managerPasskeyInspector.inspect(props.item);
  if (active) key.value = result;
}, {immediate:true});
const status = computed(() => passkeyCapability(props.item,key.value,props.providers));
const label = computed(() => tr(capabilityLabel(status.value)));
const reasonTexts = computed(() => status.value.reasons
  .filter(reason => reason !== 'missing' || !status.value.reasons.includes('metadata'))
  .filter(reason => reason !== 'metadata' || !status.value.reasons.includes('device-reference'))
  .map(reason => tr(capabilityReasonText[reason])));
const tone = computed(() => status.value.browser === 'unavailable' ? 'error' : status.value.browser !== 'available' ? 'neutral' : status.value.transfer === 'restricted' ? 'limited' : 'ready');
const icon = computed(() => tone.value === 'error' ? 'warning' : tone.value === 'ready' ? 'check' : 'info');
</script>

<template>
  <section v-if="detail" class="passkey-capability-detail" :data-capability="tone" :aria-label="tr('Passkey 使用状态')">
    <div class="passkey-capability-heading"><m3e-icon :name="icon" aria-hidden="true" /><div><h3>{{ tr('使用状态') }}</h3><strong>{{ label }}</strong></div></div>
    <dl class="passkey-capability-facts">
      <div><dt>{{ tr('浏览器登录') }}</dt><dd>{{ status.browser === 'available' ? tr('密钥可用于签名；登录结果仍由网站验证。') : status.browser === 'unavailable' ? tr('当前不可用') : label }}</dd></div>
      <div><dt>{{ tr('跨端保存') }}</dt><dd>{{ status.transfer === 'portable' ? tr('可经 MDBX、KDBX 或 Bitwarden 保存密钥，再在支持的客户端使用。') : status.transfer === 'original-device' ? tr('仅原设备密钥') : status.transfer === 'restricted' ? tr('存在兼容限制，请查看下方原因。') : tr('暂不能确认可跨端使用') }}</dd></div>
    </dl>
    <ul v-if="reasonTexts.length" class="passkey-capability-reasons"><li v-for="reason in reasonTexts" :key="reason">{{ reason }}</li></ul>
    <p v-if="status.localStorageOnly" class="passkey-capability-storage">{{ tr('当前保存在 Monica 本地库，尚未连接同步；这不代表密钥只能在本机使用。') }}</p>
  </section>
  <span v-else class="passkey-status-badges" :title="reasonTexts.join('\n') || tr('密钥可用于签名；登录结果仍由网站验证。')">
    <span class="passkey-status-badge" :data-capability="tone"><m3e-icon :name="icon" aria-hidden="true" />{{ label }}</span>
    <span v-if="status.transfer === 'original-device'" class="passkey-status-badge" data-capability="neutral">{{ tr('仅原设备') }}</span>
  </span>
</template>

<style scoped>
.passkey-status-badges{display:inline-flex;flex-wrap:wrap;gap:4px;max-width:100%}
.passkey-status-badge{display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border-radius:99px;font-size:11px;font-weight:600;line-height:1.4;white-space:normal}
[data-capability="error"]{--status-bg:var(--md-sys-color-error-container);--status-fg:var(--md-sys-color-on-error-container)}
[data-capability="limited"]{--status-bg:var(--md-sys-color-tertiary-container);--status-fg:var(--md-sys-color-on-tertiary-container)}
[data-capability="ready"]{--status-bg:var(--md-sys-color-secondary-container);--status-fg:var(--md-sys-color-on-secondary-container)}
[data-capability="neutral"]{--status-bg:var(--md-sys-color-surface-container-high);--status-fg:var(--md-sys-color-on-surface-variant)}
.passkey-status-badge{background:var(--status-bg);color:var(--status-fg)}
.passkey-status-badge m3e-icon{font-size:14px;flex:none}
.passkey-capability-detail{order:-3;min-width:0;margin-bottom:16px}
.passkey-capability-heading{display:flex;align-items:center;gap:12px;background:var(--status-bg);color:var(--status-fg);padding:16px;border-radius:24px 24px 4px 4px}
.passkey-capability-heading m3e-icon{flex:none;font-size:24px}
.passkey-capability-detail h3{font-size:12px;margin:0 0 4px;font-weight:500}
.passkey-capability-detail strong{font-size:16px}
.passkey-capability-facts{margin:4px 0;display:grid;gap:4px}
.passkey-capability-facts>div{background:var(--md-sys-color-surface-container);padding:14px 16px;border-radius:4px}
.passkey-capability-facts>div:last-child{border-radius:4px 4px 24px 24px}
.passkey-capability-facts dt{font-size:12px;color:var(--md-sys-color-on-surface-variant);margin-bottom:6px}
.passkey-capability-facts dd{margin:0;line-height:1.6;overflow-wrap:anywhere}
.passkey-capability-reasons{margin:12px 0;padding-left:22px;line-height:1.65;font-size:13px;overflow-wrap:anywhere}
.passkey-capability-reasons li+li{margin-top:8px}
.passkey-capability-storage{font-size:12px;line-height:1.6;color:var(--md-sys-color-on-surface-variant);margin:12px 4px}
</style>
