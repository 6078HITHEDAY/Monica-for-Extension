import { describe, expect, it } from "vitest";
import { createLoginItem, type LoginItem, type ProviderAccount, type TotpItem } from "../core/model";
import { SecureVaultService } from "./secure-vault-service";
import { MemoryVaultSessionStore } from "./vault-session";
import { MemoryVaultStorage } from "./vault-storage";

const bitwarden: ProviderAccount = { id: "bw", kind: "bitwarden", name: "Synthetic Bitwarden", enabled: true, isDefaultSaveTarget: false, config: { apiUrl: "https://example.test/api" } };

async function fixture() {
  const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore(), () => Date.now());
  await service.setup("empty trash master password");
  await service.upsertProvider(bitwarden);
  const totp: TotpItem = { ...createLoginItem({ title: "Local code" }), kind: "totp", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 };
  await service.upsertItem(totp);
  const linked: LoginItem = { ...createLoginItem({ title: "Linked login", password: "linked-secret" }), boundTotpItemId: totp.id };
  await service.upsertItem(linked);
  const remote = await service.upsertItem(createLoginItem({ title: "Remote trash", password: "remote-secret", providerRefs: [{ providerId: "bw" }] }));
  await service.deleteItem(totp.id);
  await service.deleteItem(remote.id);
  return { service, totp, linked, remote };
}

describe("empty local trash", () => {
  it("permanently removes local tombstones and retains provider-backed ones", async () => {
    const { service, totp, remote } = await fixture();
    expect(await service.emptyLocalTrash()).toEqual({ removed: 1, retained: 1 });
    const state = await service.readState(false);
    expect(state.items.some(item => item.id === totp.id)).toBe(false);
    expect(state.items.find(item => item.id === remote.id)?.deletedAt).toBeTruthy();
    expect(state.items.find(item => item.id === remote.id)?.providerRefs).toEqual([{ providerId: "bw" }]);
  });

  it("unbinds links that pointed at removed local items", async () => {
    const { service, totp, linked } = await fixture();
    const linkedById = (items: Awaited<ReturnType<typeof service.readState>>["items"]) => items.find((item): item is LoginItem => item.id === linked.id);
    expect(linkedById((await service.readState(false)).items)?.boundTotpItemId).toBe(totp.id);
    await service.emptyLocalTrash();
    const state = await service.readState(false);
    expect(linkedById(state.items)?.boundTotpItemId).toBeUndefined();
  });

  it("removes items that reference the local provider by id", async () => {
    const { service, linked } = await fixture();
    const localProvider = (await service.listProviders()).find(provider => provider.kind === "local")!;
    await service.upsertItem({ ...linked, providerRefs: [{ providerId: localProvider.id }] });
    const stateBefore = await service.readState(false);
    expect(stateBefore.items.find(item => item.id === linked.id)?.providerRefs).toEqual([{ providerId: localProvider.id }]);
    expect(await service.emptyLocalTrash()).toEqual({ removed: 1, retained: 1 });
  });

  it("is idempotent and reports nothing left to remove", async () => {
    const { service } = await fixture();
    expect(await service.emptyLocalTrash()).toEqual({ removed: 1, retained: 1 });
    expect(await service.emptyLocalTrash()).toEqual({ removed: 0, retained: 1 });
  });

  it("does not touch active items", async () => {
    const { service, remote } = await fixture();
    await service.restoreItem(remote.id);
    expect(await service.emptyLocalTrash()).toEqual({ removed: 1, retained: 0 });
    expect((await service.readState(false)).items.find(item => item.id === remote.id)?.deletedAt).toBeUndefined();
  });
});
