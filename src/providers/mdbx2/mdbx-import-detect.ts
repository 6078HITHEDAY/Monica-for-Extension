import { detectKeePassContainerFormat } from "../keepass/keepass-format";
import {
  MDBX3_RUNTIME_NAME,
  type MdbxImportableFormatVersion,
  type MdbxInspectedUnlockMethod,
  type Mdbx2UnlockMethod,
  type Mdbx2VaultInspection
} from "./native-contract";

export type MdbxImportKind =
  | "plugin-backup-json"
  | "mdbx-vault"
  | "mdbx-complete-backup-zip"
  | "android-project-zip"
  | "kdbx"
  | "unknown";

export interface MdbxImportSniff {
  kind: MdbxImportKind;
  runtimeName: typeof MDBX3_RUNTIME_NAME;
  formatVersion?: MdbxImportableFormatVersion;
  requiresMigration: boolean;
  unlockMethods: MdbxInspectedUnlockMethod[];
  portableUnlockAvailable: boolean;
  needsPasswordPrompt: boolean;
  needsSecurityKey: boolean;
  pinOnly: boolean;
  incompatibilityReason?: string;
}

const SQLITE_HEADER = "SQLite format 3\0";
const COMPLETE_BLOB = /^vault\.mdbx\.blobs\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/;
const ANDROID_FOLDER = /(^|\/)folders\/.+\/(passwords|notes|bank_cards|passkeys|authenticators|documents|billing_addresses|payment_accounts)\//;

export function sniffMdbxImportFile(bytes: Uint8Array): MdbxImportSniff {
  return classifyImport(bytes, listZipEntryNames(bytes));
}

export async function sniffMdbxImportBlob(file: Blob): Promise<MdbxImportSniff> {
  const head = new Uint8Array(await file.slice(0, Math.min(64, file.size)).arrayBuffer());
  if (isSqliteHeader(head)) return baseSniff("mdbx-vault");
  if (isZipHeader(head)) return classifyImport(head, await listZipEntryNamesFromBlob(file));
  const keepass = detectKeePassContainerFormat(head, file instanceof File ? file.name : undefined);
  if (keepass === "kdbx") return { ...baseSniff("kdbx"), needsPasswordPrompt: true };
  if (keepass === "kdb-legacy") return { ...baseSniff("unknown"), incompatibilityReason: "kdb-legacy" };
  if (file.size > 64 * 1024 * 1024) {
    return { ...baseSniff("unknown"), incompatibilityReason: "unknown" };
  }
  return sniffMdbxImportFile(new Uint8Array(await file.arrayBuffer()));
}

function classifyImport(bytes: Uint8Array, zipNames: string[] | undefined): MdbxImportSniff {
  if (isSqliteHeader(bytes)) return baseSniff("mdbx-vault");
  if (isZipHeader(bytes)) {
    if (zipNames && isCompleteBackupLayout(zipNames)) return baseSniff("mdbx-complete-backup-zip");
    if (zipNames && isAndroidProjectLayout(zipNames)) {
      return { ...baseSniff("android-project-zip"), incompatibilityReason: "android-project-zip" };
    }
    return { ...baseSniff("unknown"), incompatibilityReason: "unknown" };
  }
  const json = tryParseJsonObject(bytes);
  if (json?.magic === "MONICA_EXTENSION_BACKUP") {
    return { ...baseSniff("plugin-backup-json"), needsPasswordPrompt: true };
  }
  const keepass = detectKeePassContainerFormat(bytes);
  if (keepass === "kdbx") return { ...baseSniff("kdbx"), needsPasswordPrompt: true };
  if (keepass === "kdb-legacy") return { ...baseSniff("unknown"), incompatibilityReason: "kdb-legacy" };
  return { ...baseSniff("unknown"), incompatibilityReason: "unknown" };
}

export function mergeMdbxImportInspection(sniff: MdbxImportSniff, inspection: Mdbx2VaultInspection): MdbxImportSniff {
  const unlockMethods = inspection.unlockMethods;
  const handshake = handshakeUnlock(unlockMethods);
  const pinOnly = handshake.pinOnly;
  return {
    ...sniff,
    kind: sniff.kind === "mdbx-complete-backup-zip" ? "mdbx-complete-backup-zip" : "mdbx-vault",
    formatVersion: inspection.formatVersion,
    requiresMigration: inspection.requiresUpgrade,
    unlockMethods,
    portableUnlockAvailable: inspection.portableUnlockAvailable,
    needsPasswordPrompt: handshake.password || unlockMethods.length === 0,
    needsSecurityKey: handshake.securityKey,
    pinOnly,
    incompatibilityReason: pinOnly ? "vault-unlock-not-portable" : undefined
  };
}

