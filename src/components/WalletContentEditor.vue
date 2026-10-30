<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { tr } from '../i18n';
import { moveWalletContent, resolveWalletContentOrder } from '../core/wallet-content-order';
import EditorContentSection from './EditorContentSection.vue';
const props = defineProps<{ modelValue?: string[]; sections: { key: string; title: string; icon: string }[]; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>();
const root = ref<HTMLElement>(), active = ref<string>();
const keys = computed(() => props.sections.map(section => section.key));
const ordered = computed(() => resolveWalletContentOrder(props.modelValue, keys.value).map(key => props.sections.find(section => section.key === key)!));
const current = computed(() => props.sections.find(section => section.key === active.value));
let opener: HTMLElement | undefined;
function open(key: string) {
  if (props.disabled) return;
  opener = root.value?.querySelector<HTMLElement>(`[data-wallet-section="${key}"] [data-content-open]`) || undefined;
  active.value = key;
}
async function close() { active.value = undefined; await nextTick(); if (opener?.isConnected) opener.focus(); }
function containKey(event: KeyboardEvent) {
  event.stopPropagation();
  // The nested editor lives inside the main form. Enter in one of its text
  // fields must not implicitly submit that form while the section is open.
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement && !event.isComposing) event.preventDefault();
}
async function move(key: string, offset: -1 | 1) {
  if (props.disabled) return;
  const order = moveWalletContent(props.modelValue, keys.value, key, offset);
  if (order) emit('update:modelValue', order);
  await nextTick(); root.value?.querySelector<HTMLElement>(`[data-wallet-section="${key}"] [data-content-open]`)?.focus();
}
</script>
<template>
  <section ref="root" class="wallet-content" :aria-label="tr('补充信息')" data-wallet-content>
    <h3>{{ tr('补充信息') }}</h3>
    <div class="wallet-content-list" role="list">
      <EditorContentSection v-for="(section, index) in ordered" :key="section.key" role="listitem" :data-wallet-section="section.key" :title="tr(section.title)" :icon="section.icon" :disabled="disabled" :action-label="tr('编辑{0}', {0: tr(section.title)})" @activate="open(section.key)">
        <template #actions>
        <div class="wallet-content-move">
          <m3e-icon-button type="button" :disabled="disabled || index === 0" :aria-label="tr('上移{0}', {0: tr(section.title)})" @click="move(section.key, -1)"><m3e-icon name="arrow_upward" /></m3e-icon-button>
          <m3e-icon-button type="button" :disabled="disabled || index === ordered.length - 1" :aria-label="tr('下移{0}', {0: tr(section.title)})" @click="move(section.key, 1)"><m3e-icon name="arrow_downward" /></m3e-icon-button>
        </div>
        </template>
      </EditorContentSection>
    </div>
    <m3e-dialog v-if="current" v-material-dialog open dismissible class="material-dialog material-editor-dialog wallet-content-dialog" :close-label="tr('返回')" @keydown="containKey" @closed.self="close">
      <h2 slot="header">{{ tr(current.title) }}</h2>
      <div class="editor-fields structured-editor wallet-content-fields" :data-wallet-content-editor="current.key"><slot :name="current.key" /></div>
      <footer slot="actions" end><m3e-button type="button" variant="filled" @click="close">{{ tr('完成') }}</m3e-button></footer>
    </m3e-dialog>
  </section>
</template>
<style scoped>
.wallet-content { min-width: 0; }
h3 { margin: 0 0 12px; font-size: 1rem; }
.wallet-content-list { display: grid; gap: 8px; }
.wallet-content-move { display: flex; flex: none; padding-inline-end: 8px; }
.wallet-content-fields { min-width: 0; }
@media (max-width: 420px) { .wallet-content-move { padding-inline-end: 4px; } }
</style>
