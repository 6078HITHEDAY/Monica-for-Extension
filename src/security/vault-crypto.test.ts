import { describe, expect, it, vi } from "vitest";
import { createEmptyVaultState } from "../core/model";
import {
  createDeviceVaultKey,
  decryptVaultState,
  deriveVaultKey,
  encryptVaultState,
  exportVaultKey,
  vaultKdfNeedsUpgrade,
  type Argon2idVaultKdfParameters,
  type Pbkdf2VaultKdfParameters
} from "./vault-crypto";

const ARGON_VECTOR: Argon2idVaultKdfParameters = {
  name: "ARGON2ID",
  iterations: 3,
  memoryKiB: 64 * 1024,
  parallelism: 1,
  salt: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
};

describe("vault key derivation", () => {
  it("matches an independent Python Argon2id v1.3 vector", async () => {
    const { key, kdf } = await deriveVaultKey("vault argon2 vector password", ARGON_VECTOR);
    expect(await exportVaultKey(key)).toBe("C7IPm6/h7sf+kCLfEmjU2YLn7bCneJerT8jAEkl6cq0=");
    expect(kdf).toEqual(ARGON_VECTOR);
    expect(vaultKdfNeedsUpgrade(kdf)).toBe(false);
  });

  it("keeps bounded PBKDF2 parameters readable only as a legacy migration source", async () => {
    const legacy: Pbkdf2VaultKdfParameters = {
      name: "PBKDF2-SHA256",
      iterations: 600_000,
      salt: ARGON_VECTOR.salt
    };
    await expect(deriveVaultKey("legacy vault password", legacy)).resolves.toMatchObject({ kdf: legacy });
    expect(vaultKdfNeedsUpgrade(legacy)).toBe(true);
  });

  it("rejects attacker-controlled Argon2 resource parameters before derivation", async () => {
    await expect(deriveVaultKey("password", { ...ARGON_VECTOR, memoryKiB: 18 * 1024 })).rejects.toThrow("KDF parameters");
    await expect(deriveVaultKey("password", { ...ARGON_VECTOR, memoryKiB: 129 * 1024 })).rejects.toThrow("KDF parameters");
    await expect(deriveVaultKey("password", { ...ARGON_VECTOR, iterations: 7 })).rejects.toThrow("KDF parameters");
    await expect(deriveVaultKey("password", { ...ARGON_VECTOR, parallelism: 5 })).rejects.toThrow("KDF parameters");
    await expect(deriveVaultKey("password", { ...ARGON_VECTOR, memoryKiB: 128 * 1024, iterations: 4 })).rejects.toThrow("KDF parameters");
    expect(vaultKdfNeedsUpgrade({ ...ARGON_VECTOR, memoryKiB: 19 * 1024, iterations: 1 })).toBe(true);
  });
});

describe("vault envelope round-trip", () => {
  it.each([false, true])('clears the encoded vault plaintext even when encryption fails (%s)', async fail => {
    const { key, kdf } = await createDeviceVaultKey();
    const state = createEmptyVaultState('2026-10-10T00:00:00.000Z');
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let captured: Uint8Array | undefined;
    const spy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (algorithm, key, data) => {
      captured = data as Uint8Array;
      if (fail) throw new Error('synthetic encryption failure');
      return encrypt(algorithm, key, data);
    });
    try {
      const operation = encryptVaultState(state, key, kdf);
      if (fail) await expect(operation).rejects.toThrow('synthetic encryption failure');
      else await expect(operation).resolves.toMatchObject({ cipher: 'AES-256-GCM' });
      expect(captured?.length).toBeGreaterThan(0);
      expect(captured?.every(value => value === 0)).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it('clears decrypted bytes after parsing without changing the returned vault', async () => {
    const { key, kdf } = await createDeviceVaultKey();
    const state = createEmptyVaultState('2026-10-10T00:00:00.000Z');
    const envelope = await encryptVaultState(state, key, kdf);
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let captured: ArrayBuffer | undefined;
    const spy = vi.spyOn(crypto.subtle, 'decrypt').mockImplementationOnce(async (...args) => { captured = await decrypt(...args); return captured; });
    try {
      expect(await decryptVaultState(envelope, key)).toMatchObject({ magic: state.magic, items: state.items });
      expect(captured?.byteLength).toBeGreaterThan(0);
      expect(new Uint8Array(captured!).every(value => value === 0)).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it("unlocks a vault holding source envelopes this build cannot parse", async () => {
    const state = createEmptyVaultState("2026-07-18T00:00:00.000Z");
    const future = {
      providerId: "provider-from-a-newer-build",
      itemId: "item-1",
      remoteId: "row-42",
      revision: "7",
      format: "some-format-this-build-has-never-heard-of",
      encoding: "cbor",
      payload: "b3BhcXVl",
      contentHash: "hash",
      extraKeyFromTheFuture: { nested: true }
    };
    state.sourceRecords = [future as never];
    state.settings.protectionMode = "device-key";

    const { key, kdf } = await createDeviceVaultKey();
    const restored = await decryptVaultState(await encryptVaultState(state, key, kdf), key);

    expect(restored.sourceRecords).toEqual([future]);
  });
});
