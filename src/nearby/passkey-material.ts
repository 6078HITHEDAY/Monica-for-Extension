import { cloneLosslessJson, jsonNumber } from "../core/lossless-json";
import { parsePortablePasskeyPrivateKey, portablePasskeyKeyMatchesAlgorithm, passkeyKeyMaterialHint } from "../passkey/private-key-portability";
import { normalizeCredentialId } from "../passkey/source-policy";
import { bytesToBase64 } from "../security/encoding";
import { invalidNearby, validateNearbyPasskeyMetadata, wireInteger, wireText } from "./wire-shape";

function parameters(algorithm: number): EcKeyImportParams | RsaHashedImportParams | Algorithm {
  if (algorithm === -7) return { name: "ECDSA", namedCurve: "P-256" };
  if (algorithm === -8) return { name: "Ed25519" };
  if (algorithm === -257 || algorithm === -37) return { name: algorithm === -37 ? "RSA-PSS" : "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  return invalidNearby("passkey-algorithm");
}
function signing(algorithm: number): EcdsaParams | RsaPssParams | Algorithm {
  return algorithm === -7 ? { name: "ECDSA", hash: "SHA-256" } : algorithm === -37 ? { name: "RSA-PSS", saltLength: 32 } : { name: algorithm === -8 ? "Ed25519" : "RSASSA-PKCS1-v1_5" };
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length > 32 * 1024) invalidNearby("passkey-encoding");
  try { return Uint8Array.from(atob(normalized), c => c.charCodeAt(0)); } catch { return invalidNearby("passkey-encoding"); }
}
const url = (bytes: Uint8Array) => bytesToBase64(bytes).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

/** A bounded COSE key reader, not a general CBOR decoder. Public key labels are
 * integer keys and integer/byte-string values. Duplicate labels are rejected. */
function cose(bytes: Uint8Array, algorithm: number): JsonWebKey {
  let offset = 0;
  const item = (): number | Uint8Array => {
    if (offset >= bytes.length) invalidNearby("passkey-cose");
    const byte = bytes[offset++]; const major = byte >> 5; let length = byte & 31;
    if (length >= 24) {
      const count = length === 24 ? 1 : length === 25 ? 2 : length === 26 ? 4 : 0;
      if (!count || offset + count > bytes.length) invalidNearby("passkey-cose");
      length = 0; for (let i = 0; i < count; i++) length = length * 256 + bytes[offset++];
    }
    if (major === 0) return length;
    if (major === 1) return -1 - length;
    if (major !== 2 || length > 8192 || offset + length > bytes.length) invalidNearby("passkey-cose");
    const result = bytes.subarray(offset, offset + length); offset += length; return result;
  };
  const header = bytes[offset++];
  if (header < 0xa1 || header > 0xb0) invalidNearby("passkey-cose");
  const map = new Map<number, number | Uint8Array>();
  for (let i = 0; i < (header & 31); i++) {
    const label = item(); if (typeof label !== "number" || map.has(label)) invalidNearby("passkey-cose");
    map.set(label, item());
  }
  if (offset !== bytes.length || map.get(3) !== algorithm) invalidNearby("passkey-cose");
  const binary = (label: number, expected?: number) => { const value = map.get(label); if (!(value instanceof Uint8Array) || !value.length || expected !== undefined && value.length !== expected) invalidNearby("passkey-cose"); return url(value); };
  if (algorithm === -7 && map.get(1) === 2 && map.get(-1) === 1) return { kty: "EC", crv: "P-256", x: binary(-2, 32), y: binary(-3, 32) };
  if (algorithm === -8 && map.get(1) === 1 && map.get(-1) === 6) return { kty: "OKP", crv: "Ed25519", x: binary(-2, 32) };
  if ((algorithm === -257 || algorithm === -37) && map.get(1) === 3) return { kty: "RSA", n: binary(-1), e: binary(-2) };
  return invalidNearby("passkey-cose");
}

async function publicKey(value: string, algorithm: number): Promise<CryptoKey> {
  const bytes = decode(value);
  try {
    return bytes[0] === 0x30
      ? await crypto.subtle.importKey("spki", bytes, parameters(algorithm), true, ["verify"])
      : await crypto.subtle.importKey("jwk", cose(bytes, algorithm), parameters(algorithm), true, ["verify"]);
  } finally { bytes.fill(0); }
}
async function signatureMatches(material: string, publicMaterial: string, algorithm: number): Promise<void> {
  const parsed = parsePortablePasskeyPrivateKey(material);
  if (!portablePasskeyKeyMatchesAlgorithm(parsed, algorithm)) invalidNearby("passkey-private-key");
  const bytes = decode(parsed.pkcs8Base64); const challenge = crypto.getRandomValues(new Uint8Array(32)); let signature: Uint8Array<ArrayBuffer> | undefined;
  try {
    const privateKey = await crypto.subtle.importKey("pkcs8", bytes, parameters(algorithm), false, ["sign"]);
    signature = new Uint8Array(await crypto.subtle.sign(signing(algorithm), privateKey, challenge));
    if (!await crypto.subtle.verify(signing(algorithm), await publicKey(publicMaterial, algorithm), signature, challenge)) invalidNearby("passkey-public-mismatch");
  } catch { invalidNearby("passkey-key-verification"); }
  finally { bytes.fill(0); challenge.fill(0); signature?.fill(0); }
}
async function derivedPublic(material: string, algorithm: number): Promise<string> {
  const parsed = parsePortablePasskeyPrivateKey(material);
  if (!portablePasskeyKeyMatchesAlgorithm(parsed, algorithm)) invalidNearby("passkey-private-key");
  const bytes = decode(parsed.pkcs8Base64);
  try {
    // Only needed for a legacy missing public cache. Keep the original PKCS8;
    // import/export here derives a public cache and never generates a new key.
    const privateKey = await crypto.subtle.importKey("pkcs8", bytes, parameters(algorithm), true, ["sign"]);
    const jwk = await crypto.subtle.exportKey("jwk", privateKey);
    const publicJwk: JsonWebKey = { kty: jwk.kty, ...(jwk.kty === "RSA" ? { n: jwk.n, e: jwk.e } : { crv: jwk.crv, x: jwk.x, ...(jwk.kty === "EC" ? { y: jwk.y } : {}) }) };
    for (const name of ["d", "p", "q", "dp", "dq", "qi", "oth"] as const) delete jwk[name];
    const key = await crypto.subtle.importKey("jwk", publicJwk, parameters(algorithm), true, ["verify"]);
    return bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("spki", key)));
  } catch { return invalidNearby("passkey-public-derivation"); }
  finally { bytes.fill(0); }
}

