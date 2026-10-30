<script setup lang="ts">
import { tr } from '../i18n';
import { materialSelectTag, materialOptionTag } from '../lib/material-controls';
import { schemePreference, setScheme } from '../lib/theme';
function change(event: Event) {
  const value = (event.target as HTMLElement & {value: string}).value;
  if (value === 'auto' || value === 'light' || value === 'dark') setScheme(value);
}
</script>

<template>
  <m3e-form-field v-field-label variant="filled" hide-required-marker hide-subscript="always" data-settings-select class="display-mode-picker">
    <label slot="label">{{ tr('显示模式') }}</label>
    <component :is="materialSelectTag" :aria-label="tr('显示模式')" @change="change">
      <component :is="materialOptionTag" value="auto" :selected.prop="schemePreference === 'auto'">{{ tr('跟随系统') }}</component>
      <component :is="materialOptionTag" value="light" :selected.prop="schemePreference === 'light'">{{ tr('浅色') }}</component>
      <component :is="materialOptionTag" value="dark" :selected.prop="schemePreference === 'dark'">{{ tr('深色') }}</component>
    </component>
  </m3e-form-field>
</template>
