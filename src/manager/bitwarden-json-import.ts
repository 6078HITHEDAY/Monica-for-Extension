import type { VaultItem } from "../core/model";
import { normalizeImportedVaultItem } from "./import-items";

type JsonRecord = Record<string, unknown>;

/**
 * Converts Bitwarden's unencrypted JSON export into ordinary Monica items.
 * The export is intentionally detached from Bitwarden: imported items are
 * local records and must never inherit a provider reference or remote ID.
 */
export function isPlainBitwardenExport(value: unknown): value is JsonRecord & { items: unknown[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const root = value as JsonRecord;
  return root.encrypted === false && Array.isArray(root.items) && root.items.some(isBitwardenCipher);
}

export function importPlainBitwardenJson(value: JsonRecord): VaultItem[] {
  if (!isPlainBitwardenExport(value)) return [];
  const folders = new Map<string, string>();
  for (const folder of asArray(value.folders)) {
    const record = asRecord(folder);
    const id = text(record.id);
    const name = text(record.name).trim();
    if (id && name) folders.set(id, name);
  }

  return value.items.flatMap((entry) => {
    const raw = asRecord(entry);
    if (!isBitwardenCipher(raw)) return [];
    const normalized = normalizeImportedVaultItem(toMonicaItem(raw, folders));
    return normalized && normalized.kind !== "opaque" ? [normalized] : [];
  });
}

function isBitwardenCipher(value: unknown): value is JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as JsonRecord;
  const type = Number(raw.type);
  return Number.isInteger(type) && type >= 1 && type <= 5 && typeof raw.name === "string";
}

function toMonicaItem(raw: JsonRecord, folders: Map<string, string>): JsonRecord {
  const type = Number(raw.type);
  const now = new Date().toISOString();
  const createdAt = date(raw.creationDate, now);
  const updatedAt = date(raw.revisionDate, createdAt);
  const base: JsonRecord = {
    id: crypto.randomUUID(),
    title: text(raw.name).trim() || "未命名导入项目",
    favorite: raw.favorite === true,
    notes: text(raw.notes),
    createdAt,
    updatedAt,
    deletedAt: optionalDate(raw.deletedDate),
    categoryName: folders.get(text(raw.folderId)),
    providerRefs: []
  };

  if (type === 1) {
    const login = asRecord(raw.login);
    const uriRules = asArray(login.uris).flatMap((entry) => {
      const uri = asRecord(entry);
      const value = text(uri.uri).trim();
      return value ? [{ uri: value, matchType: matchType(uri.match) }] : [];
    });
    return {
      ...base,
      kind: "login",
      username: text(login.username),
      password: text(login.password),
      uris: uriRules.map((rule) => rule.uri),
      uriRules,
      totpSecret: optional(login.totp),
      customFields: customFields(raw.fields),
      ...sshMetadata(login)
    };
  }

  if (type === 2) {
    return { ...base, kind: "secure-note", content: text(raw.notes), customFields: customFields(raw.fields) };
  }

  if (type === 3) {
    const card = asRecord(raw.card);
    return {
      ...base,
      kind: "card",
      cardholderName: text(card.cardholderName),
      number: text(card.number),
      expiryMonth: text(card.expMonth),
      expiryYear: text(card.expYear),
      securityCode: text(card.code),
      brand: optional(card.brand),
      cardType: "CREDIT",
      customFields: customFields(raw.fields)
    };
  }

  if (type === 4) {
    const identity = asRecord(raw.identity);
    const passportNumber = optional(identity.passportNumber);
    const licenseNumber = optional(identity.licenseNumber);
    const ssn = optional(identity.ssn);
    const firstName = text(identity.firstName);
    const middleName = text(identity.middleName);
    const lastName = text(identity.lastName);
    const fullName = [firstName, middleName, lastName].filter(Boolean).join(" ");
    return {
      ...base,
      kind: "identity",
      documentType: passportNumber ? "PASSPORT" : licenseNumber ? "DRIVER_LICENSE" : ssn ? "SOCIAL_SECURITY" : "OTHER",
      documentNumber: passportNumber || licenseNumber || ssn || "",
      firstName,
      middleName,
      lastName,
      fullName,
      documentTitle: optional(identity.title),
      company: optional(identity.company),
      username: optional(identity.username),
      email: optional(identity.email),
      phone: optional(identity.phone),
      ssn,
      passportNumber,
      licenseNumber,
      address: {
        fullName,
        company: text(identity.company),
        streetAddress: text(identity.address1),
        apartment: text(identity.address2),
        city: text(identity.city),
        stateProvince: text(identity.state),
        postalCode: text(identity.postalCode),
        country: text(identity.country),
        phone: text(identity.phone),
        email: text(identity.email)
      },
      customFields: customFields(raw.fields)
    };
  }

  const ssh = asRecord(raw.sshKey || raw.SshKey);
  return {
    ...base,
    kind: "login",
    username: "",
    password: "",
    uris: [],
    uriRules: [],
    customFields: customFields(raw.fields),
    loginType: "SSH_KEY",
    sshKeyData: JSON.stringify({
      algorithm: inferSshAlgorithm(text(ssh.publicKey)),
      keySize: 0,
      publicKeyOpenSsh: text(ssh.publicKey),
      privateKeyOpenSsh: text(ssh.privateKey),
      fingerprintSha256: text(ssh.keyFingerprint || ssh.fingerprint),
      comment: "",
      format: "OPENSSH"
    })
  };
}

function customFields(value: unknown): JsonRecord[] {
  return asArray(value).flatMap((entry) => {
    const field = asRecord(entry);
    const name = text(field.name).trim() || "未命名字段";
    const type = Number(field.type);
    return [{ name, value: text(field.value), protected: type === 1, ...(type === 2 ? { fieldType: "BOOLEAN" } : {}) }];
  });
}

function sshMetadata(login: JsonRecord): JsonRecord {
  const ssh = asRecord(login.sshKey);
  if (!Object.keys(ssh).length) return {};
  return {
    loginType: "SSH_KEY",
    sshKeyData: JSON.stringify({
      algorithm: inferSshAlgorithm(text(ssh.publicKey)),
      keySize: 0,
      publicKeyOpenSsh: text(ssh.publicKey),
      privateKeyOpenSsh: text(ssh.privateKey),
      fingerprintSha256: text(ssh.keyFingerprint || ssh.fingerprint),
      comment: "",
      format: "OPENSSH"
    })
  };
}

function inferSshAlgorithm(publicKey: string): string {
  const prefix = publicKey.trim().split(/\s+/, 1)[0];
  return prefix === "ssh-rsa" ? "RSA" : prefix === "ssh-ed25519" ? "ED25519" : prefix.startsWith("ecdsa-") ? "ECDSA" : "UNKNOWN";
}

function matchType(value: unknown): string {
  return ({ 0: "base-domain", 1: "domain", 2: "starts-with", 3: "exact", 4: "regex", 5: "never" } as Record<number, string>)[Number(value)] || "base-domain";
}

function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function asRecord(value: unknown): JsonRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function text(value: unknown): string { return value == null ? "" : typeof value === "string" ? value : String(value); }
function optional(value: unknown): string | undefined { const result = text(value); return result ? result : undefined; }
function date(value: unknown, fallback: string): string { const parsed = Date.parse(text(value)); return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString(); }
function optionalDate(value: unknown): string | undefined { const result = date(value, ""); return result || undefined; }
