import { describe, expect, it } from "vitest";
import { Mdbx2NativeHostError } from "./native-contract";
import {
  cancelMdbxImport,
  commitMdbxImport,
  detectMdbxImport,
  prepareMdbxImport,
  recoverMdbxImports,
  type MdbxImportNative,
  type MdbxImportOperation,
  type MdbxImportStore,
  type MdbxImportVault
} from "./mdbx-import-coordinator";

const operationId = "11111111-1111-4111-8111-111111111111";
const vaultHandle = "22222222-2222-4222-8222-222222222222";
const fileHandle = "33333333-3333-4333-8333-333333333333";

function memoryStore(seed: MdbxImportOperation[] = []): MdbxImportStore {
  let operations = seed;
  return {
    async read() { return operations.map((row) => ({ ...row })); },
    async write(next) { operations = next.map((row) => ({ ...row })); }
  };
}

function inspection(methods: Array<"pin" | "password" | "security-key" | "password-security-key"> = ["password"]) {
  return {
    source: { kind: "file" as const, handle: fileHandle },
    initialized: true as const,
    formatVersion: "MDBX-1" as const,
    requiresUpgrade: true,
    unknownCriticalExtensions: false as const,
    targetFormatVersion: "MDBX-2" as const,
    targetSchemaVersion: 17,
    unlockMethods: methods,
    portableUnlockAvailable: methods.includes("password") || methods.includes("pin")
  };
}

function native(overrides: Partial<MdbxImportNative> = {}): MdbxImportNative & { discarded: string[] } {
  const discarded: string[] = [];
  return {
    discarded,
    inspectVault: async () => inspection(),
    openVault: async () => ({
      vaultHandle, vaultId: vaultHandle, deviceId: vaultHandle, migrated: true, preUpgradeBackupCreated: true,
      checkedAtUnixSeconds: 1, fileSizeBytes: 8, formatVersion: "MDBX-2", schemaVersion: 17,
      health: { healthy: true, issueCount: 0, infoCount: 0, warningCount: 0, errorCount: 0, criticalCount: 0, categories: [], issueKinds: [] },
      diagnostics: {
        commitCount: 0, tombstoneCount: 0, branchCount: 0, deviceCount: 0, snapshotCount: 0, unresolvedConflictCount: 0,
        projectCount: 0, folderCount: 0, deletedProjectCount: 0, entryCount: 0, deletedEntryCount: 0,
        attachmentCount: 0, deletedAttachmentCount: 0, externalAttachmentCount: 0, originalAttachmentBytes: 0, storedAttachmentBytes: 0
      }
    }),
    vaultStatus: async () => ({ open: true, available: true }),
    listCollections: async () => ({ items: [{ collectionId: vaultHandle }] }),
    listObjects: async () => ({ items: [] }),
    discardVault: async (handle) => { discarded.push(handle); return true; },
    lockVault: async () => true,
    backendForVault: async () => "browser",
    releaseFile: async () => true,
    ...overrides
  };
}

function vault(status: "uninitialized" | "locked" | "unlocked" = "uninitialized"): MdbxImportVault & { upserts: number } {
  let current = status;
  let session = status === "unlocked" ? "session" : undefined;
  const providers = new Map<string, { id: string; kind: "mdbx2"; name: string; enabled: true; isDefaultSaveTarget: boolean; config: Record<string, unknown> }>();
  const plugin = {
    upserts: 0,
    status: async () => current,
    passkeySessionId: async () => session,
    setup: async () => {
      current = "unlocked";
      session = "session";
      return { items: [] };
    },
    listProviders: async () => [...providers.values()] as never,
    getProvider: async (id: string) => providers.get(id) as never,
    upsertProvider: async (account: Parameters<MdbxImportVault["upsertProvider"]>[0]) => {
      plugin.upserts += 1;
      providers.set(account.id, account as never);
      return account;
    }
  };
  return plugin;
}

function quotaStore(seed: MdbxImportOperation[] = []): MdbxImportStore {
  const inner = memoryStore(seed);
  return {
    read: () => inner.read(),
    async write(operations) {
      if (operations.some((row) => row.stage === "registered" || row.stage === "syncing" || row.stage === "completed")) {
        throw new Error("quota");
      }
      await inner.write(operations);
    }
  };
}

