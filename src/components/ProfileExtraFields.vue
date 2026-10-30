<script setup lang="ts">
import { tr } from '../i18n';
import { PROFILE_LABELS } from '../core/profile-fields';
type Field = keyof typeof PROFILE_LABELS;
defineProps<{ values: Record<Field, string>; names: readonly Field[] }>();
const emit = defineEmits<{ edit: [key: Field, value: string] }>();
</script>
<template>
  <m3e-form-field v-for="key in names" :key="key" v-field-label variant="filled" hide-required-marker class="field">
    <label slot="label">{{ tr(PROFILE_LABELS[key]) }}</label>
    <input :value="values[key]" :type="key.endsWith('Email') ? 'email' : key.endsWith('Phone') ? 'tel' : 'text'" autocomplete="off" @input="emit('edit', key, ($event.target as HTMLInputElement).value)" />
  </m3e-form-field>
</template>