export function handshakeUnlock(methods: readonly MdbxInspectedUnlockMethod[]): {
  password: boolean;
  securityKey: boolean;
  pinOnly: boolean;
} {
  const password = methods.includes("password") || methods.includes("password-security-key");
  const securityKey = methods.includes("security-key") || methods.includes("password-security-key");
  return {
    password,
    securityKey,
    pinOnly: methods.includes("pin") && !password && !securityKey
  };
}

export function advertisedUnlockMethods(methods: readonly MdbxInspectedUnlockMethod[]): Mdbx2UnlockMethod[] {
  return (["password", "security-key", "password-security-key"] as const).filter((method) => methods.includes(method));
}

export function resolveImportUnlockMethod(
  methods: readonly MdbxInspectedUnlockMethod[],
  selected?: Mdbx2UnlockMethod
): Mdbx2UnlockMethod {
  const available = advertisedUnlockMethods(methods);
  if (selected && (available.length === 0 || available.includes(selected))) return selected;
  return available[0] || "password";
}

function baseSniff(kind: MdbxImportKind): MdbxImportSniff {
  const mdbx = kind === "mdbx-vault" || kind === "mdbx-complete-backup-zip";
  return {
    kind,
    runtimeName: MDBX3_RUNTIME_NAME,
    requiresMigration: false,
    unlockMethods: [],
    portableUnlockAvailable: false,
    needsPasswordPrompt: mdbx,
    needsSecurityKey: false,
    pinOnly: false
  };
}

function isSqliteHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  for (let index = 0; index < 16; index += 1) {
    if (bytes[index] !== SQLITE_HEADER.charCodeAt(index)) return false;
  }
  return true;
}

function isZipHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) && (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08);
}

function isCompleteBackupLayout(names: string[]): boolean {
  const files = normalizeZipNames(names).filter((name) => !name.endsWith("/"));
  if (!files.includes("vault.mdbx")) return false;
  return files.every((name) => name === "vault.mdbx" || COMPLETE_BLOB.test(name));
}

function isAndroidProjectLayout(names: string[]): boolean {
  const files = normalizeZipNames(names);
  if (files.some((name) => name === "vault.mdbx" || name.startsWith("vault.mdbx.blobs/"))) return false;
  return files.some((name) => name === "trash/trash_passwords.json" || ANDROID_FOLDER.test(name) || /(^|\/)folders\//.test(name) && /password_/i.test(name));
}

function normalizeZipNames(names: string[]): string[] {
  return names.map((name) => name.replace(/\\/g, "/").replace(/^\.\//, ""));
}

function tryParseJsonObject(bytes: Uint8Array): Record<string, unknown> | undefined {
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  while (start < bytes.length && (bytes[start] === 0x20 || bytes[start] === 0x09 || bytes[start] === 0x0a || bytes[start] === 0x0d)) start += 1;
  if (bytes[start] !== 0x7b) return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start));
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

async function listZipEntryNamesFromBlob(file: Blob): Promise<string[] | undefined> {
  const tailSize = Math.min(file.size, 65_557);
  const tail = new Uint8Array(await file.slice(file.size - tailSize, file.size).arrayBuffer());
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) return undefined;
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) return undefined;
  const eocdAbsolute = file.size - tailSize + eocd;
  if (centralOffset + centralSize !== eocdAbsolute) return undefined;
  const central = new Uint8Array(await file.slice(centralOffset, eocdAbsolute).arrayBuffer());
  return listZipEntryNamesFromCentral(central, entryCount);
}

function listZipEntryNames(bytes: Uint8Array): string[] | undefined {
  if (bytes.length < 22) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) return undefined;
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) return undefined;
  if (centralOffset + centralSize > eocd) return undefined;
  return listZipEntryNamesFromCentral(bytes.subarray(centralOffset, eocd), entryCount);
}

function listZipEntryNamesFromCentral(bytes: Uint8Array, entryCount: number): string[] | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const names: string[] = [];
  let cursor = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) return undefined;
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > bytes.length || nameLength === 0) return undefined;
    try {
      names.push(decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)));
    } catch {
      return undefined;
    }
    cursor = next;
  }
  return names;
}

function findEndOfCentralDirectory(view: DataView): number {
  const min = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= min; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}
