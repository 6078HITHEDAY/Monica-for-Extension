import * as kdbxweb from 'kdbxweb';
import type { LoginItem } from '../../core/model';
import { parseSteamMaFile } from '../../core/steam-mafile';
import { isSteamMaFileLogin, isSteamMaFileName, STEAM_MAFILE_MAX_BYTES } from '../../core/steam-mafile-contract';

/** Read only explicitly marked Android carriers; never modify the original binary. */
export function hydrateKeePassSteam(item: LoginItem, entry: kdbxweb.KdbxEntry): void {
  if (!isSteamMaFileLogin(item)) return;
  const candidates = [...entry.binaries].sort(([a], [b]) => Number(isSteamMaFileName(b)) - Number(isSteamMaFileName(a)));
  const found: ReturnType<typeof parseSteamMaFile>[] = [];
  for (const [name, binary] of candidates) {
    const value = kdbxweb.KdbxBinaries.isKdbxBinaryWithHash(binary) ? binary.value : binary;
    if (!value.byteLength || value.byteLength > STEAM_MAFILE_MAX_BYTES) continue;
    const bytes = value instanceof kdbxweb.ProtectedValue ? value.getBinary() : new Uint8Array(value).slice();
    try {
      const parsed = parseSteamMaFile(new TextDecoder('utf-8', { fatal: true }).decode(bytes), name);
      // Multiple files may be identical backups. Distinct credentials must not
      // silently select an account based on attachment order.
      if (!found.some(other => other.rawJson === parsed.rawJson)) found.push(parsed);
    } catch { /* Preserve unreadable attachments and the visible carrier. */ }
    finally { bytes.fill(0); }
  }
  if (found.length !== 1) return;
  const steam = found[0];
  Object.assign(item, { steamAccountName: steam.accountName, steamDeviceId: steam.deviceId,
    steamSharedSecretBase64: steam.sharedSecretBase64, steamId: steam.steamId,
    steamAccessToken: steam.accessToken, steamRefreshToken: steam.refreshToken,
    steamLoginSecure: steam.steamLoginSecure, steamRevocationCode: steam.revocationCode,
    steamIdentitySecret: steam.identitySecret, steamTokenGid: steam.tokenGid, steamRawJson: steam.rawJson });
}
