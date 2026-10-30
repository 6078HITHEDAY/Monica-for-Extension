<script setup lang="ts">
import { useId } from 'vue';

defineProps<{ label: string; autocomplete: string; minlength?: number; hint?: string }>();
const value = defineModel<string>({ required: true });
const id = useId();
</script>

<template>
  <div class="settings-password-field">
    <label :for="id">{{ label }}</label>
    <m3e-form-field variant="filled" hide-required-marker hide-subscript="always">
      <input :id="id" v-model="value" type="password" :autocomplete="autocomplete" :minlength="minlength" :aria-describedby="hint ? `${id}-hint` : undefined" />
    </m3e-form-field>
    <small v-if="hint" :id="`${id}-hint`">{{ hint }}</small>
  </div>
</template>

<style scoped>
.settings-password-field { display: grid; gap: 8px; min-width: 0; }
label, small { overflow-wrap: anywhere; line-height: 1.5; color: var(--md-sys-color-on-surface-variant); }
label { font-size: .875rem; }
small { font-size: .8125rem; }
</style>
