// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { clipboardDigest, clipboardPreferences } from './clipboard-lifecycle';
import { clearMatchingClipboard } from './offscreen-clipboard';

describe('clipboard lifecycle', () => {
  it('defaults off and bounds cleanup times', () => {
    expect(clipboardPreferences(undefined)).toEqual({ enabled: false, seconds: 60 });
    expect(clipboardPreferences({ enabled: true, seconds: -1 })).toEqual({ enabled: true, seconds: 60 });
  });
  it('clears matching text and disposes the temporary field', async () => {
    let clipboard = 'synthetic clipboard secret';
    const command = vi.fn((name: string) => {
      const field = document.querySelector('textarea')!;
      if (name === 'paste') field.value = clipboard;
      if (name === 'copy') { clipboard = ''; }
      return true;
    });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: command });
    expect(await clearMatchingClipboard(await clipboardDigest(clipboard))).toBe(true);
    expect(clipboard).toBe(''); expect(document.querySelector('textarea')).toBeNull();
  });
  it('preserves a later copy, including a change during digest calculation', async () => {
    const digest = await clipboardDigest('old synthetic secret');
    let clipboard = 'new unrelated content';
    const command = vi.fn((name: string) => {
      if (name === 'paste') document.querySelector('textarea')!.value = clipboard;
      return true;
    });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: command });
    expect(await clearMatchingClipboard(digest)).toBe(false);
    expect(command).not.toHaveBeenCalledWith('copy');
    clipboard = 'old synthetic secret'; let reads = 0;
    command.mockImplementation(name => {
      if (name === 'paste') document.querySelector('textarea')!.value = ++reads === 1 ? clipboard : 'copied during hashing';
      return true;
    });
    expect(await clearMatchingClipboard(digest)).toBe(false);
    expect(command).not.toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });
});
