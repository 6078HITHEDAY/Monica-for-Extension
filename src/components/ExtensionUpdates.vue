<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue';
import { tr } from '../i18n';
import { runtimeInfo } from '../runtime/version';
import { checkGitHubUpdate, GITHUB_RELEASES_URL, GitHubUpdateError, type GitHubUpdateResult, type UpdateFailure } from '../runtime/github-update';
import GroupedSettingsList from './GroupedSettingsList.vue';

const busy = ref(false), failure = ref<UpdateFailure>();
const result = shallowRef<GitHubUpdateResult>();
let request: AbortController | undefined;
const status = computed(() => {
  if (busy.value) return tr('正在检查 GitHub 更新…');
  if (failure.value === 'rate-limit') return tr('GitHub 请求过于频繁，请稍后重试。');
  if (failure.value === 'timeout') return tr('检查更新超时，请稍后重试。');
  if (failure.value === 'invalid') return tr('无法识别 GitHub 发布信息，请打开发布页查看。');
  if (failure.value) return tr('无法连接 GitHub，请检查网络后重试。');
  if (result.value?.kind === 'available') return tr('发现新版本 {0}', { 0: result.value.version });
  if (result.value?.kind === 'current') return tr('未发现更新（GitHub 最新发布 {0}）。', { 0: result.value.version });
  if (result.value?.kind === 'none') return tr('GitHub 暂无正式发布版本。');
  return tr('点击检查 GitHub 正式发布');
});
async function check() {
  if (busy.value) return;
  const current = request = new AbortController();
  busy.value = true; failure.value = undefined; result.value = undefined;
  try {
    const response = await checkGitHubUpdate(runtimeInfo.version, current.signal);
    if (!current.signal.aborted) result.value = response;
  } catch (error) {
    if (!current.signal.aborted) failure.value = error instanceof GitHubUpdateError ? error.code : 'network';
  } finally { if (!current.signal.aborted) busy.value = false; }
}
onBeforeUnmount(() => request?.abort());
</script>

<template>
  <section class="settings-content extension-updates" aria-labelledby="extension-update-title" data-extension-updates>
    <h2 id="extension-update-title">{{ tr('Monica 浏览器扩展') }}</h2>
    <GroupedSettingsList>
      <div class="update-version"><m3e-icon name="info" aria-hidden="true" /><div><strong>{{ tr('当前版本 {0}', {0: runtimeInfo.version}) }}</strong><small>Monica-Pass / Monica-for-Extension</small></div></div>
      <div class="update-status" :class="{'update-available': result?.kind === 'available', 'update-failed': failure}" role="status" aria-live="polite" aria-atomic="true" :aria-busy="busy"><m3e-icon :name="result?.kind === 'available' ? 'download' : failure ? 'error' : 'info'" aria-hidden="true" /><p>{{ status }}</p></div>
    </GroupedSettingsList>
    <div class="update-actions">
      <m3e-button variant="filled" :disabled="busy" @click="check">{{ busy ? tr('正在检查…') : tr('检查更新') }}</m3e-button>
      <a :href="result?.kind === 'available' ? result.url : GITHUB_RELEASES_URL" target="_blank" rel="noopener noreferrer">{{ result?.kind === 'available' ? tr('查看新版本') : tr('打开 GitHub 发布页') }}<m3e-icon name="open_in_new" aria-hidden="true" /></a>
    </div>
    <p class="supporting">{{ tr('仅在点击时检查正式发布版本，不会上传密码库内容。更新需从 GitHub 下载后手动安装。') }}</p>
  </section>
</template>

<style scoped>
.update-version, .update-status { display: flex; align-items: center; gap: 16px; min-height: 72px; }
.update-version > m3e-icon, .update-status > m3e-icon { flex: 0 0 24px; color: var(--md-sys-color-primary); }
.update-version > div { min-width: 0; display: grid; gap: 4px; }
.update-version small { color: var(--md-sys-color-on-surface-variant); overflow-wrap: anywhere; }
.update-status p { margin: 0; line-height: 1.5; overflow-wrap: anywhere; }
.extension-updates .update-status.update-available { background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); }
.update-failed > m3e-icon { color: var(--md-sys-color-error); }
.update-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px 20px; }
.update-actions a { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; max-width: 100%; color: var(--md-sys-color-primary); text-underline-offset: 4px; overflow-wrap: anywhere; }
.update-actions a m3e-icon { flex-shrink: 0; --m3e-icon-size: 18px; }
.update-actions a:focus-visible { outline: 2px solid var(--md-sys-color-primary); outline-offset: 4px; border-radius: 4px; }
@media (max-width: 480px) { .update-actions { align-items: stretch; flex-direction: column; } }
</style>
