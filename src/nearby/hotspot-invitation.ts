/** Android's short-lived Wi-Fi envelope. Credentials are UI memory only; the
 * enclosed LAN invitation still supplies authentication after manual joining. */
export interface NearbyHotspotInvitation { ssid: string; passphrase: string; pairing: string }
function decode(value: string, limit: number): string | undefined {
  if (!value || value.length > Math.floor((limit * 4 + 2) / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) return;
  let bytes: Uint8Array | undefined;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    if (bytes.length > limit || btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== value) return;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { return; } finally { bytes?.fill(0); }
}
export function parseNearbyHotspotInvitation(input: string): NearbyHotspotInvitation | undefined {
  if (input.length > 1100) return;
  const parts = input.trim().split(':');
  if (parts.length !== 5 || parts[0] !== 'monica-hotspot' || parts[1] !== '1') return;
  const ssid = decode(parts[2], 32), passphrase = decode(parts[3], 63), pairing = decode(parts[4], 512);
  if (!ssid || /[\u0000-\u001f\u007f-\u009f]/.test(ssid)
    || !passphrase || !/^[\x20-\x7e]{8,63}$/.test(passphrase)
    || !pairing || !/^monica-lan:2:[0-9.,]+:[1-9]\d{0,4}:[A-Za-z0-9_-]{43}$/.test(pairing)) return;
  return { ssid, passphrase, pairing };
}