describe("mdbx import coordinator", () => {
  it("retains ownership evidence when registration persists then throws while the plugin is locked", async () => {
    const store = memoryStore();
    const runtime = native();
    const plugin = vault("unlocked");
    const listProviders = plugin.listProviders;
    const upsertProvider = plugin.upsertProvider;
    plugin.upsertProvider = async (...args) => {
      await upsertProvider(...args);
      plugin.listProviders = async () => { throw new Error("locked"); };
      throw new Mdbx2NativeHostError("VAULT_LOCKED", "locked", true);
    };
    await prepareMdbxImport(store, runtime, {
      operationId, source: { kind: "file", handle: fileHandle }, credential: { method: "password", password: "synthetic" }, name: "Golden"
    });
    await expect(commitMdbxImport(store, runtime, plugin, async () => undefined, { operationId, name: "Golden" })).rejects.toThrow();
    expect(runtime.discarded).toEqual([]);
    expect((await store.read())[0]).toMatchObject({ stage: "committing", vaultHandle });
    await cancelMdbxImport(store, runtime, operationId, plugin);
    expect(runtime.discarded).toEqual([]);
    const stale = await store.read();
    stale[0].updatedAt = 1;
    await store.write(stale);
    await recoverMdbxImports(store, runtime, plugin);
    expect(runtime.discarded).toEqual([]);
    const status = runtime.vaultStatus;
    runtime.vaultStatus = async () => ({ open: false, available: true });
    await expect(commitMdbxImport(store, runtime, plugin, async () => undefined, { operationId, name: "Golden" })).rejects.toMatchObject({ code: "vault-locked" });
    expect((await store.read())[0]).toMatchObject({ stage: "committing", vaultHandle });
    expect(runtime.discarded).toEqual([]);
    runtime.vaultStatus = status;
    plugin.listProviders = listProviders;
    const retried = await commitMdbxImport(store, runtime, plugin, async () => undefined, { operationId, name: "Golden" });
    expect(retried.operation.stage).toBe("completed");
    expect(plugin.upserts).toBe(1);
  });

  it("prepares a working copy once and cancels unregistered copies", async () => {
    const store = memoryStore();
    const runtime = native();
    const first = await prepareMdbxImport(store, runtime, {
      operationId, source: { kind: "file", handle: fileHandle }, credential: { method: "password", password: "mdbx1-golden-password" }, name: "Golden"
    });
    const second = await prepareMdbxImport(store, runtime, {
      operationId, source: { kind: "file", handle: fileHandle }, credential: { method: "password", password: "mdbx1-golden-password" }, name: "Golden"
    });
    expect(first.operation.stage).toBe("prepared");
    expect(second.operation.vaultHandle).toBe(first.operation.vaultHandle);
    await cancelMdbxImport(store, runtime, operationId, vault("uninitialized"));
    expect(runtime.discarded).toContain(vaultHandle);
  });

  it("allows a password attempt when inspect lists no unlock methods", async () => {
    const store = memoryStore();
    let opened = false;
    const runtime = native({
      inspectVault: async () => inspection([]),
      openVault: async (...args) => {
        opened = true;
        return native().openVault(...args);
      }
    });
    const prepared = await prepareMdbxImport(store, runtime, {
      operationId, source: { kind: "file", handle: fileHandle }, credential: { method: "password", password: "mdbx1-golden-password" }, name: "Unknown"
    });
    expect(opened).toBe(true);
    expect(prepared.operation.stage).toBe("prepared");
    const detected = await detectMdbxImport(runtime, { kind: "file", handle: fileHandle }, "mdbx-complete-backup-zip");
    expect(detected.sniff.kind).toBe("mdbx-complete-backup-zip");
  });

  it("rejects PIN-only vaults before open and maps distinct unlock errors", async () => {
    const store = memoryStore();
    await expect(prepareMdbxImport(store, native({ inspectVault: async () => inspection(["pin"]) }), {
      operationId: "aaaaaaaa-1111-4111-8111-111111111111", source: { kind: "file", handle: fileHandle }, credential: { method: "password", password: "x" }, name: "Pin"
    })).rejects.toMatchObject({ code: "vault-unlock-not-portable" });
    await expect(prepareMdbxImport(store, native({
      inspectVault: async () => inspection(["security-key"])
    }), {
      operationId: "44444444-4444-4444-8444-444444444444",
      source: { kind: "file", handle: fileHandle },
      credential: { method: "password", password: "x" },
      name: "Key"
    })).rejects.toMatchObject({ code: "vault-unlock-method-missing" });
    await expect(prepareMdbxImport(store, native({
      openVault: async () => { throw new Mdbx2NativeHostError("vault-unlock-incorrect-credential", "bad", false); }
    }), {
      operationId: "55555555-5555-4555-8555-555555555555",
      source: { kind: "file", handle: fileHandle },
      credential: { method: "password", password: "wrong" },
      name: "Wrong"
    })).rejects.toMatchObject({ code: "vault-unlock-incorrect-credential" });
    await expect(prepareMdbxImport(store, native({ inspectVault: async () => inspection(["password", "security-key"]) }), {
      operationId: "77777777-7777-4777-8777-777777777777",
      source: { kind: "file", handle: fileHandle },
      credential: { method: "password-security-key", password: "x", keyMaterialBase64: "YQ==" },
      name: "Split"
    })).rejects.toMatchObject({ code: "vault-unlock-method-missing" });
  });

  it("sets up an uninitialized plugin vault then registers without duplicating the account", async () => {
    const store = memoryStore();
    const runtime = native();
    await prepareMdbxImport(store, runtime, {
      operationId, source: { kind: "file", handle: fileHandle }, credential: { method: "password", password: "mdbx1-golden-password" }, name: "Golden"
    });
    const plugin = vault("uninitialized");
    const first = await commitMdbxImport(store, runtime, plugin, async () => undefined, { operationId, name: "Golden", pluginMasterPassword: "plugin-master" });
    const second = await commitMdbxImport(store, runtime, plugin, async () => undefined, { operationId, name: "Golden", pluginMasterPassword: "plugin-master" });
    expect(first.account?.id).toBe(second.account?.id);
    expect(first.operation.stage).toBe("completed");
  });

  it("cleans uncommitted copies on recover and keeps registered vaults", async () => {
    const store = memoryStore([
      { operationId, stage: "prepared", kind: "mdbx-vault", source: { kind: "vault", handle: vaultHandle }, name: "A", vaultHandle, createdAt: 1, updatedAt: 1 },
      { operationId: "66666666-6666-4666-8666-666666666666", stage: "registered", kind: "mdbx-vault", source: { kind: "vault", handle: vaultHandle }, name: "B", vaultHandle, providerId: "provider", createdAt: 1, updatedAt: 1 }
    ]);
    const runtime = native();
    const recovered = await recoverMdbxImports(store, runtime, vault("unlocked"));
    expect(runtime.discarded).toContain(vaultHandle);
    expect(recovered.find((row) => row.operationId === operationId)?.stage).toBe("cancelled");
    expect(recovered.find((row) => row.providerId === "provider")?.stage).toBe("syncing");
  });

  it("does not cancel a recently prepared import during recover", async () => {
    const store = memoryStore([
      { operationId, stage: "prepared", kind: "mdbx-vault", source: { kind: "vault", handle: vaultHandle }, name: "Live", vaultHandle, createdAt: Date.now(), updatedAt: Date.now() }
    ]);
    const runtime = native();
    const recovered = await recoverMdbxImports(store, runtime, vault("uninitialized"));
    expect(runtime.discarded).toEqual([]);
    expect(recovered[0]?.stage).toBe("prepared");
  });

  it("keeps the working copy if provider registration succeeds but operation storage fails", async () => {
    const store = quotaStore();
    const runtime = native();
    const plugin = vault("uninitialized");
    await prepareMdbxImport(store, runtime, {
      operationId, source: { kind: "file", handle: fileHandle }, credential: { method: "password", password: "mdbx1-golden-password" }, name: "Golden"
    });
    const committed = await commitMdbxImport(store, runtime, plugin, async () => undefined, {
      operationId, name: "Golden", pluginMasterPassword: "plugin-master"
    });
    expect(runtime.discarded).toEqual([]);
    expect(committed.account?.kind).toBe("mdbx2");
    expect(committed.operation.stage).toBe("registered");
    await cancelMdbxImport(store, runtime, operationId, plugin);
    expect(runtime.discarded).toEqual([]);
    const retried = await commitMdbxImport(store, runtime, plugin, async () => undefined, {
      operationId, name: "Golden", pluginMasterPassword: "plugin-master"
    });
    expect(plugin.upserts).toBe(1);
    expect(retried.account?.id).toBe(committed.account?.id);
  });

  it("does not discard a registered vault after cancel or stale recover races commit", async () => {
    const store = quotaStore();
    const runtime = native();
    const plugin = vault("uninitialized");
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    const innerUpsert = plugin.upsertProvider.bind(plugin);
    plugin.upsertProvider = async (account, activity, expected, guard) => {
      entered = true;
      await hold;
      return innerUpsert(account, activity, expected, guard);
    };
    await prepareMdbxImport(store, runtime, {
      operationId, source: { kind: "file", handle: fileHandle }, credential: { method: "password", password: "mdbx1-golden-password" }, name: "Golden"
    });
    const commit = commitMdbxImport(store, runtime, plugin, async () => undefined, {
      operationId, name: "Golden", pluginMasterPassword: "plugin-master"
    });
    while (!entered) await Promise.resolve();
    const cancel = cancelMdbxImport(store, runtime, operationId, plugin);
    const recover = recoverMdbxImports(store, runtime, plugin).catch(() => [] as Awaited<ReturnType<typeof recoverMdbxImports>>);
    release();
    const [committed] = await Promise.all([commit, cancel, recover]);
    expect(runtime.discarded).toEqual([]);
    expect(committed.account?.kind).toBe("mdbx2");
    const stale = memoryStore([{
      operationId,
      stage: "committing",
      kind: "mdbx-complete-backup-zip",
      source: { kind: "vault", handle: vaultHandle },
      name: "Golden",
      vaultHandle,
      createdAt: 1,
      updatedAt: 1
    }]);
    const restarted = await recoverMdbxImports(stale, native(), plugin);
    expect(restarted[0]?.stage).toBe("syncing");
    expect(restarted[0]?.providerId).toBe(committed.account?.id);
  });

  it("keeps a committing working copy when the plugin vault is locked after restart", async () => {
    const store = memoryStore([{
      operationId,
      stage: "committing",
      kind: "mdbx-vault",
      source: { kind: "vault", handle: vaultHandle },
      name: "Golden",
      vaultHandle,
      createdAt: 1,
      updatedAt: 1
    }]);
    const runtime = native();
    const locked = vault("locked");
    locked.listProviders = async () => { throw new Error("locked"); };
    locked.getProvider = async () => { throw new Error("locked"); };
    const recovered = await recoverMdbxImports(store, runtime, locked);
    expect(runtime.discarded).toEqual([]);
    expect(recovered[0]?.stage).toBe("committing");
  });

  it("prepares a complete backup and maps a wrong password without discarding later registered copies", async () => {
    const store = memoryStore();
    const runtime = native({
      inspectVault: async () => ({ ...inspection(), formatVersion: "MDBX-2", requiresUpgrade: false })
    });
    const prepared = await prepareMdbxImport(store, runtime, {
      operationId, source: { kind: "file", handle: fileHandle }, credential: { method: "password", password: "mdbx1-golden-password" }, name: "Backup", kind: "mdbx-complete-backup-zip"
    });
    expect(prepared.operation.kind).toBe("mdbx-complete-backup-zip");
    await expect(prepareMdbxImport(memoryStore(), native({
      openVault: async () => { throw new Mdbx2NativeHostError("vault-unlock-incorrect-credential", "bad", false); }
    }), {
      operationId: "55555555-5555-4555-8555-555555555555",
      source: { kind: "file", handle: fileHandle },
      credential: { method: "password", password: "wrong" },
      name: "Wrong",
      kind: "mdbx-complete-backup-zip"
    })).rejects.toMatchObject({ code: "vault-unlock-incorrect-credential" });
  });
});