/** Validates an outgoing copy without mutating storage. Device references are
 * removed only from this copy; a missing/corrupt declared portable key is fatal. */
export async function prepareNearbyPasskey(source: Record<string, unknown>, referenceOnly = false): Promise<Record<string, unknown>> {
  const result = cloneLosslessJson(source); const algorithm = result.public_key_algorithm as number;
  parameters(algorithm);
  const original = wireText(result.private_key_alias ?? "");
  if (referenceOnly) {
    // Consent to metadata transfer cannot turn a corrupt portable key into a
    // successful reference record. Only explicit empty metadata or a recognized
    // non-exportable device reference may take this path.
    if (result.key_status === 'portable' || (original ? passkeyKeyMaterialHint(original) !== 'device-reference' : result.key_status !== 'reference')) invalidNearby('passkey-reference-source');
    result.private_key_alias = ""; result.key_status = "reference";
  }
  else {
    const material = parsePortablePasskeyPrivateKey(original);
    if (!portablePasskeyKeyMatchesAlgorithm(material, algorithm)) invalidNearby("passkey-private-key");
    // Android's wire decoder expects standard base64. DER bytes are unchanged.
    result.private_key_alias = material.pkcs8Base64; result.key_status = "portable";
    if (!wireText(result.public_key ?? "").trim()) result.public_key = await derivedPublic(original, algorithm);
  }
  validateNearbyPasskeyMetadata(result);
  await verifyNearbyPasskey(result);
  return result;
}

export async function verifyNearbyPasskey(payload: Record<string, unknown>): Promise<void> {
  validateNearbyPasskeyMetadata(payload);
  const key = wireText(payload.private_key_alias); const algorithm = payload.public_key_algorithm as number;
  try {
    await publicKey(wireText(payload.public_key), algorithm);
    if (payload.key_status === "reference") { if (key) invalidNearby("passkey-reference-has-key"); }
    else { if (!key) invalidNearby("passkey-portable-key-missing"); await signatureMatches(key, wireText(payload.public_key), algorithm); }
  } catch { invalidNearby("passkey-key-verification"); }
}

/** Merge proof covers both identities and public keys. Metadata-only input can
 * never erase the local private key, reduce its counter, or change known BE. */
export async function retainNearbyPasskey(incoming: Record<string, unknown>, previous: Record<string, unknown>): Promise<Record<string, unknown>> {
  await verifyNearbyPasskey(incoming);
  const old = await prepareNearbyPasskey(previous, previous.key_status === "reference");
  const result = cloneLosslessJson(incoming);
  const algorithm = incoming.public_key_algorithm as number;
  if (old.public_key_algorithm !== algorithm || normalizeCredentialId(wireText(old.credential_id)) !== normalizeCredentialId(wireText(incoming.credential_id)) || wireText(old.rp_id).toLowerCase() !== wireText(incoming.rp_id).toLowerCase()) invalidNearby("passkey-identity-conflict");
  if (normalizeCredentialId(wireText(old.user_id)) !== normalizeCredentialId(wireText(incoming.user_id))) invalidNearby('passkey-user-conflict');
  const left = new Uint8Array(await crypto.subtle.exportKey("spki", await publicKey(wireText(old.public_key), algorithm)));
  const right = new Uint8Array(await crypto.subtle.exportKey("spki", await publicKey(wireText(incoming.public_key), algorithm)));
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) invalidNearby("passkey-public-conflict");
  if (incoming.backup_eligible != null && incoming.backup_eligible !== (old.backup_eligible !== false)) invalidNearby("passkey-backup-conflict");
  for (const field of ["backup_eligible", "backup_state"]) if (result[field] == null && old[field] != null) result[field] = old[field];
  const before = wireInteger(old.sign_count ?? 0), after = wireInteger(incoming.sign_count ?? 0);
  result.sign_count = jsonNumber((before > after ? before : after).toString());
  // For the same key, retain exact local key representation and identity strings.
  if (old.key_status === "portable") { result.private_key_alias = previous.private_key_alias; result.key_status = "portable"; }
  else if (incoming.key_status === 'reference') result.private_key_alias = previous.private_key_alias;
  result.credential_id = previous.credential_id; result.rp_id = previous.rp_id; result.user_id = previous.user_id;
  // The retained value is local storage data and may contain a device alias.
  // Verify its outgoing projection so the alias never enters the wire payload.
  await prepareNearbyPasskey(result, result.key_status === 'reference');
  return result;
}
