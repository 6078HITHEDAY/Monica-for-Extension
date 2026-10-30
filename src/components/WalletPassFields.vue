<script setup lang="ts">
import { computed } from 'vue';
import { tr } from '../i18n';
import { WALLET_PASS_FIELD_LABELS, WALLET_TEMPLATE_FIELDS } from '../core/wallet-pass';
const props = defineProps<{ template: string; modelValue: Record<string, string> }>();
const emit = defineEmits<{ 'update:modelValue': [value: Record<string, string>] }>();
const known = computed(() => WALLET_TEMPLATE_FIELDS[props.template] ?? []);
const extra = computed(() => Object.keys(props.modelValue).filter(key => !known.value.includes(key)));
function update(key: string, value: string) {
  const next = { ...props.modelValue };
  if (value === '') delete next[key]; else next[key] = value;
  emit('update:modelValue', next);
}
</script>
<template>
  <div class="wallet-pass-grid" data-wallet-pass-fields>
    <m3e-form-field v-for="key in known" :key="key" v-field-label variant="filled" hide-subscript="always" hide-required-marker class="field">
      <label slot="label">{{ tr(WALLET_PASS_FIELD_LABELS[key]) }}</label>
      <input :value="modelValue[key] ?? ''" autocomplete="off" @input="update(key, ($event.target as HTMLInputElement).value)" />
    </m3e-form-field>
    <m3e-form-field v-for="key in extra" :key="key" v-field-label variant="filled" hide-subscript="always" hide-required-marker class="field">
      <label slot="label">{{ key }}</label><input :value="modelValue[key]" readonly />
    </m3e-form-field>
  </div>
</template>
<style scoped>
.wallet-pass-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; margin-top: 12px; }
.wallet-pass-grid m3e-form-field { width: 100%; min-width: 0; --m3e-form-field-container-shape: 4px; }
.wallet-pass-grid m3e-form-field:first-child { --m3e-form-field-container-shape: 24px 24px 4px 4px; }
.wallet-pass-grid m3e-form-field:last-child { --m3e-form-field-container-shape: 4px 4px 24px 24px; }
.wallet-pass-grid m3e-form-field:only-child { --m3e-form-field-container-shape: 24px; }
</style>
