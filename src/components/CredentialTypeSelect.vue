<script setup lang="ts">
import { materialSelectTag, materialOptionTag } from '../lib/material-controls';
import { CREDENTIAL_CREATE_TYPES, credentialCreateOptions, type CredentialCreateType } from '../manager/editor-types';
import { tr } from '../i18n';
defineProps<{ value: string; disabled?: boolean }>();
const emit = defineEmits<{ select: [value: CredentialCreateType] }>();
function select(event: Event) {
  const value = (event.target as HTMLElement & { value: CredentialCreateType }).value;
  if (CREDENTIAL_CREATE_TYPES.includes(value)) emit('select', value);
}
</script>
<template>
  <m3e-form-field v-field-label variant="filled" hide-required-marker class="field">
    <label slot="label">{{ tr('项目类型') }}</label>
    <component :is="materialSelectTag" :disabled.prop="disabled" @input="select">
      <component :is="materialOptionTag" v-for="option in credentialCreateOptions()" :key="option.value" :value="option.value" :selected.prop="value === option.value">{{ option.label }}</component>
    </component>
  </m3e-form-field>
</template>
