<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { tr } from '../i18n';
import GroupedSettingsList from './GroupedSettingsList.vue';

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
        <GroupedSettingsList>
          <slot :name="`home-${group.id}`" />
      <button v-for="entry in entries.filter(item => item.group === group.id)" :key="entry.id" class="settings-nav-entry" type="button" :disabled="busy" :data-settings-entry="entry.id" @click="open(entry.id)">
        <span class="settings-nav-icon"><m3e-icon :name="entry.icon" aria-hidden="true" /></span>
        <span class="settings-nav-copy"><strong>{{ entry.title }}</strong><small>{{ entry.description }}</small></span>
        <m3e-icon class="settings-nav-chevron" name="chevron_right" aria-hidden="true" />
      </button>
        </GroupedSettingsList>
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
  .settings-detail > :deep(*) { padding: 16px; }
  .settings-detail :deep(.settings-content > m3e-button) { width: 100%; justify-self: stretch; }
}
</style>
