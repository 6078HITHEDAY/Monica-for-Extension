<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { tr } from '../i18n';

export interface SettingsEntry { id: string; group: string; title: string; description: string; icon: string }
const props = defineProps<{ modelValue: string; entries: SettingsEntry[]; groups: {id: string; title: string}[]; busy?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [page: string] }>();
const root = ref<HTMLElement>();
const heading = ref<HTMLElement>();
const selected = computed(() => props.entries.find(entry => entry.id === props.modelValue));
let homeScroll = 0;
function open(id: string) {
  if (props.busy) return;
  if (!selected.value) homeScroll = window.scrollY;
  emit('update:modelValue', id);
}
watch(() => props.modelValue, async (page, previous) => {
  await nextTick();
  if (page === 'home') {
    root.value?.querySelector<HTMLElement>(`[data-settings-entry="${previous}"]`)?.focus({preventScroll: true});
    window.scrollTo({top: homeScroll, behavior: 'instant'});
  } else {
    window.scrollTo({top: 0, behavior: 'instant'});
    heading.value?.focus({preventScroll: true});
  }
});
</script>

<template>
  <section ref="root" class="settings-page settings-navigation" :data-settings-page="modelValue" aria-labelledby="settings-page-heading">
    <header class="settings-page-header">
      <m3e-icon-button v-if="selected" :aria-label="tr('返回')" :disabled="busy" data-settings-back @click="open('home')"><m3e-icon name="arrow_back" /></m3e-icon-button>
      <div><h1 id="settings-page-heading" ref="heading" tabindex="-1">{{ selected?.title || tr('设置与备份') }}</h1><p v-if="selected">{{ selected.description }}</p></div>
    </header>
    <div v-if="!selected" class="settings-home">
      <section v-for="group in groups" :key="group.id" class="settings-group" :aria-labelledby="`settings-group-${group.id}`">
        <h2 :id="`settings-group-${group.id}`">{{ group.title }}</h2>
        <div class="settings-entry-list">
          <slot :name="`home-${group.id}`" />
      <button v-for="entry in entries.filter(item => item.group === group.id)" :key="entry.id" class="settings-nav-entry" type="button" :disabled="busy" :data-settings-entry="entry.id" @click="open(entry.id)">
        <span class="settings-nav-icon"><m3e-icon :name="entry.icon" aria-hidden="true" /></span>
        <span class="settings-nav-copy"><strong>{{ entry.title }}</strong><small>{{ entry.description }}</small></span>
        <m3e-icon class="settings-nav-chevron" name="chevron_right" aria-hidden="true" />
      </button>
        </div>
      </section>
    </div>
    <div v-else :key="selected.id" class="settings-detail"><slot :name="selected.id" /></div>
  </section>
</template>

