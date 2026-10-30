export const CLIPBOARD_PREFERENCES_KEY = 'monica.clipboard.preferences.v1';
export const CLIPBOARD_PENDING_KEY = 'monica.clipboard.pending.v1';
export const CLIPBOARD_ALARM = 'monica.clipboard.expiry';
export const CLIPBOARD_CLEAR_MESSAGE = 'MONICA_CLIPBOARD_CLEAR';
export const CLIPBOARD_PERMISSIONS = ['clipboardRead', 'clipboardWrite'] as const;
export const CLIPBOARD_DELAYS = [30, 60, 120, 300] as const;
export interface ClipboardPreferences { enabled: boolean; seconds: number }
export interface ClipboardExpiry { id: string; digest: string; expiresAt: number }
export function clipboardPreferences(value: unknown): ClipboardPreferences {
  const raw = value && typeof value === 'object' ? value as Partial<ClipboardPreferences> : {};
  return { enabled: raw.enabled === true, seconds: CLIPBOARD_DELAYS.includes(raw.seconds as 60) ? raw.seconds! : 60 };
}
export async function clipboardDigest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  try { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join(''); }
  finally { bytes.fill(0); }
}
export function validClipboardExpiry(value: unknown): value is ClipboardExpiry {
  const row = value as ClipboardExpiry | undefined;
  return !!row && typeof row.id === 'string' && /^[a-f0-9-]{36}$/.test(row.id)
    && typeof row.digest === 'string' && /^[a-f0-9]{64}$/.test(row.digest) && Number.isSafeInteger(row.expiresAt);
}
