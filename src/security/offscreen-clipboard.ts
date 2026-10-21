import { clipboardDigest } from './clipboard-lifecycle';

/** execCommand works in an authorized offscreen document without stealing focus from a tab. */
export async function clearMatchingClipboard(digest: string, root: Document = document): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(digest)) return false;
  const field = root.createElement('textarea'); root.body.append(field);
  const read = () => { field.value = ''; field.focus(); return root.execCommand('paste') ? field.value : undefined; };
  try {
    const current = read();
    if (current === undefined || await clipboardDigest(current) !== digest) return false;
    // Hashing yields. Check again synchronously before clearing to preserve later copies.
    if (read() !== current) return false;
    // An empty selection may make Chromium skip copying entirely. Select a
    // placeholder but replace the copied payload with empty text in the event.
    const empty = (event: ClipboardEvent) => { event.clipboardData?.setData('text/plain', ''); event.preventDefault(); };
    root.addEventListener('copy', empty, { once: true });
    try { field.value = ' '; field.select(); return root.execCommand('copy'); }
    finally { root.removeEventListener('copy', empty); }
  } finally { field.value = ''; field.remove(); }
}
