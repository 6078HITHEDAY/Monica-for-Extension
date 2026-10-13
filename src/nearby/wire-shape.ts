import { cloneLosslessJson, jsonScalarText, parseLosslessJson } from "../core/lossless-json";

export const NEARBY_ENTRY_TYPES = ["login", "ssh-key", "totp", "note", "card", "document-ref", "identity", "billing-address", "payment-account", "passkey", "api-token", "steam-mafile", "folder", "vault-metadata"] as const;
export type NearbyEntryType = typeof NEARBY_ENTRY_TYPES[number];
export interface NearbyWireData extends Record<string, unknown> { title: string; folder: string; entry_type: NearbyEntryType }
export const PASSWORD_FIELDS = ["website", "username", "password_plain", "notes", "app_package_name", "app_name", "authenticator_key", "ssh_key_data", "wifi_metadata", "email", "phone", "address_line", "city", "state", "zip_code", "country", "credit_card_number_plain", "credit_card_holder", "credit_card_expiry", "credit_card_cvv_plain", "sso_provider"] as const;
export const LOCAL_FIELDS = ["room_id", "roomId", "id", "monica_entry_id", "category_id", "categoryId", "mdbx_folder_id", "mdbxFolderId", "mdbx_database_id", "mdbxDatabaseId", "bitwarden_mode", "keepass_mode", "bitwarden_vault_id", "bitwarden_cipher_id", "bitwarden_folder_id", "bitwarden_revision_date", "bitwarden_local_modified", "bitwardenVaultId", "bitwardenCipherId", "keepassDatabaseId", "keepassGroupPath", "storagePath", "device_sync_assets", "device_sync_images", "monica_password_encoding", "device_sync_pending_relations", "device_sync_key_projection"] as const;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export class NearbyDataError extends Error {
  constructor(readonly code: string) { super(`Nearby data: ${code}.`); this.name = "NearbyDataError"; }
}
export function invalidNearby(code: string): never { throw new NearbyDataError(code); }
export function wireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || (JSON as typeof JSON & { isRawJSON?: (v: unknown) => boolean }).isRawJSON?.(value)) invalidNearby("object-required");
  return value as Record<string, unknown>;
}
export function wireText(value: unknown): string { if (typeof value !== "string") invalidNearby("text-required"); return value; }
export function wireInteger(value: unknown, max = 9223372036854775807n, min = 0n): bigint {
  if (typeof value !== 'number' && !(JSON as typeof JSON & { isRawJSON?: (value: unknown) => boolean }).isRawJSON?.(value)) invalidNearby('integer-required');
  const text = jsonScalarText(value);
  if (!/^-?(?:0|[1-9]\d*)$/.test(text) || typeof value === "number" && !Number.isSafeInteger(value)) invalidNearby("integer-required");
  const result = BigInt(text); if (result > max || result < min) invalidNearby("integer-limit"); return result;
}
const objects = (value: unknown, max = 8192): Record<string, unknown>[] => {
  if (!Array.isArray(value) || value.length > max) invalidNearby("array-limit");
  return value.map(wireObject);
};
function folderPath(value: unknown, allowEmpty = false): void {
  const nodes = objects(value, 128); const seen = new Set<string>();
  if (!allowEmpty && !nodes.length) invalidNearby("empty-folder-path");
  for (const node of nodes) {
    const id = wireText(node.id); const title = wireText(node.title);
    if (!uuid.test(id) || seen.has(id) || title.length > 4096) invalidNearby("invalid-folder-path");
    seen.add(id);
    if (node.parent != null && (!uuid.test(wireText(node.parent)) || node.parent === id)) invalidNearby("invalid-folder-parent");
  }
}
export function validateNearbyPasskeyMetadata(payload: Record<string, unknown>): void {
  for (const field of ["credential_id", "rp_id", "user_id", "public_key", "private_key_alias", "key_status"]) wireText(payload[field]);
  for (const field of ["credential_id", "rp_id", "public_key"]) if (!(payload[field] as string).trim()) invalidNearby("passkey-identity-missing");
  if (![-7, -257, -37, -8].includes(payload.public_key_algorithm as number)) invalidNearby("passkey-algorithm");
  if (!["portable", "reference"].includes(payload.key_status as string)) invalidNearby("passkey-key-status");
  for (const field of ["backup_eligible", "backup_state"]) if (payload[field] != null && typeof payload[field] !== "boolean") invalidNearby("passkey-backup-flag");
  if (payload.backup_eligible === false && payload.backup_state === true) invalidNearby("passkey-backup-flag");
  if (own(payload, "sign_count")) wireInteger(payload.sign_count);
}

