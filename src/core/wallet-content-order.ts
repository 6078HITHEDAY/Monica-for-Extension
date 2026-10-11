import type { VaultItem } from './model';

/** Same resolution as Android WalletEditorOrder: unknown keys never hide live sections. */
export function resolveWalletContentOrder(saved: readonly string[] | undefined, available: readonly string[]): string[] {
  return [...new Set([...(saved ?? []).filter(key => available.includes(key)), ...available])];
}

export function moveWalletContent(saved: readonly string[] | undefined, available: readonly string[], key: string, offset: -1 | 1): string[] | undefined {
  const visible = resolveWalletContentOrder(saved, available);
  const from = visible.indexOf(key), to = from + offset;
  if (from < 0 || to < 0 || to >= visible.length) return saved ? [...saved] : undefined;
  visible.splice(to, 0, visible.splice(from, 1)[0]);
  return [...visible, ...(saved ?? []).filter(value => !available.includes(value))];
}

/** Used only after a provider has already matched the native item identity. */
export function preserveLocalWalletContentOrder(local: VaultItem | undefined, remote: VaultItem): VaultItem {
  if ((remote.kind !== 'card' && remote.kind !== 'identity') || local?.kind !== remote.kind
    || remote.editorSectionOrder !== undefined || local.editorSectionOrder === undefined) return remote;
  return { ...remote, editorSectionOrder: [...local.editorSectionOrder] };
}

export function walletContentOrderOnlyChanged(previous: VaultItem | undefined, next: VaultItem): boolean {
  if (!previous || (next.kind !== 'card' && next.kind !== 'identity') || previous.kind !== next.kind) return false;
  const comparable = (item: VaultItem) => JSON.stringify({ ...item, editorSectionOrder: undefined, updatedAt: undefined },
    (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value);
  return JSON.stringify(previous.editorSectionOrder) !== JSON.stringify(next.editorSectionOrder) && comparable(previous) === comparable(next);
}
