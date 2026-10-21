<script setup lang="ts">
import { tr } from '../i18n';
defineProps<{ enabled: boolean; ready: boolean; saving: boolean; error: boolean }>();
defineEmits<{ toggle: [] }>();
</script>

<template>
  <section class="cli-integration-setting" aria-labelledby="cli-integration-label">
    <div class="cli-integration-setting-row">
      <strong id="cli-integration-label">{{ tr('CLI 联动') }} <small class="cli-integration-status">{{ tr('不完善') }}</small></strong>
      <m3e-switch :checked.prop="enabled" :disabled="!ready || saving" :aria-busy="saving" aria-labelledby="cli-integration-label" aria-describedby="cli-integration-description" @beforeinput.prevent="$emit('toggle')" />
      <p id="cli-integration-description">{{ tr('开启后在侧栏显示 CLI 内容管理。') }}</p>
    </div>
    <p v-if="error" class="form-error" role="alert">{{ tr('未能保存 CLI 联动设置，请重试。') }}</p>
  </section>
</template>

<style scoped>
.cli-integration-setting { min-width: 0; }
.cli-integration-setting-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 16px; align-items: center; }
.cli-integration-setting strong { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 1rem; font-weight: 600; overflow-wrap: anywhere; }
.cli-integration-status { padding: 2px 8px; border-radius: 8px; background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); font-size: .75rem; font-weight: 500; }
.cli-integration-setting-row > p { grid-column: 1; grid-row: 2; color: var(--app-muted); }
.cli-integration-setting p { margin: 4px 0 0; font-size: .875rem; line-height: 1.5; overflow-wrap: anywhere; }
.cli-integration-setting m3e-switch:focus-visible { outline: none; }
.cli-integration-setting-row > m3e-switch { grid-column: 2; grid-row: 1 / span 2; align-self: center; }
</style>
