<script setup lang="ts">
import { ref } from 'vue';
import { tr } from '../i18n';
import { vaultClient } from '../runtime/client';
import { runtimeInfo, type RuntimeInfo } from '../runtime/version';
import { diagnosticReport } from '../runtime/diagnostics';
const report=ref(diagnosticReport()), busy=ref(false), checked=ref(false), failed=ref(false);
async function inspect() {
  busy.value=true; failed.value=false;
  try {
    const results=await Promise.allSettled([chrome.runtime.sendMessage({type:'RUNTIME_INFO'}),vaultClient.mdbx2HostStatus(),vaultClient.windowsHelloStatus()]);
    const background=results[0].status==='fulfilled'&&results[0].value?.ok?results[0].value.data as RuntimeInfo:undefined;
    report.value=diagnosticReport(background,results[1].status==='fulfilled'?results[1].value:undefined,results[2].status==='fulfilled'?results[2].value:undefined);
    failed.value=results.some(row=>row.status==='rejected')||!background;checked.value=true;
  } finally {busy.value=false;}
}
function download() {
  const url=URL.createObjectURL(new Blob([JSON.stringify(report.value,null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='monica-runtime-diagnostics.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
</script>
<template>
  <section class="settings-content" aria-labelledby="runtime-diagnostics-title">
    <h2 id="runtime-diagnostics-title">{{ tr('运行诊断') }}</h2>
    <p>{{ tr('扩展版本') }}: {{ runtimeInfo.version }} · {{ tr('构建标识') }}: {{ runtimeInfo.buildId }}</p>
    <p class="supporting">{{ tr('按需检查当前页面、后台、浏览器数据库引擎和系统验证组件。不打开数据库，不读取密码项目。') }}</p>
    <div class="source-actions"><m3e-button variant="filled" :disabled="busy" @click="inspect">{{ busy?tr('正在检查…'):tr('检查运行状态') }}</m3e-button><m3e-button variant="text" :disabled="!checked || busy" @click="download">{{ tr('下载脱敏诊断') }}</m3e-button></div>
    <p v-if="checked" role="status">{{ report.background?.compatible?tr('页面与后台构建一致。'):tr('后台未连接或构建不一致，请在扩展管理页重新加载 Monica，再重新打开页面。') }}</p>
    <p v-if="checked">{{ tr('数据库引擎') }}: {{ report.engine?.availability==='ready'?tr('可用'):tr('未就绪') }} · Windows Hello: {{ report.systemVerifier?.available?tr('可用'):tr('未就绪') }}</p>
    <p v-if="failed" role="alert">{{ tr('部分组件未能完成检查。请先确认本机辅助程序安装状态，再重新检查；不要删除浏览器配置来排错。') }}</p>
    <p class="supporting">{{ tr('加载异常时，先保存独立加密备份；重新加载扩展后再打开 Monica。ZIP 解压加载的目录需要保留在固定位置。') }}</p>
    <p class="supporting">{{ tr('诊断仅包含版本和白名单状态，不含项目、密码、站点、路径、设备标识或服务端地址。') }}</p>
  </section>
</template>
