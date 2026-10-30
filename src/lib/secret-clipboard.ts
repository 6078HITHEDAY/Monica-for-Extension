import { CLIPBOARD_PREFERENCES_KEY, clipboardDigest, clipboardPreferences } from '../security/clipboard-lifecycle';

/** Foreground write keeps normal clipboard behaviour when expiry is off. No secret enters runtime messages. */
export async function writeSecretClipboard(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
  try {
    const settings = await chrome.storage.local.get(CLIPBOARD_PREFERENCES_KEY);
    if (!clipboardPreferences(settings[CLIPBOARD_PREFERENCES_KEY]).enabled) return;
    const digest = await clipboardDigest(value);
    await chrome.runtime.sendMessage({ type: 'CLIPBOARD_ARM', digest });
  } catch { /* Copy succeeded. Optional cleanup is best effort and never retries a secret write. */ }
}
