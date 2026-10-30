import type { ProviderAccount, VaultItem } from '../core/model';
import { buildHomeCatalog, homeFolderKey, itemHomeFolders, matchesHomeSource } from './home-catalog';
import {decodeKeePassPathForDisplay} from '../providers/keepass/keepass-path-codec';

/** Scope by native folder identity and source; equal names never merge databases. */
export function managerFolders(items: readonly VaultItem[], providers: readonly ProviderAccount[], source: string) {
  return buildHomeCatalog(items, providers, source).folders.filter(folder => folder.type !== 'uncategorized')
    .map(folder=>folder.type === 'keepass' ? {...folder,label:decodeKeePassPathForDisplay(folder.label)} : folder);
}
export function matchesManagerFolder(item: VaultItem, folder: string, source: string, providers: readonly ProviderAccount[]) {
  if (!matchesHomeSource(item, source, providers)) return false;
  if (folder === 'all') return true;
  const folders = itemHomeFolders(item, providers).filter(row => source === 'all' || row.sourceId === source);
  return folders.some(row => folder === 'uncategorized' ? row.type === 'uncategorized' : homeFolderKey(row) === folder);
}

export interface ManagerScope { source: string; folder: string }
export function readManagerScope(scopes: Record<string,ManagerScope>, section: string): ManagerScope {
  return scopes[section] || {source:'all',folder:'all'};
}