<style scoped>
.settings-navigation { width: 100%; max-width: 900px; min-width: 0; padding-bottom: 24px; }
.settings-page-header { display: flex; align-items: flex-start; gap: 12px; padding: 8px 0 16px; }
.settings-page-header > div { min-width: 0; }
.settings-page-header h1 { margin: 0; font-size: 1.75rem; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; outline: none; }
.settings-page-header p { margin: 6px 0 0; color: var(--md-sys-color-on-surface-variant); line-height: 1.5; font-size: .875rem; overflow-wrap: anywhere; }
.settings-page-header m3e-icon-button { flex: 0 0 auto; }
.settings-home { display: grid; gap: 20px; }
.settings-group { min-width: 0; }
.settings-group h2 { margin: 0 16px 8px; font-size: .875rem; font-weight: 600; color: var(--md-sys-color-on-surface-variant); }
.settings-entry-list { display: grid; gap: 4px; }
.settings-entry-list > :deep(*) { min-width: 0; margin: 0; padding: 8px 16px; box-sizing: border-box; border-radius: 4px; color: var(--md-sys-color-on-surface); background: var(--md-sys-color-surface-container-low); }
.settings-entry-list > :deep(:first-child) { border-top-left-radius: 24px; border-top-right-radius: 24px; }
.settings-entry-list > :deep(:last-child) { border-bottom-left-radius: 24px; border-bottom-right-radius: 24px; }
.settings-nav-entry { display: grid; grid-template-columns: 40px minmax(0, 1fr) 24px; align-items: center; gap: 16px; width: 100%; min-height: 72px; border: 0; font: inherit; text-align: start; cursor: pointer; }
.settings-nav-entry:disabled { cursor: default; opacity: .6; }
.settings-entry-list :deep(.settings-control) { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 16px; align-items: center; }
.settings-entry-list :deep(.settings-control > :last-child) { min-width: 0; width: 100%; }
.settings-entry-list :deep(.settings-control-icon) { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container); }
.settings-entry-list :deep(.settings-control m3e-form-field) { --m3e-form-field-container-color: transparent; }
.settings-entry-list :deep(.settings-control:has([data-settings-select]):hover),
.settings-entry-list :deep(.settings-control:has([data-settings-select] [aria-expanded="true"])) { background: var(--md-sys-color-surface-container-high); }
/* One keyboard indicator follows the grouped row's corners, never an inner
   pill. Scope the reset to the select so menu options keep their own focus. */
.settings-entry-list :deep(.settings-control [data-settings-select] :is(m3e-select, select)) { --m3e-focus-ring-visibility: hidden; outline: none; }
.settings-entry-list :deep(.settings-control:has([data-settings-select]:not([data-pointer-focus]) :focus-visible)) { outline: 2px solid var(--md-sys-color-primary); outline-offset: -2px; }
@media (forced-colors: active) {
  .settings-entry-list :deep(.settings-control:has([data-settings-select]:not([data-pointer-focus]) :focus-visible)) { outline-color: Highlight; }
}
.settings-nav-entry:hover { background: var(--md-sys-color-surface-container-high); }
.settings-nav-entry:active { background: var(--md-sys-color-secondary-container); }
.settings-nav-entry:focus-visible { outline: 3px solid var(--md-sys-color-primary); outline-offset: 2px; }
.settings-nav-icon { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container); }
.settings-nav-icon m3e-icon, .settings-nav-chevron { --m3e-icon-size: 24px; }
.settings-nav-chevron { color: var(--md-sys-color-on-surface-variant); }
.settings-nav-copy { display: grid; gap: 4px; min-width: 0; }
.settings-nav-copy strong { font-size: 1rem; line-height: 1.4; font-weight: 600; overflow-wrap: anywhere; }
.settings-nav-copy small { font-size: .875rem; line-height: 1.5; color: var(--md-sys-color-on-surface-variant); overflow-wrap: anywhere; }
.settings-detail { display: grid; gap: 16px; min-width: 0; }
.settings-detail > :deep(*) { padding: 24px; background: var(--md-sys-color-surface-container-low); border-radius: 24px; }
.settings-detail :deep(.settings-content) { display: grid; gap: 16px; min-width: 0; }
.settings-detail :deep(h2) { font-size: 1.125rem; margin: 0; font-weight: 600; }
.settings-detail :deep(.settings-safety-note) { margin: 0; line-height: 1.6; color: var(--md-sys-color-on-surface-variant); font-size: .875rem; }
.settings-detail :deep(p) { overflow-wrap: anywhere; }
.settings-detail :deep(.settings-content > p) { margin: 0; }
.settings-detail :deep(.settings-content > m3e-button) { justify-self: start; max-width: 100%; }
@media (max-width: 480px) {
  .settings-page-header h1 { font-size: 1.5rem; }
  .settings-nav-entry { gap: 12px; }
  .settings-detail > :deep(*) { padding: 16px; }
  .settings-entry-list :deep(.settings-control) { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .settings-entry-list :deep(.settings-control-icon) { display: none; }
  .settings-detail :deep(.settings-content > m3e-button) { width: 100%; justify-self: stretch; }
}
</style>