/** Current Android DeviceVaultShape contract, with unknown fields retained. Key
 * possession and source/session authorization are checked by the caller. */
export function validateNearbyWireData(input: unknown): asserts input is NearbyWireData {
  const data = wireObject(input);
  if (!NEARBY_ENTRY_TYPES.includes(data.entry_type as NearbyEntryType)) invalidNearby("entry-type");
  if (wireText(data.title).length > 4096 || wireText(data.folder).length > 4096) invalidNearby("label-limit");
  if (new TextEncoder().encode(JSON.stringify(data)).length > 1024 * 1024) invalidNearby("record-limit");
  if (data.entry_type === "login" || data.entry_type === "ssh-key") {
    for (const field of PASSWORD_FIELDS) wireText(data[field]);
    wireText(data.login_type);
    if (typeof data.is_archived !== "boolean") invalidNearby("archive-flag");
    if (data.archived_at != null) wireInteger(data.archived_at, 253402300799999n);
    for (const field of objects(data.custom_fields, 1024)) {
      wireText(field.title); wireText(field.value);
      if (typeof field.is_protected !== "boolean") invalidNearby("custom-field-protection");
    }
    if (data.extensions != null) wireObject(data.extensions);
  } else {
    const payload = wireObject(data.payload);
    if (!Object.keys(payload).length) invalidNearby("empty-payload");
    if (["note", "totp", "card", "document-ref", "billing-address", "payment-account"].includes(data.entry_type as string)) wireText(payload.item_data);
    if (data.entry_type === "passkey") validateNearbyPasskeyMetadata(payload);
    if (data.entry_type === "steam-mafile") { if (!wireText(payload.mafile_json).trim()) invalidNearby("steam-mafile-missing"); }
    if (data.entry_type === "folder") folderPath(payload.path);
    if (data.entry_type === "vault-metadata" && !Array.isArray(payload.tags)) invalidNearby("tags-required");
    if (["folder", "vault-metadata"].includes(data.entry_type as string) && own(payload, "tags")) for (const tag of objects(payload.tags)) {
      wireText(tag.name); wireText(tag.payload); wireInteger(tag.version, 0xffff_ffffn);
    }
  }
  if (own(data, "folder_path")) folderPath(data.folder_path, true);
  if (own(data, "assets")) for (const asset of objects(data.assets)) {
    for (const field of ["id", "file_name", "media_type"]) wireText(asset[field]);
    if (!/^[a-f0-9]{64}$/i.test(asset.id as string)) invalidNearby("asset-id");
    wireInteger(asset.size, 64n * 1024n * 1024n);
  }
  for (const field of ["labels", "relations"]) if (own(data, field)) for (const item of objects(data[field])) {
    wireText(item[field === "labels" ? "name" : "target"]); wireText(item.payload); wireInteger(item.version, 0xffff_ffffn);
    if (field === "relations") wireText(item.kind);
  }
  if (own(data, "password_history")) for (const row of objects(data.password_history)) wireText(row.password);
  if (own(data, "trashed") && typeof data.trashed !== "boolean") invalidNearby("trash-flag");
}

const camel = (name: string) => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
function first(payload: Record<string, unknown>, names: string[]): unknown { for (const name of names) if (own(payload, name)) return payload[name]; return undefined; }

function timestamp(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value !== 'string') { wireInteger(value, 253402300799999n); return value; }
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > 253402300799999) invalidNearby('invalid-timestamp');
  return result;
}

/** Unwrap the legacy desktop shape consumed by current Android. Unknown
 * business fields stay in the payload; platform-local routing is stripped by
 * normalization below. This function does not decrypt installation ciphertext. */
