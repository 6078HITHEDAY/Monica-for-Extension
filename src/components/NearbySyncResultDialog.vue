<script setup lang="ts">
import { tr } from '../i18n';
import type { NearbySyncResult } from '../nearby/local-coordinator';
import type { NearbySyncMode } from '../nearby/preferences';
defineProps<{ result: NearbySyncResult; peerName?: string; mode?: NearbySyncMode }>();
const emit=defineEmits<{close:[]}>();
const labels:Record<string,string>={login:'登录项','ssh-key':'SSH 密钥',totp:'动态验证码',note:'安全笔记',card:'银行卡',identity:'身份','billing-address':'地址','payment-account':'支付账户',passkey:'Passkey','api-token':'API 密钥','steam-mafile':'Steam',folder:'文件夹','vault-metadata':'密码库信息','document-ref':'附件',unknown:'其他项目'};
</script>

<template>
  <m3e-dialog v-material-dialog open class="material-dialog nearby-result-dialog" :close-label="tr('关闭')" @closed.self="emit('close')">
    <h2 slot="header">{{ tr('同步结果') }}</h2>
    <div class="nearby-result" data-nearby-result>
      <p><strong>{{ tr('同步完成') }}</strong><span v-if="peerName"> · {{ peerName }}</span></p>
      <p>{{ tr('双方已确认保存。') }}</p>
      <p>{{ tr(result.sent ? '发送已由对方确认。' : '本次未发送内容。') }}</p>
      <p v-if="mode === 'receive_only'">{{ tr('当前为「仅接收」：本机的修改和删除不会发送。要同步这些更改，请改用「双向同步」或「仅发送」，并让另一端允许接收。') }}</p>
      <p v-else-if="mode === 'send_only'">{{ tr('当前为「仅发送」：本机内容会发送，但不会接收另一端的更改。') }}</p>
      <p>{{ tr('本机处理 {0} 项：保存 {1} 项，删除 {2} 项。',{0:result.processed,1:result.processed-result.deleted,2:result.deleted}) }}</p>
      <p v-if="!result.processed">{{ tr('本机没有需要写入的更新。') }}</p>
      <ul v-else>
        <li v-for="(item,index) in result.items" :key="index"><strong>{{ item.title || tr(item.deleted ? '已删除项目' : '未命名项目') }}</strong><small>{{ tr(labels[item.type]) }} · {{ tr(item.deleted ? '删除' : '保存') }}</small></li>
      </ul>
      <p v-if="result.processed>result.items.length">{{ tr('仅展示前 {0} 项。',{0:result.items.length}) }}</p>
    </div>
    <m3e-button slot="actions" variant="filled" @click="emit('close')">{{ tr('知道了') }}</m3e-button>
  </m3e-dialog>
</template>

<style scoped>
.nearby-result-dialog{--m3e-dialog-max-width:520px;}.nearby-result{display:grid;gap:12px;min-width:0;}.nearby-result p{margin:0;line-height:1.5;}.nearby-result ul{display:grid;gap:4px;list-style:none;padding:0;margin:0;max-height:45dvh;overflow:auto;}.nearby-result li{padding:10px 14px;background:var(--md-sys-color-surface-container-high);border-radius:4px;overflow-wrap:anywhere;}.nearby-result li:first-child{border-top-left-radius:20px;border-top-right-radius:20px;}.nearby-result li:last-child{border-bottom-left-radius:20px;border-bottom-right-radius:20px;}.nearby-result small{display:block;color:var(--md-sys-color-on-surface-variant);margin-top:4px;}
</style>
