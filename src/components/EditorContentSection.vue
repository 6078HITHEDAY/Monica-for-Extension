<script setup lang="ts">
import { nextTick, ref, useSlots } from 'vue';
import { tr } from '../i18n';

defineProps<{ title: string; icon: string; summary?: string; disabled?: boolean; actionLabel?: string }>();
const emit = defineEmits<{ activate: [] }>();
const open = defineModel<boolean>('open', { default: false });
const slots = useSlots();
const opener = ref<HTMLButtonElement>();
function activate() {
  if (slots.default) open.value = true;
  else emit('activate');
}
async function close() {
  open.value = false;
  await nextTick();
  opener.value?.focus();
}
function containKey(event: KeyboardEvent) {
  event.stopPropagation();
  // Editing a section must not implicitly save the outer password form.
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement && !event.isComposing) event.preventDefault();
}
</script>

<template>
  <section class="editor-content-section" :data-content-section="title">
    <div class="editor-content-row">
      <button ref="opener" type="button" data-content-open class="editor-content-open" :aria-label="actionLabel || title" :disabled="disabled" @click="activate">
        <span class="editor-content-icon"><m3e-icon :name="icon" /></span>
        <span class="editor-content-label"><strong>{{ title }}</strong><small>{{ summary || tr('可选') }}</small></span>
        <m3e-icon name="chevron_right" />
      </button>
      <div v-if="slots.actions" class="editor-content-actions"><slot name="actions" /></div>
    </div>
    <m3e-dialog v-if="open" v-material-dialog open dismissible class="material-dialog material-editor-dialog editor-content-dialog" :close-label="tr('返回')" @keydown="containKey" @closed.self="close">
      <h2 slot="header">{{ title }}</h2>
      <div class="editor-fields structured-editor editor-content-fields"><slot /></div>
      <footer slot="actions" end><m3e-button type="button" variant="filled" @click="close">{{ tr('完成') }}</m3e-button></footer>
    </m3e-dialog>
  </section>
</template>

<style scoped>
.editor-content-section { min-width: 0; }
.editor-content-row { display: flex; align-items: center; min-width: 0; border-radius: 24px; background: var(--md-sys-color-surface-container); }
.editor-content-open { display: flex; align-items: center; gap: 14px; flex: 1; width: 100%; min-width: 0; min-height: 80px; padding: 16px; border: 0; border-radius: inherit; font: inherit; color: var(--app-text); background: transparent; text-align: start; cursor: pointer; }
.editor-content-open:hover { background: color-mix(in srgb, var(--md-sys-color-primary) 6%, transparent); }
.editor-content-open:focus-visible { outline: 2px solid var(--md-sys-color-primary); outline-offset: -3px; }
.editor-content-icon { display: grid; place-items: center; flex: 0 0 40px; height: 40px; border-radius: 50%; color: var(--md-sys-color-primary); background: var(--md-sys-color-surface-container-high); }
.editor-content-label { display: grid; gap: 4px; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.editor-content-label strong { font-size: .9375rem; font-weight: 500; }
.editor-content-label small { color: var(--app-muted); font-size: .8125rem; line-height: 1.5; }
.editor-content-open > m3e-icon { flex: none; color: var(--app-muted); }
.editor-content-actions { flex: none; padding-inline-end: 8px; }
@media (max-width: 420px) { .editor-content-open { gap: 10px; padding: 14px 12px; } }
</style>