export function nearbyNativeBusinessPayload(source: Record<string, unknown>, type: NearbyEntryType): Record<string, unknown> {
  const payload = cloneLosslessJson(source);
  if (!own(payload, 'data')) return payload;
  const envelope = wireObject(payload.data);
  if (type === 'login' || type === 'ssh-key') {
    const entry = envelope.entry == null ? (own(envelope, 'id') ? envelope : undefined) : wireObject(envelope.entry);
    if (!entry) return payload;
    if (!['password', 'password_plain', 'username', 'website'].some(name => own(entry, name))) invalidNearby('invalid-legacy-password');
    const result = cloneLosslessJson(entry);
    const rawType = entry.loginType;
    const loginType = rawType == null ? 'PASSWORD' : typeof rawType === 'number'
      ? ['PASSWORD', 'API_KEY', 'SSO', 'WIFI', 'SSH_KEY', 'BARCODE'][rawType]
      : typeof rawType === 'string' ? ({ APIKEY: 'API_KEY', SSHKEY: 'SSH_KEY' }[rawType.toUpperCase()] ?? rawType.toUpperCase()) : undefined;
    if (!loginType) invalidNearby('invalid-login-type');
    Object.assign(result, { kind: 'password', login_type: loginType, is_archived: entry.isArchived ?? false,
      archived_at: timestamp(entry.archivedAt), custom_fields: envelope.customFields ?? entry.customFields ?? [] });
    for (const [from, to] of [['passwordHistory', 'password_history'], ['attachments', 'attachments']] as const) if (own(envelope, from)) result[to] = envelope[from];
    if (own(payload, 'monica_password_encoding')) result.monica_password_encoding = payload.monica_password_encoding;
    return result;
  }
  const result = cloneLosslessJson(wireObject(envelope.item ?? envelope));
  result.kind = ({ card: 'bank_card', 'document-ref': 'document', identity: 'document', 'billing-address': 'billing_address', 'payment-account': 'payment_account' } as Record<string, string>)[type] ?? type;
  for (const [from, to] of [['itemData', 'item_data'], ['imagePaths', 'image_paths'], ['sortOrder', 'sort_order'], ['isFavorite', 'is_favorite']] as const) {
    if (own(result, from)) { result[to] = result[from]; delete result[from]; }
  }
  for (const [from, to] of [['createdAt', 'created_at'], ['updatedAt', 'updated_at']] as const) {
    if (typeof result[from] === 'string') { result[to] = timestamp(result[from]); delete result[from]; }
  }
  return result;
}

/** Input must already be decrypted native business content. This does not decrypt
 * a platform-local ciphertext or infer its encoding from the password string. */
export function normalizeNearbyNativeData(source: Record<string, unknown>, title: string, folder: string, type: NearbyEntryType): NearbyWireData {
  const payload = nearbyNativeBusinessPayload(source, type);
  let data: NearbyWireData;
  if (type === "login" || type === "ssh-key") {
    data = { title, folder, entry_type: type };
    for (const field of PASSWORD_FIELDS) {
      const names = [field, camel(field)];
      if (field.endsWith("_plain")) names.push(field.slice(0, -6), camel(field).slice(0, -5));
      if (field === "credit_card_cvv_plain") names.push("creditCardCVV");
      const value = first(payload, names);
      data[field] = value == null ? "" : field === "wifi_metadata" && typeof value === "object" ? JSON.stringify(wireObject(value)) : wireText(value);
    }
    const fields = objects(first(payload, ["custom_fields", "customFields"]) ?? [], 1024).slice();
    const order = (field: Record<string, unknown>) => { const value = first(field, ["sort_order", "sortOrder"]) ?? 0; return Number(wireInteger(value, 0x7fff_ffffn, -0x8000_0000n)); };
    fields.sort((a, b) => order(a) - order(b));
    data.custom_fields = fields.map((field, index) => ({ ...field, title: wireText(field.title), value: field.value == null ? "" : wireText(field.value), is_protected: first(field, ["is_protected", "isProtected"]) ?? false, sort_order: index }));
    data.login_type = payload.login_type ?? "PASSWORD";
    data.is_archived = payload.is_archived ?? false;
    data.archived_at = data.is_archived ? payload.archived_at ?? null : null;
    const extensions = cloneLosslessJson(payload);
    for (const field of [...LOCAL_FIELDS, ...PASSWORD_FIELDS, "custom_fields", "customFields", "password", "passwordPlain", "password_history", "attachments"]) delete extensions[field];
    data.extensions = extensions;
    if (own(payload, "password_history")) data.password_history = cloneLosslessJson(payload.password_history);
  } else {
    for (const field of [...LOCAL_FIELDS, "attachments"]) delete payload[field];
    data = { title, folder, entry_type: type, payload };
  }
  validateNearbyWireData(data); return data;
}

/** Reconstructs a target-native payload while keeping application-local handles
 * out of imported business data. References are still portable IDs here. */
