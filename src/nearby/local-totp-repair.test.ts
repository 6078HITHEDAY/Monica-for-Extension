import { describe, expect, it } from "vitest";
import { migrateVaultState } from "../core/migrations";
import type { TotpItem, VaultState } from "../core/model";

const NOW = "2026-10-20T00:00:00.000Z";

function totp(id: string, digits: number, period = 30): TotpItem {
  return {
    id, kind: "totp", title: id, favorite: false, notes: "",
    createdAt: NOW, updatedAt: NOW, providerRefs: [],
    secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits, period
  };
}

function receipt(item: TotpItem, itemData: string) {
  return {
    version: 1, providerId: "local-provider", recordId: `record-${item.id}`, itemId: item.id,
    fingerprint: "a".repeat(64), dataJson: JSON.stringify({
      title: item.title, folder: "", entry_type: "totp", payload: { item_data: itemData }
    }), baseline: item, acknowledgement: {}
  };
}

function stateWith(items: TotpItem[], receipts: unknown[]): VaultState {
  return migrateVaultState({
    magic: "MONICA_EXTENSION_VAULT", schemaVersion: 2, createdAt: NOW, updatedAt: NOW,
    items,
    providers: [{ id: "local-provider", kind: "local", name: "Monica 本地库", enabled: true, isDefaultSaveTarget: true, config: {} }],
    mutationQueue: [], providerMutationReceipts: [], providerConflicts: [], providerDiagnostics: [], sourceRecords: [],
    settings: { autoLockMinutes: 15, defaultProviderId: "local-provider", protectionMode: "master-password" },
    nearbyLocalReceipts: receipts
  });
}

const totpOf = (state: VaultState, id: string) => state.items.find(item => item.id === id) as TotpItem | undefined;
const digitsOf = (state: VaultState, id: string) => totpOf(state, id)?.digits;
const periodOf = (state: VaultState, id: string) => totpOf(state, id)?.period;

describe("repairPersistedTotpParameters", () => {
  it("restores Kotlin's omitted default when adoption persisted the 0.1.47 clamp", () => {
    const item = totp("omitted", 4);
    const state = stateWith([item], [receipt(item, JSON.stringify({ secret: "JBSWY3DPEHPK3PXP" }))]);
    expect(digitsOf(state, "omitted")).toBe(6);
  });

  it("keeps an explicit digit count even when it is 4", () => {
    const item = totp("explicit", 4);
    const state = stateWith([item], [receipt(item, JSON.stringify({ secret: "JBSWY3DPEHPK3PXP", digits: 4 }))]);
    expect(digitsOf(state, "explicit")).toBe(4);
  });

  it("keeps explicit non-default and non-buggy counts untouched", () => {
    const eight = totp("eight", 4);
    const five = totp("five", 5);
    const state = stateWith([eight, five], [
      receipt(eight, JSON.stringify({ secret: "JBSWY3DPEHPK3PXP", digits: 8 })),
      receipt(five, JSON.stringify({ secret: "JBSWY3DPEHPK3PXP" }))
    ]);
    expect(digitsOf(state, "eight")).toBe(4);
    expect(digitsOf(state, "five")).toBe(5);
  });

  it("heals zeroed digits and period persisted by older imports", () => {
    const item = totp("zeroed", 0, 0);
    const state = stateWith([item], []);
    expect(digitsOf(state, "zeroed")).toBe(6);
    expect(periodOf(state, "zeroed")).toBe(30);
  });

  it("uses explicit payload parameters when the persisted values are unusable", () => {
    const item = totp("explicit-raw", 0, 0);
    const state = stateWith([item], [receipt(item, JSON.stringify({ secret: "JBSWY3DPEHPK3PXP", digits: 8, period: 60 }))]);
    expect(digitsOf(state, "explicit-raw")).toBe(8);
    expect(periodOf(state, "explicit-raw")).toBe(60);
  });

  it("keeps a deliberately custom period and valid digits", () => {
    const item = totp("custom", 6, 60);
    const state = stateWith([item], [receipt(item, JSON.stringify({ secret: "JBSWY3DPEHPK3PXP" }))]);
    expect(digitsOf(state, "custom")).toBe(6);
    expect(periodOf(state, "custom")).toBe(60);
  });

  it("leaves local authenticators without a nearby receipt alone", () => {
    const state = stateWith([totp("manual", 4)], []);
    expect(digitsOf(state, "manual")).toBe(4);
  });

  it("ignores receipts whose companion payload is unreadable or not a TOTP item_data", () => {
    const malformed = totp("malformed", 4);
    const opaque = totp("opaque", 4);
    const state = stateWith([malformed, opaque], [
      { version: 1, providerId: "local-provider", recordId: "r1", itemId: "malformed", fingerprint: "b".repeat(64), dataJson: "{", baseline: malformed, acknowledgement: {} },
      receipt(opaque, "not json")
    ]);
    expect(digitsOf(state, "malformed")).toBe(4);
    expect(digitsOf(state, "opaque")).toBe(4);
  });

  it("is idempotent across repeated unlocks", () => {
    const item = totp("repeat", 4);
    const once = stateWith([item], [receipt(item, JSON.stringify({ secret: "JBSWY3DPEHPK3PXP" }))]);
    const twice = migrateVaultState(once);
    expect(digitsOf(twice, "repeat")).toBe(6);
    expect(twice.items).toEqual(once.items);
  });
});
