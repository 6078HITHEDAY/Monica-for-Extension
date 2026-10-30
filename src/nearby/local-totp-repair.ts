import type { TotpItem, VaultState } from "../core/model";
import { parseLosslessJson } from "../core/lossless-json";

const DEFAULT_DIGITS = 6;
const DEFAULT_PERIOD = 30;

/**
 * Older builds decoded an Android authenticator whose serialized `item_data` omitted Kotlin's
 * `digits = 6` / `period = 30` defaults as zero, and adoption persisted that projection into the
 * local item. A decoder fix cannot reach those written items, so re-read the raw payload retained
 * by the Nearby receipt. A missing digit count heals the 0.1.47 clamp (4 -> 6); zero or otherwise
 * unusable persisted values fall back to the payload's explicit parameter, then to Android's
 * default. Explicit values Android actually stored (including 4) stay untouched.
 */
export function repairPersistedTotpParameters(state: VaultState): void {
  if (!Array.isArray(state.items)) return;
  const receipts: unknown = state.nearbyLocalReceipts;
  if (!Array.isArray(receipts) || !receipts.length) {
    repairInvalidTotpParameters(state);
    return;
  }
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
  state.items = state.items.map((item) => {
    if (item.kind !== "totp") return item;
    const itemData = itemDataByItemId.get(item.id);
    let digits = validDigits(item.digits) ?? explicitDigits(itemData) ?? DEFAULT_DIGITS;
    const period = validPeriod(item.period) ?? explicitPeriod(itemData) ?? DEFAULT_PERIOD;
    // Kotlin omits a value equal to the default, so a 4 next to a payload without `digits` is
    // the 0.1.47 clamp, never an Android parameter.
    if (itemData && !Object.prototype.hasOwnProperty.call(itemData, "digits") && item.digits === 4) digits = DEFAULT_DIGITS;
    if (digits === item.digits && period === item.period) return item;
    return { ...item, digits, period } satisfies TotpItem;
  });
}

function repairInvalidTotpParameters(state: VaultState): void {
  state.items = state.items.map((item) => {
    if (item.kind !== "totp") return item;
    const digits = validDigits(item.digits) ?? DEFAULT_DIGITS;
    const period = validPeriod(item.period) ?? DEFAULT_PERIOD;
    if (digits === item.digits && period === item.period) return item;
    return { ...item, digits, period } satisfies TotpItem;
  });
}

function validDigits(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 4 && value <= 10 ? value : undefined;
}

function validPeriod(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function explicitDigits(itemData: Record<string, unknown> | undefined): number | undefined {
  return itemData && Object.prototype.hasOwnProperty.call(itemData, "digits") ? validDigits(readNumeric(itemData.digits)) : undefined;
}

function explicitPeriod(itemData: Record<string, unknown> | undefined): number | undefined {
  return itemData && Object.prototype.hasOwnProperty.call(itemData, "period") ? validPeriod(readNumeric(itemData.period)) : undefined;
}

/** Lossless JSON can retain a numeric field as text; only usable numbers count as explicit. */
function readNumeric(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
