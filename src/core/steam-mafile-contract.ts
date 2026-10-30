import type { LoginItem } from './model';

export const STEAM_MAFILE_MARKER_FIELD = 'Monica.Type';
export const STEAM_MAFILE_MARKER_VALUE = 'steam_mafile_v1';
export const STEAM_MAFILE_MAX_BYTES = 1024 * 1024;

export function isSteamMaFileLogin(item: LoginItem): boolean {
  if (item.loginType?.trim().toUpperCase() === 'STEAM_MAFILE') return true;
  return (item.customFields || []).some(field => {
    const name = field.name.trim().toLowerCase(), value = field.value.trim().toLowerCase();
    return (name === STEAM_MAFILE_MARKER_FIELD.toLowerCase() && value === STEAM_MAFILE_MARKER_VALUE)
      || (['steam_type', 'steam_type_marker', 'monica_steam_type'].includes(name) && value.includes('steam_mafile'));
  });
}

export function isSteamMaFileName(fileName: string): boolean {
  return fileName.trim().toLowerCase().endsWith('.mafile');
}
