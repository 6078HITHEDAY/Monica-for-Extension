<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { tr } from '../i18n';
defineProps<{ count: number; busy: boolean; allOnPage: boolean; inert?: boolean }>();
const emit = defineEmits<{ page: []; exit: []; favorite: []; unfavorite: []; transfer: []; trash: [] }>();
const clearance = ref<HTMLElement>();
const selectionSurface = ref<HTMLElement>();
const layout = reactive({ height: 0, center: 0, width: 0 });
let observer: ResizeObserver | undefined;
function measure() {
  if (!clearance.value || !selectionSurface.value) return;
  const bounds = clearance.value.getBoundingClientRect();
  layout.center = bounds.left + bounds.width / 2;
  layout.width = bounds.width;
  layout.height = Math.ceil(selectionSurface.value.getBoundingClientRect().height);
}
onMounted(() => {
  observer = new ResizeObserver(measure);
  observer.observe(clearance.value!);
  observer.observe(selectionSurface.value!);
  window.addEventListener('resize', measure);
  measure();
});
onBeforeUnmount(() => {
  observer?.disconnect();
  window.removeEventListener('resize', measure);
});
</script>

<template>
  <div ref="clearance" class="item-selection-clearance" :style="{ height: `${layout.height + 32}px` }" aria-hidden="true" data-item-selection-clearance />
  <!-- Keep the fixed surface outside the manager's size-containment boundary,
       while retaining the selected theme and reserving space after the list. -->
  <Teleport to=".shell">
  <section ref="selectionSurface" class="item-selection-toolbar" :style="{ left: `${layout.center}px`, width: `${layout.width}px` }" role="region" :aria-label="tr('批量操作')" :aria-busy="busy" :inert="inert" data-item-selection-toolbar>
    <div class="item-selection-heading"><strong role="status">{{ tr('已选择 {0} 个项目', { 0: count }) }}</strong><m3e-button variant="text" :disabled="busy" @click="emit('exit')">{{ tr('退出多选') }}</m3e-button></div>
    <div class="item-selection-actions">
      <m3e-button variant="tonal" :disabled="busy" @click="emit('page')">{{ allOnPage ? tr('取消选择当前页') : tr('全选当前页') }}</m3e-button>
      <m3e-button variant="text" :disabled="busy || !count" @click="emit('favorite')"><m3e-icon slot="icon" name="star" />{{ tr('收藏') }}</m3e-button>
      <m3e-button variant="text" :disabled="busy || !count" @click="emit('unfavorite')">{{ tr('取消收藏') }}</m3e-button>
      <m3e-button variant="text" :disabled="busy || !count" @click="emit('transfer')"><m3e-icon slot="icon" name="drive_file_move" />{{ tr('批量传输') }}</m3e-button>
      <m3e-button variant="text" :disabled="busy || !count" @click="emit('trash')"><m3e-icon slot="icon" name="delete" />{{ tr('移到回收站') }}</m3e-button>
    </div>
  </section>
  </Teleport>
</template>
