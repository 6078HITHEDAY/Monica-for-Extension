<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { tr, locale } from '../i18n';
import { vaultClient } from '../runtime/client';
import type { VaultStorageOverview } from '../security/vault-recovery';
const emit = defineEmits<{ exportRecovery: [id: string] }>();
const storageInfo = ref<VaultStorageOverview>(), busy = ref(false), error = ref(''), confirmClear = ref(false);
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
async function load() {
  busy.value = true; error.value = '';
  try { storageInfo.value = await vaultClient.storageOverview(); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : tr('读取存储状态失败。'); }
  finally { busy.value = false; }
}
async function clearHistory() {
  busy.value = true; error.value = '';
  try { await vaultClient.clearRecoveryCopies(); confirmClear.value = false; await load(); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : tr('清理失败，请重试。'); }
  finally { busy.value = false; }
}
onMounted(load);
</script>
<template>
  <section class="settings-content" aria-labelledby="vault-storage-heading">
    <h2 id="vault-storage-heading">{{ tr('容量与本机恢复副本') }}</h2>
    <template v-if="storageInfo">
      <p>{{ tr('扩展工作库：{0} / {1}', {0: size(storageInfo.bytes), 1: size(storageInfo.limit)}) }}</p>
      <meter :value="storageInfo.bytes" :max="storageInfo.limit" :low="storageInfo.limit * .7" :high="storageInfo.limit * .85" :optimum="0" :aria-label="tr('扩展工作库容量')" />
      <p v-if="storageInfo.bytes >= storageInfo.limit * .8" class="settings-safety-note" role="status">{{ tr('工作库接近容量上限，请先导出独立加密备份，再整理项目与附件。外部数据库容量另行计算。') }}</p>
      <p class="supporting">{{ tr('每 15 分钟最多保留一个修改前检查点，最多 3 份、合计 64 MiB。更改保护方式会清理旧副本；空间不足时优先保存当前库。') }}</p>
      <p class="supporting">{{ tr('副本可能包含已删除项目和旧密码，与当前库同处浏览器配置，不能替代独立备份。导出副本需重新认证和设置独立备份密码，不会自动覆盖当前库。') }}</p>
      <ul v-if="storageInfo.copies.length" class="recovery-copies">
        <li v-for="copy in storageInfo.copies" :key="copy.id"><span>{{ new Date(copy.createdAt).toLocaleString(locale) }}<small>{{ size(copy.bytes) }}</small></span><m3e-button variant="text" :disabled="busy" @click="emit('exportRecovery', copy.id)">{{ tr('验证并导出副本') }}</m3e-button></li>
      </ul>
      <p v-else class="supporting">{{ tr('暂无恢复副本；后续修改前会自动保留检查点。') }}</p>
      <div class="source-actions"><m3e-button variant="text" :disabled="busy" @click="load">{{ tr('刷新状态') }}</m3e-button><m3e-button v-if="storageInfo.copies.length && !confirmClear" variant="text" :disabled="busy" @click="confirmClear = true">{{ tr('清理历史副本') }}</m3e-button></div>
      <div v-if="confirmClear" role="group" :aria-label="tr('确认清理历史副本')"><p>{{ tr('只删除本机历史恢复副本，当前库和已下载的备份不受影响。确认清理？') }}</p><m3e-button variant="text" @click="confirmClear = false">{{ tr('取消') }}</m3e-button><m3e-button variant="filled" :disabled="busy" @click="clearHistory">{{ tr('确认清理历史副本') }}</m3e-button></div>
    </template>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
meter{width:100%;height:14px}.recovery-copies{list-style:none;padding:0;margin:0;display:grid;gap:4px}.recovery-copies li{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;background:var(--app-surface);border-radius:12px;padding:12px 16px}.recovery-copies small{display:block;color:var(--app-muted);margin-top:4px}p,span{overflow-wrap:anywhere}
</style>
