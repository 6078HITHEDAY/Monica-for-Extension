<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { tr } from '../i18n';
import { vaultClient } from '../runtime/client';
import SettingsPasswordField from './SettingsPasswordField.vue';
import { MIN_MASTER_PASSWORD_LENGTH } from '../security/master-password-policy';
import type { VaultExportResult } from '../security/authenticated-export';

const props = defineProps<{ format: 'plaintext' | 'encrypted'; mode: 'master-password' | 'device-key' | 'unknown'; helloAvailable: boolean; count: number; recoveryId?: string }>();
const emit = defineEmits<{ close: []; exported: [value: VaultExportResult] }>();
const password = ref(''), backupPassword = ref(''), confirmation = ref(''), error = ref(''), busy = ref(false);
let active = true;
function close() { active = false; password.value = backupPassword.value = confirmation.value = ''; emit('close'); }
onBeforeUnmount(() => { active = false; password.value = backupPassword.value = confirmation.value = ''; });
async function submit() {
  if (busy.value) return;
  error.value = '';
  if (props.mode === 'device-key' && !props.helloAvailable) return;
  if (props.format === 'encrypted' && backupPassword.value !== confirmation.value) { error.value = tr('两次输入的备份密码不一致。'); return; }
  busy.value = true;
  const input = { format: props.format, masterPassword: password.value, backupPassword: props.format === 'encrypted' ? backupPassword.value : undefined, recoveryId: props.recoveryId, confirmed: true as const };
  password.value = backupPassword.value = confirmation.value = '';
  try {
    const result = await vaultClient.authenticatedExport(input);
    if (active) { emit('exported', result); close(); }
  } catch (cause) { if (active) error.value = cause instanceof Error ? cause.message : tr('导出失败，请重试。'); }
  finally { input.masterPassword = ''; input.backupPassword = undefined; busy.value = false; }
}
</script>

<template>
  <div class="modal-backdrop" role="presentation" @mousedown.self="close">
    <section class="editor-dialog backup-password-dialog" role="dialog" aria-modal="true" aria-labelledby="authenticated-export-title">
      <header><div><h2 id="authenticated-export-title">{{ tr(format === 'plaintext' ? '导出明文 JSON' : '导出加密整库备份') }}</h2><p>{{ tr('每次导出都需要重新验证身份。') }}</p></div><m3e-icon-button :aria-label="tr('关闭')" @click="close"><m3e-icon name="close" /></m3e-icon-button></header>
      <form class="editor-form" @submit.prevent="submit">
        <p v-if="format === 'plaintext'" class="settings-safety-note">{{ tr('导出全部 {0} 个未归档项目，包含密码等敏感信息；不含回收站、附件文件与连接配置。', {0: count}) }}</p>
        <p v-else class="supporting">{{ recoveryId ? tr('导出选中的历史恢复副本。不会替换当前库，也不会撤回远端已完成的修改。') : tr('完整备份包含项目、连接配置与本地附件。独立备份密码用于恢复，与当前主密码互不影响。') }}</p>
        <SettingsPasswordField v-if="mode === 'master-password'" v-model="password" :label="tr('当前主密码')" autocomplete="current-password" />
        <p v-else-if="helloAvailable" class="supporting">{{ tr('继续后，Windows Hello 将验证你的身份。') }}</p>
        <p v-else class="form-error" role="alert">{{ tr('请先在解锁与保护中设置主密码或注册 Windows Hello，再验证导出。') }}</p>
        <template v-if="format === 'encrypted'">
          <SettingsPasswordField v-model="backupPassword" :label="tr('备份密码 *')" :minlength="MIN_MASTER_PASSWORD_LENGTH" autocomplete="new-password" />
          <SettingsPasswordField v-model="confirmation" :label="tr('确认备份密码 *')" :minlength="MIN_MASTER_PASSWORD_LENGTH" autocomplete="new-password" />
        </template>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <footer><m3e-button variant="text" type="button" @click="close">{{ tr('取消') }}</m3e-button><m3e-button variant="filled" type="submit" :disabled="busy || mode === 'unknown' || mode === 'device-key' && !helloAvailable || mode === 'master-password' && !password || format === 'encrypted' && (!backupPassword || !confirmation)">{{ busy ? tr('正在验证…') : tr('验证并导出') }}</m3e-button></footer>
      </form>
    </section>
  </div>
</template>
