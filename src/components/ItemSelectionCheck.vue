<script setup lang="ts">
import { tr } from '../i18n';
defineProps<{ title: string; selected: boolean; disabled?: boolean }>();
</script>

<template>
  <button class="item-selection-check" type="button" role="checkbox" :aria-checked="selected" :aria-label="tr('选择 {0}', { 0: title })" :disabled="disabled">
    <m3e-icon :name="selected ? 'check_box' : 'check_box_outline_blank'" aria-hidden="true" />
  </button>
</template>
