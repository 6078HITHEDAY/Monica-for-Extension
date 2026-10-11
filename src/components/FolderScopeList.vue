<script setup lang="ts">
import {tr} from '../i18n';
defineProps<{modelValue:string; folders:Array<{key:string;label:string;sourceId:string;count:number}>;sourceNames:Record<string,string>;showSource:boolean}>();
defineEmits<{'update:modelValue':[value:string]}>();
</script>
<template>
  <div class="folder-scope-list" role="group" :aria-label="tr('文件夹')">
    <button type="button" :aria-pressed="modelValue==='all'" @click="$emit('update:modelValue','all')"><m3e-icon name="list"/><span>{{tr('全部文件夹')}}</span><m3e-icon v-if="modelValue==='all'" name="check"/></button>
    <button type="button" :aria-pressed="modelValue==='uncategorized'" @click="$emit('update:modelValue','uncategorized')"><m3e-icon name="folder_off"/><span>{{tr('未分类')}}</span><m3e-icon v-if="modelValue==='uncategorized'" name="check"/></button>
    <button v-for="folder in folders" :key="folder.key" type="button" :data-folder-key="folder.key" :aria-pressed="modelValue===folder.key" @click="$emit('update:modelValue',folder.key)">
      <m3e-icon name="folder"/><span>{{folder.label || tr('文件夹')}}<small v-if="showSource">{{sourceNames[folder.sourceId] || folder.sourceId}}</small></span><small>{{folder.count}}</small><m3e-icon v-if="modelValue===folder.key" name="check"/>
    </button>
  </div>
</template>
<style scoped>
.folder-scope-list{display:grid;gap:4px;min-width:0}
button{border:0;border-radius:4px;background:var(--md-sys-color-surface-container);color:var(--md-sys-color-on-surface);padding:12px 16px;display:flex;align-items:center;gap:12px;min-height:56px;text-align:start;font:inherit;cursor:pointer}
button:first-child{border-radius:24px 24px 4px 4px}button:last-child{border-radius:4px 4px 24px 24px}
button[aria-pressed=true]{background:var(--md-sys-color-secondary-container);color:var(--md-sys-color-on-secondary-container)}
button:focus-visible{outline:2px solid var(--md-sys-color-primary);outline-offset:2px}
button span{flex:1;min-width:0;overflow-wrap:anywhere}small{font-size:12px}span small{display:block;margin-top:4px}m3e-icon{flex:none}
</style>
