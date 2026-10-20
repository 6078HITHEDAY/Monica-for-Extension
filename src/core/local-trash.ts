import type { ProviderAccount, VaultItem } from "./model";

/**
 * Only records that belong exclusively to an enabled local source can be removed without a
 * provider round-trip. Provider-backed tombstones must be purged through their own source, and
 * opaque native records cannot be managed here at all.
 */
export function isLocalTrashItem(item: VaultItem, providers: readonly ProviderAccount[]): boolean {
  if (!item.deletedAt || item.kind === "opaque") return false;
  return (item.providerRefs ?? []).every(reference => reference.providerId === "local"
    || providers.some(provider => provider.id === reference.providerId && provider.kind === "local"));
}
