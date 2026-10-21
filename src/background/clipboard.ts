import { ensureBrowserDocument } from '../providers/mdbx2/browser/runtime';
import { CLIPBOARD_ALARM, CLIPBOARD_CLEAR_MESSAGE, CLIPBOARD_PENDING_KEY, CLIPBOARD_PERMISSIONS, CLIPBOARD_PREFERENCES_KEY, clipboardPreferences, validClipboardExpiry } from '../security/clipboard-lifecycle';

/** Persist only a hash and deadline so browser-worker suspension retains no clipboard plaintext. */
export class ClipboardLifecycle {
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly browser = chrome, private readonly now = Date.now) {}
  private run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work); this.queue = next.catch(() => undefined); return next;
  }
  async arm(digest: string): Promise<void> {
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid clipboard digest');
    return this.run(async () => {
      const stored = await this.browser.storage.local.get(CLIPBOARD_PREFERENCES_KEY);
      const preferences = clipboardPreferences(stored[CLIPBOARD_PREFERENCES_KEY]);
      if (!preferences.enabled || !await this.browser.permissions.contains({ permissions: [...CLIPBOARD_PERMISSIONS] })) return;
      const pending = { id: crypto.randomUUID(), digest, expiresAt: this.now() + preferences.seconds * 1000 };
      this.generation++;
      await this.browser.storage.session.set({ [CLIPBOARD_PENDING_KEY]: pending });
      await this.browser.alarms.create(CLIPBOARD_ALARM, { when: pending.expiresAt });
    });
  }
  cancel(): Promise<void> {
    this.generation++;
    return this.run(async () => { await this.browser.storage.session.remove(CLIPBOARD_PENDING_KEY); await this.browser.alarms.clear(CLIPBOARD_ALARM); });
  }
  expire(immediate = false): Promise<void> {
    return this.run(async () => {
      const stored = await this.browser.storage.session.get(CLIPBOARD_PENDING_KEY);
      const pending = stored[CLIPBOARD_PENDING_KEY];
      if (!validClipboardExpiry(pending)) return;
      if (!immediate && pending.expiresAt > this.now()) { await this.browser.alarms.create(CLIPBOARD_ALARM, { when: pending.expiresAt }); return; }
      const preferences = await this.browser.storage.local.get(CLIPBOARD_PREFERENCES_KEY);
      if (!clipboardPreferences(preferences[CLIPBOARD_PREFERENCES_KEY]).enabled || !await this.browser.permissions.contains({ permissions: [...CLIPBOARD_PERMISSIONS] })) {
        await this.browser.storage.session.remove(CLIPBOARD_PENDING_KEY); return;
      }
      const generation = this.generation;
      try {
        await ensureBrowserDocument();
        if (generation !== this.generation) return;
        await this.browser.runtime.sendMessage({ type: CLIPBOARD_CLEAR_MESSAGE, digest: pending.digest });
      } finally {
        await this.browser.storage.session.remove(CLIPBOARD_PENDING_KEY);
        await this.browser.alarms.clear(CLIPBOARD_ALARM);
      }
    });
  }
}
