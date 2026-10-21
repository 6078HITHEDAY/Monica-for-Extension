<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { tr } from '../i18n';
import { CLIPBOARD_DELAYS, CLIPBOARD_PERMISSIONS, CLIPBOARD_PREFERENCES_KEY, clipboardPreferences } from '../security/clipboard-lifecycle';
const enabled = ref(false), seconds = ref(60), busy = ref(false), error = ref('');
async function load() {
  try {
    const stored = await chrome.storage.local.get(CLIPBOARD_PREFERENCES_KEY);
    const value = clipboardPreferences(stored[CLIPBOARD_PREFERENCES_KEY]);
    enabled.value = value.enabled && await chrome.permissions.contains({ permissions: [...CLIPBOARD_PERMISSIONS] }); seconds.value = value.seconds;
  } catch { error.value = tr('未能保存剪贴板设置，请重试。'); }
}
function permissionChanged() { void load(); }
function changed(changes: Record<string, chrome.storage.StorageChange>, area: string) { if (area === 'local' && changes[CLIPBOARD_PREFERENCES_KEY]) void load(); }
onMounted(() => { void load(); chrome.storage.onChanged.addListener(changed); chrome.permissions.onRemoved.addListener(permissionChanged); });
onUnmounted(() => { chrome.storage.onChanged.removeListener(changed); chrome.permissions.onRemoved.removeListener(permissionChanged); });
async function toggle() {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try {
    const next = !enabled.value;
    // Request directly in the user's gesture before asynchronous storage reads.
    if (next && !await chrome.permissions.request({ permissions: [...CLIPBOARD_PERMISSIONS] })) {
      error.value = tr('未授予剪贴板权限，自动清理仍关闭。'); return;
    }
    await chrome.storage.local.set({ [CLIPBOARD_PREFERENCES_KEY]: { enabled: next, seconds: seconds.value } });
    if (!next) await chrome.permissions.remove({ permissions: [...CLIPBOARD_PERMISSIONS] });
    await load();
  } catch { error.value = tr('未能保存剪贴板设置，请重试。'); }
  finally { busy.value = false; }
}
async function updateDelay(event: Event) {
  const value = Number((event.target as HTMLSelectElement).value);
  if (!CLIPBOARD_DELAYS.includes(value as 60)) return;
  try { await chrome.storage.local.set({ [CLIPBOARD_PREFERENCES_KEY]: { enabled: enabled.value, seconds: value } }); await load(); }
  catch { error.value = tr('未能保存剪贴板设置，请重试。'); }
}
</script>
<template>
  <section class="clipboard-settings" aria-labelledby="clipboard-settings-title">
    <div class="clipboard-toggle"><div><strong id="clipboard-settings-title">{{ tr('自动清理复制的内容') }}</strong><p id="clipboard-settings-description">{{ tr('默认关闭。开启后，密码、验证码等复制内容到期尝试清理；锁库时提前清理。') }}</p></div><m3e-switch :checked.prop="enabled" :disabled="busy" aria-labelledby="clipboard-settings-title" aria-describedby="clipboard-settings-description" @beforeinput.prevent="toggle" /></div>
    <label v-if="enabled" class="clipboard-delay">{{ tr('清理时间') }}<select :value="seconds" @change="updateDelay"><option v-for="delay in CLIPBOARD_DELAYS" :key="delay" :value="delay">{{ tr('{0} 秒', {0: delay}) }}</option></select></label>
    <p class="supporting">{{ tr('只清理仍与 Monica 上次复制一致的文本。浏览器退出、权限失效或系统休眠可能延后或阻止清理；系统剪贴板历史和跨设备副本无法保证清除。') }}</p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.clipboard-settings{display:grid;gap:12px;min-width:0}.clipboard-toggle{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:16px}p{margin:4px 0 0;font-size:.875rem;color:var(--app-muted);line-height:1.5;overflow-wrap:anywhere}.clipboard-delay{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}select{font:inherit;color:var(--app-text);background:var(--app-surface);border:1px solid var(--app-outline);border-radius:16px;padding:10px 16px;min-height:44px}select:focus-visible{outline:2px solid var(--app-primary);outline-offset:3px}
</style>
