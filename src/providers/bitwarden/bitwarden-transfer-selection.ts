import type { VaultItem, ProviderAccount } from '../../core/model';
import { bitwardenProjectCipherId } from '../../core/bitwarden-project-removal-local';
import { mdbx2TransferDependencies } from '../mdbx2/mdbx2-transfer-dependencies';

/** A native Cipher is one copy unit. Expand its login, OTP and every FIDO2
 * sibling before following password-project/SSO/note dependencies again. */
export function bitwardenTransferSelection(ids: string[], items: VaultItem[], providers: ProviderAccount[]) {
  const accounts = new Set(providers.filter(row => row.kind === 'bitwarden').map(row => row.id));
  const nativeKey = (item: VaultItem) => item.providerRefs.flatMap(ref => {
    const cipher = ref.remoteId && bitwardenProjectCipherId(ref.remoteId);
    return accounts.has(ref.providerId) && cipher ? [JSON.stringify([ref.providerId, cipher])] : [];
  });
  const members = new Map<string, string[]>();
  for (const item of items) for (const key of nativeKey(item)) members.set(key, [...(members.get(key) || []), item.id]);
  let selected = new Set(ids);
  let dependency = mdbx2TransferDependencies([...selected], items, 'copy');
  for (;;) {
    const before = selected.size; selected = new Set(dependency.selectedIds);
    for (const item of items) if (selected.has(item.id)) for (const key of nativeKey(item))
      for (const id of members.get(key)!) selected.add(id);
    if (selected.size > 200) throw new Error('包含完整 Bitwarden 记录及关联项目后超过单次 200 项上限。');
    dependency = mdbx2TransferDependencies([...selected], items, 'copy');
    if (dependency.selectedIds.length === before) break;
  }
  // Add native membership edges to the already-expanded connected components.
  const parent = new Map(dependency.selectedIds.map(id => [id, id]));
  const root = (id: string): string => { const next = parent.get(id)!; return next === id ? id : root(next); };
  const join = (ids: string[]) => { for (const id of ids.slice(1)) parent.set(root(id), root(ids[0])); };
  dependency.components.forEach(join);
  for (const group of members.values()) { const ids = group.filter(id => parent.has(id)); if (ids.length) join(ids); }
  const groups = new Map<string, string[]>();
  for (const id of dependency.selectedIds) groups.set(root(id), [...(groups.get(root(id)) || []), id]);
  return { selectedIds: dependency.selectedIds, components: [...groups.values()] };
}
