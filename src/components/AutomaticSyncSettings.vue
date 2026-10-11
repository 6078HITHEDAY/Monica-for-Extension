<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { tr } from "../i18n";
import { AUTO_SYNC_PREFERENCES_KEY, readAutomaticSyncEnabled, writeAutomaticSyncEnabled } from "../providers/sync-preferences";

const enabled = ref(true);
const ready = ref(false);
const saving = ref(false);
const failed = ref(false);
let revision = 0;
function changed(changes: Record<string, chrome.storage.StorageChange>, area: string): void {
  if (area !== "local" || !changes[AUTO_SYNC_PREFERENCES_KEY]) return;
  revision += 1;
  enabled.value = (changes[AUTO_SYNC_PREFERENCES_KEY].newValue as { enabled?: unknown } | undefined)?.enabled !== false;
}
onMounted(async () => {
  chrome.storage.onChanged.addListener(changed);
  const current = revision;
  try {
    const value = await readAutomaticSyncEnabled();
    if (current === revision) enabled.value = value;
    ready.value = true;
  } catch { failed.value = true; }
});
onUnmounted(() => chrome.storage.onChanged.removeListener(changed));
async function toggle(): Promise<void> {
  if (!ready.value || saving.value) return;
  saving.value = true;
  failed.value = false;
  try { await writeAutomaticSyncEnabled(!enabled.value); }
  catch { failed.value = true; }
  finally { saving.value = false; }
}
</script>

<template>
    <section class="automatic-sync-setting" aria-labelledby="automatic-sync-label">
      <div class="automatic-sync-row">
        <strong id="automatic-sync-label">{{ tr('自动同步') }}</strong>
        <m3e-switch :checked.prop="enabled" @beforeinput.prevent="toggle"    aria-labelledby="automatic-sync-label" aria-describedby="automatic-sync-description" :disabled="!ready || saving" ></m3e-switch>
        <p id="automatic-sync-description">{{ tr('锁定密码库后暂停。关闭后仍可手动同步。') }}</p>
      </div>
      <p v-if="failed" class="form-error" role="alert">{{ tr('未能保存同步设置，请重试。') }}</p>
    </section>
</template>

<style scoped>
section { min-width: 0; }
.automatic-sync-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: 16px; row-gap: 0; }
.automatic-sync-row > p { grid-column: 1 / -1; }
strong { font-size: 1rem; font-weight: 600; }
p { margin: 4px 0 0; font-size: .875rem; line-height: 1.5; color: var(--app-muted); }
small { display: block; margin-top: 8px; color: var(--app-muted); font-size: .75rem; line-height: 1.6; }
strong, p, small { overflow-wrap: anywhere; }
</style>
