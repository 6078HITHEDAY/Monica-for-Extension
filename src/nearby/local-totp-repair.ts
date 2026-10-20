import type { VaultState } from "../core/model";
import { parseLosslessJson } from "../core/lossless-json";

/**
 * The 0.1.47 build decoded an Android authenticator whose serialized `item_data` omitted Kotlin's
 * `digits = 6` default as zero, and the read-time clamp then turned it into 4. Adoption persisted
 * that projected value into the local item, so fixing the decoder alone cannot heal records that
 * were imported before the fix. The nearby receipt still carries the original wire payload, which
 * includes `item_data`; re-read it and restore only an omitted digit count. An explicitly stored
 * value (even 4) is Android's actual parameter and must stay untouched.
 */
export function repairNearbyLocalTotpDigits(state: VaultState): void {
  if (!Array.isArray(state.items)) return;
  const receipts: unknown = state.nearbyLocalReceipts;
  if (!Array.isArray(receipts) || !receipts.length) return;
  const itemDataByItemId = new Map<string, Record<string, unknown>>();
  for (const raw of receipts) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const receipt = raw as { itemId?: unknown; dataJson?: unknown };
    if (typeof receipt.itemId !== "string" || typeof receipt.dataJson !== "string") continue;
    try {
      const data: unknown = parseLosslessJson(receipt.dataJson);
      if (!data || typeof data !== "object" || Array.isArray(data)) continue;
      const payload = (data as Record<string, unknown>).payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
      const itemData = (payload as Record<string, unknown>).item_data;
      if (typeof itemData !== "string" || !itemData.startsWith("{")) continue;
      const parsed: unknown = parseLosslessJson(itemData);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      itemDataByItemId.set(receipt.itemId, parsed as Record<string, unknown>);
    } catch {
      // A receipt this build cannot read is not repairable here; leave the item untouched.
    }
  }
  if (!itemDataByItemId.size) return;
  state.items = state.items.map((item) => {
    if (item.kind !== "totp" || item.digits !== 4) return item;
    const itemData = itemDataByItemId.get(item.id);
    if (!itemData || Object.prototype.hasOwnProperty.call(itemData, "digits")) return item;
    return { ...item, digits: 6 };
  });
}
