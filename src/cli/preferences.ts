import { onBeforeUnmount, onMounted, ref } from 'vue';

/** Device-local UI opt-in; not part of a portable vault or provider. */
export const CLI_INTEGRATION_ENABLED_KEY = 'monica.cli.integration.enabled';

export function useCliIntegrationPreference() {
  const enabled = ref(false), ready = ref(false), saving = ref(false), error = ref(false);
  let revision = 0, disposed = false;
  function changed(changes: Record<string, chrome.storage.StorageChange>, area: string) {
    if (area !== 'local' || !changes[CLI_INTEGRATION_ENABLED_KEY]) return;
    revision++;
    enabled.value = changes[CLI_INTEGRATION_ENABLED_KEY].newValue === true;
  }
  onMounted(async () => {
    chrome.storage.onChanged.addListener(changed);
    const current = revision;
    try {
      const stored = await chrome.storage.local.get(CLI_INTEGRATION_ENABLED_KEY);
      if (disposed) return;
      if (current === revision) enabled.value = stored[CLI_INTEGRATION_ENABLED_KEY] === true;
      ready.value = true;
    } catch { if (!disposed) error.value = true; }
  });
  onBeforeUnmount(() => {
    disposed = true;
    chrome.storage.onChanged.removeListener(changed);
  });
  async function toggle() {
    if (!ready.value || saving.value) return;
    const next = !enabled.value;
    saving.value = true;
    error.value = false;
    try {
      await chrome.storage.local.set({ [CLI_INTEGRATION_ENABLED_KEY]: next });
      if (!disposed) enabled.value = next;
    } catch { if (!disposed) error.value = true; }
    finally { if (!disposed) saving.value = false; }
  }
  return { enabled, ready, saving, error, toggle };
}
