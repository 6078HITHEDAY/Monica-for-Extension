import type { ProviderAccount, VaultItem } from "./model";

/**
 * Only records that belong exclusively to an enabled local source can be removed without a
 * provider round-trip. Provider-backed tombstones must be purged through their own source, and
 * Local opaque imports can be removed without interpreting their payload.
 */
export function isLocalTrashItem(item: VaultItem, providers: readonly ProviderAccount[]): boolean {
  if (!item.deletedAt) return false;
  return isLocalOnlyVaultItem(item, providers);
}

export function isLocalOnlyVaultItem(item: VaultItem, providers: readonly ProviderAccount[]): boolean {
  return (item.providerRefs ?? []).every(reference => reference.providerId === "local"
    || providers.some(provider => provider.id === reference.providerId && provider.kind === "local"));
}