export function nearbyNativePayload(input: NearbyWireData, id: string, folder: string | null, previous: Record<string, unknown> = {}): Record<string, unknown> {
  validateNearbyWireData(input);
  const data = cloneLosslessJson(input);
  let payload: Record<string, unknown>;
  if (data.entry_type === "login" || data.entry_type === "ssh-key") {
    payload = { ...nearbyNativeBusinessPayload(previous, data.entry_type), ...cloneLosslessJson(wireObject(data.extensions ?? {})) };
    for (const field of PASSWORD_FIELDS) {
      payload[field] = data[field];
      if (camel(field) !== field) delete payload[camel(field)];
      if (field.endsWith("_plain")) { delete payload[field.slice(0, -6)]; delete payload[camel(field).slice(0, -5)]; }
    }
    for (const field of ["customFields", "loginType", "isArchived", "archivedAt", "creditCardCVV"]) delete payload[field];
    if (own(data, "password_history")) payload.password_history = data.password_history;
    Object.assign(payload, { kind: "password", login_type: data.login_type, is_archived: data.is_archived, archived_at: data.archived_at ?? null, custom_fields: data.custom_fields });
  } else payload = cloneLosslessJson(wireObject(data.payload));
  for (const field of LOCAL_FIELDS) delete payload[field];
  if (data.entry_type === "login" || data.entry_type === "ssh-key") payload.monica_password_encoding = "plaintext-v1";
  payload.monica_entry_id = id; payload.mdbx_folder_id = folder;
  return payload;
}

/** Mutates only documented reference positions. Opaque JSON may contain its own
 * id/target/path keys and must not be traversed or rewritten. */
export function remapNearbyReferences(input: NearbyWireData, map: (id: string) => string): NearbyWireData {
  const data = cloneLosslessJson(input);
  const field = (node: unknown, name: string) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const object = node as Record<string, unknown>; const value = object[name];
    if (typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)) object[name] = map(value);
  };
  for (const name of ["bound_password_entry_id", "bound_note_entry_id", "sso_ref_entry_id"]) for (const node of [data, data.payload, data.extensions]) field(node, name);
  const visitPath = (value: unknown) => { if (Array.isArray(value)) for (const node of value) { field(node, "id"); field(node, "parent"); } };
  visitPath(data.folder_path);
  if (data.entry_type === "folder") visitPath(wireObject(data.payload).path);
  if (Array.isArray(data.relations)) for (const relation of data.relations) field(relation, "target");
  return data;
}
export function nearbyReferenceIds(data: NearbyWireData): string[] {
  const ids = new Set<string>(); remapNearbyReferences(data, id => { ids.add(id); return id; }); return [...ids];
}

/** Asset paths are application fields, not arbitrary text substitutions. In
 * particular passwords and unknown extension strings must remain byte-exact. */
export function remapNearbyAssetPaths(input: NearbyWireData, map: (path: string) => string): NearbyWireData {
  const data = cloneLosslessJson(input), note = data.entry_type === 'note';
  const pathLists = new Set(['image_paths', 'imagePaths', 'photoPaths']);
  const pathFields = new Set(['storagePath', 'storage_path', 'localPath', 'local_path', 'imagePath', 'custom_icon_value', 'customIconValue']);
  const visit = (value: unknown, key = '', depth = 0): void => {
    if (depth > 48) invalidNearby('asset-path-depth');
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (typeof value[index] === 'string' && pathLists.has(key)) value[index] = map(value[index]);
        else if (value[index] && typeof value[index] === 'object') visit(value[index], key, depth + 1);
      }
    } else if (value && typeof value === 'object' && !(JSON as typeof JSON & { isRawJSON?: (v: unknown) => boolean }).isRawJSON?.(value)) {
      const object = value as Record<string, unknown>;
      for (const [name, child] of Object.entries(object)) {
        if (typeof child === 'string') {
          if (pathLists.has(name)) {
            if (child.startsWith('[')) { const paths = parseLosslessJson(child); if (!Array.isArray(paths)) invalidNearby('asset-path-list'); visit(paths, name, depth + 1); object[name] = JSON.stringify(paths); }
            else object[name] = map(child);
          } else if (pathFields.has(name)) object[name] = map(child);
          else if (name === 'item_data' && child.startsWith('{')) { const nested = wireObject(parseLosslessJson(child)); visit(nested, '', depth + 1); object[name] = JSON.stringify(nested); }
          else if (name === 'content' && note) object[name] = child.replace(/(!\[[^\]]*\]\()([^\s)]+)(\))/g, (_all, before: string, path: string, after: string) => before + map(path) + after);
        } else if (child && typeof child === 'object') visit(child, name, depth + 1);
      }
    }
  };
  visit(data);
  return data;
}
