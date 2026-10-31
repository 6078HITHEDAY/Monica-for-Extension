import { expect, it } from "vitest";
import { normalizeImportedVaultItem } from "../manager/import-items";
import { importPlainBitwardenJson } from "../manager/bitwarden-json-import";
import { SecureVaultService } from "./secure-vault-service";
import { MemoryVaultStorage } from "./vault-storage";
import { MemoryVaultSessionStore } from "./vault-session";
import { deriveVaultKey, encryptVaultState } from "./vault-crypto";

it("imports unfamiliar local items visibly and preserves them through locking without allowing replacement", async () => {
  const storage = new MemoryVaultStorage(); const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await service.setup("synthetic readonly master password", []);
  const item = normalizeImportedVaultItem({ id: "future", kind: "future-credential", title: "Future", data: { value: null, flags: [false, ""] } });
  if (!item || item.kind !== "opaque") throw new Error("Expected opaque projection");
  await service.importItems([item]);
  await service.lock(); await service.unlock("synthetic readonly master password");
  expect(await service.listItems()).toEqual([expect.objectContaining({ id:item.id,kind:"opaque",originalPayload:item.originalPayload })]);
  const before = JSON.stringify(storage.envelope);
  await expect(service.importItems([{...item,title:"Replace"}])).rejects.toThrow("只读");
  expect(JSON.stringify(storage.envelope)).toBe(before);
  await service.deleteItem(item.id);
  expect((await service.readState(false)).items).toEqual([expect.objectContaining({ id: item.id, deletedAt: expect.any(String), originalPayload: item.originalPayload })]);
  await service.lock(); await service.unlock("synthetic readonly master password");
  await service.restoreItem(item.id);
  expect((await service.listItems())[0]).toMatchObject({ id: item.id, originalPayload: item.originalPayload });
  expect((await service.listItems())[0].deletedAt).toBeUndefined();
  await service.deleteItem(item.id);
  expect(await service.emptyLocalTrash()).toEqual({ removed: 1, retained: 0 });
  expect(await service.listItems()).toEqual([]);
});

it("keeps imported Bitwarden records editable and deletable after an encrypted restart", async () => {
  const storage = new MemoryVaultStorage();
  const sessions = new MemoryVaultSessionStore();
  let service = new SecureVaultService(storage, sessions);
  await service.setup("synthetic import master password", []);
  const items = importPlainBitwardenJson({ encrypted: false, items: [
    { type: 1, name: "Login", login: { username: "test", password: "synthetic" } },
    { type: 2, name: "Note", notes: "body" },
    { type: 3, name: "Card", card: { number: "4111111111111111" } },
    { type: 4, name: "Identity", identity: { firstName: "Test" } },
    { type: 5, name: "SSH", sshKey: { publicKey: "ssh-ed25519 AAAA", privateKey: "synthetic" } }
  ] });
  expect(items).toHaveLength(5);
  await service.importItems(items);
  await service.lock();
  service = new SecureVaultService(storage, sessions);
  await service.unlock("synthetic import master password");
  for (const item of await service.listItems()) {
    expect(item.kind).not.toBe("opaque");
    expect(item.providerRefs).toEqual([]);
    await service.importItems([{ ...item, title: `Edited ${item.title}` }]);
    await service.deleteItem(item.id);
  }
  expect(await service.emptyLocalTrash()).toEqual({ removed: 5, retained: 0 });
});

it("does not delete or restore opaque remote records through the local import cleanup", async () => {
  const password = "synthetic remote opaque password";
  const storage = new MemoryVaultStorage();
  const sessions = new MemoryVaultSessionStore();
  let service = new SecureVaultService(storage, sessions);
  const state = await service.setup(password, []);
  const item = normalizeImportedVaultItem({ id: "remote-future", kind: "future-credential" })!;
  item.providerRefs = [{ providerId: "remote-unknown", remoteId: "preserved-native-id" }];
  state.items = [item, { ...item, id: "remote-trash", deletedAt: new Date().toISOString() }];
  const { key, kdf } = await deriveVaultKey(password, storage.envelope!.kdf);
  storage.envelope = await encryptVaultState(state, key, kdf);
  await service.lock();
  service = new SecureVaultService(storage, sessions);
  await service.unlock(password);
  const before = JSON.stringify(storage.envelope);
  await expect(service.deleteItem(item.id)).rejects.toThrow("仅可读取");
  await expect(service.restoreItem("remote-trash")).rejects.toThrow("仅可读取");
  expect(await service.emptyLocalTrash()).toEqual({ removed: 0, retained: 1 });
  expect(JSON.stringify(storage.envelope)).toBe(before);
});
