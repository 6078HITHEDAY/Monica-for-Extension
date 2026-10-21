<script setup lang="ts">
import { tr } from '../i18n';

defineProps<{ count: number; peerName?: string; busy: boolean }>();
const emit = defineEmits<{ choose: [choice: 'omit' | 'include']; cancel: [] }>();
</script>

<template>
  <m3e-dialog v-material-dialog open class="material-dialog deletion-review-dialog" :close-label="tr('取消同步')" @closed.self="emit('cancel')">
    <h2 slot="header">{{ tr('发现历史删除记录') }}</h2>
    <div class="deletion-review" data-nearby-deletion-review>
      <p>{{ tr('待发送内容中有 {0} 条历史删除记录。尚未开始传输，请选择本次如何处理。', { 0: count }) }}</p>
      <p v-if="peerName">{{ tr('发送到：{0}', { 0: peerName }) }}</p>
      <p>{{ tr('跳过删除可保留另一端的内容；包含删除可能将另一端对应的密码或验证码移入回收站。此选择仅对本次同步有效。') }}</p>
    </div>
    <div slot="actions" class="deletion-review-actions">
      <m3e-button variant="filled" :disabled="busy" @click="emit('choose', 'omit')">{{ tr('跳过删除，继续同步') }}</m3e-button>
      <m3e-button variant="tonal" :disabled="busy" @click="emit('choose', 'include')">{{ tr('本次包含删除') }}</m3e-button>
      <m3e-button variant="text" :disabled="busy" @click="emit('cancel')">{{ tr('取消同步') }}</m3e-button>
    </div>
  </m3e-dialog>
</template>

<style scoped>
.deletion-review-dialog{--m3e-dialog-max-width:480px;}.deletion-review{display:grid;gap:12px;}.deletion-review p{margin:0;line-height:1.5;overflow-wrap:anywhere;}.deletion-review-actions{display:grid;gap:8px;width:100%;}.deletion-review-actions m3e-button{width:100%;}
</style>
