import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { handshakeUnlock, mergeMdbxImportInspection, sniffMdbxImportFile } from "./mdbx-import-detect";

function sqliteBytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  new TextEncoder().encodeInto("SQLite format 3\0", bytes);
  return bytes;
}

describe("sniffMdbxImportFile", () => {
  it("classifies plugin backups, sqlite vaults, complete backups, android zips and unknown files", () => {
    expect(sniffMdbxImportFile(strToU8(JSON.stringify({ magic: "MONICA_EXTENSION_BACKUP", version: 1 })))).toMatchObject({
      kind: "plugin-backup-json",
      runtimeName: "MDBX3",
      needsPasswordPrompt: true
    });
    expect(sniffMdbxImportFile(sqliteBytes())).toMatchObject({ kind: "mdbx-vault", runtimeName: "MDBX3", needsPasswordPrompt: true });
    const complete = zipSync({
      "vault.mdbx": sqliteBytes(),
      [`vault.mdbx.blobs/aa/aa/${"a".repeat(64)}`]: new Uint8Array([1])
    });
    expect(sniffMdbxImportFile(complete)).toMatchObject({ kind: "mdbx-complete-backup-zip" });
    const android = zipSync({
      "folders/_root/passwords/password_1_1.json": strToU8("{}"),
      "trash/trash_passwords.json": strToU8("[]")
    });
    expect(sniffMdbxImportFile(android)).toMatchObject({
      kind: "android-project-zip",
      incompatibilityReason: "android-project-zip"
    });
    expect(sniffMdbxImportFile(strToU8("not a vault"))).toMatchObject({
      kind: "unknown",
      incompatibilityReason: "unknown"
    });
    expect(sniffMdbxImportFile(Uint8Array.of(0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5, 0x00, 0x00, 0x04, 0x00))).toMatchObject({
      kind: "kdbx",
      needsPasswordPrompt: true
    });
    expect(sniffMdbxImportFile(Uint8Array.of(0x03, 0xd9, 0xa2, 0x9a, 0x65, 0xfb, 0x4b, 0xb5))).toMatchObject({
      incompatibilityReason: "kdb-legacy"
    });
  });

  it("treats PIN-only unlock as non-handshake portable", () => {
    expect(handshakeUnlock(["pin"])).toEqual({ password: false, securityKey: false, pinOnly: true });
    expect(handshakeUnlock(["password", "pin"])).toEqual({ password: true, securityKey: false, pinOnly: false });
  });

  it("keeps empty unlock methods importable and PIN-only blocked", () => {
    const sqlite = sniffMdbxImportFile(sqliteBytes());
    const empty = mergeMdbxImportInspection(sqlite, {
      source: { kind: "file", handle: "11111111-1111-4111-8111-111111111111" },
      initialized: true,
      formatVersion: "MDBX-1",
      requiresUpgrade: true,
      unknownCriticalExtensions: false,
      targetFormatVersion: "MDBX-2",
      targetSchemaVersion: 17,
      unlockMethods: [],
      portableUnlockAvailable: false
    });
    expect(empty).toMatchObject({ kind: "mdbx-vault", needsPasswordPrompt: true, pinOnly: false });
    expect(empty.incompatibilityReason).toBeUndefined();
    const zip = sniffMdbxImportFile(zipSync({
      "vault.mdbx": sqliteBytes(),
      [`vault.mdbx.blobs/aa/aa/${"a".repeat(64)}`]: new Uint8Array([1])
    }));
    expect(mergeMdbxImportInspection(zip, {
      source: { kind: "file", handle: "11111111-1111-4111-8111-111111111111" },
      initialized: true,
      formatVersion: "MDBX-2",
      requiresUpgrade: false,
      unknownCriticalExtensions: false,
      targetFormatVersion: "MDBX-2",
      targetSchemaVersion: 17,
      unlockMethods: ["password"],
      portableUnlockAvailable: true
    }).kind).toBe("mdbx-complete-backup-zip");
    expect(mergeMdbxImportInspection(sqlite, {
      source: { kind: "file", handle: "11111111-1111-4111-8111-111111111111" },
      initialized: true,
      formatVersion: "MDBX-1",
      requiresUpgrade: true,
      unknownCriticalExtensions: false,
      targetFormatVersion: "MDBX-2",
      targetSchemaVersion: 17,
      unlockMethods: ["pin"],
      portableUnlockAvailable: true
    }).incompatibilityReason).toBe("vault-unlock-not-portable");
  });
});
