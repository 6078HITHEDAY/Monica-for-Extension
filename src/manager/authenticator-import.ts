import { argon2id, scrypt } from 'hash-wasm';
import { base64ToBytes } from '../security/encoding';
import { jsonScalarText, parseLosslessJson } from '../core/lossless-json';
import { generateOtpUri, parseOtpUris, type TotpParameters } from '../core/totp';
import { normalizeImportedVaultItem } from './import-items';
import type { TotpItem, VaultItem } from '../core/model';

type RecordValue = Record<string, unknown>;
export const record = (v: unknown): RecordValue => v && typeof v === 'object' && !Array.isArray(v) ? v as RecordValue : {};
const text = (v: unknown): string => v == null ? '' : jsonScalarText(v);
const decoder = new TextDecoder('utf-8', { fatal: true });
export function otpItem(parameters: TotpParameters, title = '', notes = ''): TotpItem {
  // Run the existing strict OTP parser, including 64-bit HOTP counter validation.
  const parsed = parseOtpUris(generateOtpUri(parameters, title, { includePin: true }))[0];
  const item = normalizeImportedVaultItem({ ...parsed.parameters, kind: 'totp', title: title || parsed.label || parameters.issuer || 'OTP',
    accountName: parameters.accountName || parsed.accountName, notes, providerRefs: [] });
  if (!item || item.kind !== 'totp') throw new Error('验证器参数无效。');
  return item;
}

export async function decodeAegis(root: RecordValue, password: string): Promise<RecordValue> {
  if (typeof root.db !== 'string') return record(root.db || root);
  if (!password) throw new Error('请输入文件密码。');
  const header = record(root.header);
  const slots = Array.isArray(header.slots) ? header.slots.map(record).filter(s => s.type === 1) : [];
  if (!slots.length || slots.length > 8) throw new Error('Aegis 密码槽无效或过多。');
  for (const slot of slots) {
    const n = Number(slot.n ?? 32768), r = Number(slot.r ?? 8), p = Number(slot.p ?? 1);
    if (!Number.isSafeInteger(n) || n < 2 || n > 262144 || (n & (n - 1)) !== 0 ||
      !Number.isSafeInteger(r) || r < 1 || r > 32 || !Number.isSafeInteger(p) || p < 1 || p > 4 || n * r > 2097152 || n * r * p > 2097152)
      throw new Error('Aegis 密钥派生参数超出安全范围。');
    const derived = await scrypt({ password, salt: hex(slot.salt), costFactor: n, blockSize: r, parallelism: p, hashLength: 32, outputType: 'binary' });
    let key: Uint8Array | undefined;
    try { key = await gcm(derived, hex(slot.key), record(slot.key_params)); }
    catch { continue; }
    finally { derived.fill(0); }
    try { return record(parseLosslessJson(decoder.decode(await gcm(key, base64ToBytes(root.db), record(header.params))))); }
    finally { key.fill(0); }
  }
  throw new Error('文件密码不正确或文件已损坏。');
}

export async function decodeStratum(bytes: Uint8Array, password: string): Promise<RecordValue> {
  const prefix = new TextDecoder().decode(bytes.subarray(0, 16));
  const modern = prefix.startsWith('AUTHENTICATORPRO');
  const header = modern ? 'AUTHENTICATORPRO' : 'AuthenticatorPro';
  if (!prefix.startsWith(header)) return record(parseLosslessJson(decoder.decode(bytes)));
  if (!password) throw new Error('请输入文件密码。');
  const saltEnd = header.length + (modern ? 16 : 20), ivEnd = saltEnd + (modern ? 12 : 16);
  if (bytes.length <= ivEnd + 16) throw new Error('Stratum 文件不完整。');
  const salt = bytes.slice(header.length, saltEnd), iv = bytes.slice(saltEnd, ivEnd), algorithm = modern ? 'AES-GCM' : 'AES-CBC';
  let key: Uint8Array;
  if (modern) key = await argon2id({ password, salt, parallelism: 4, iterations: 3, memorySize: 65536, hashLength: 32, outputType: 'binary' });
  else {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    key = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 64000, hash: 'SHA-1' }, material, 256));
  }
  try {
    const material = await crypto.subtle.importKey('raw', key as BufferSource, algorithm, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: algorithm, iv }, material, bytes.slice(ivEnd));
    return record(parseLosslessJson(decoder.decode(plain)));
  } catch { throw new Error('文件密码不正确或文件已损坏。'); }
  finally { key.fill(0); }
}

export function readAuthenticators(root: RecordValue, format: 'aegis' | 'stratum'): { items: VaultItem[]; skipped: number } {
  const rows = format === 'aegis' ? root.entries : root.Authenticators;
  if (!Array.isArray(rows) || rows.length > 100000) throw new Error('验证器文件格式无效。');
  const items: VaultItem[] = []; let skipped = 0;
  for (const value of rows) {
    try {
      const row = record(value), info = format === 'aegis' ? record(row.info) : row;
      const type = format === 'aegis' ? text(row.type).toUpperCase() : ({ 1: 'HOTP', 2: 'TOTP', 3: 'MOTP', 4: 'STEAM', 5: 'YANDEX' } as Record<number, string>)[Number(row.Type)];
      if (!['TOTP', 'HOTP', 'STEAM', 'MOTP', 'YANDEX'].includes(type)) throw new Error('Unsupported OTP');
      const issuer = text(row.issuer ?? row.Issuer), accountName = text(row.name ?? row.Username);
      const algorithm = format === 'aegis' ? text(info.algo || 'SHA1').toUpperCase() : ['SHA1', 'SHA256', 'SHA512'][Number(info.Algorithm ?? 0)];
      const secret = text(info.secret ?? info.Secret);
      items.push(otpItem({ secret, issuer, accountName, algorithm: algorithm as TotpParameters['algorithm'],
        digits: type === 'STEAM' ? 5 : Number(info.digits ?? info.Digits ?? 6), period: Number(info.period ?? info.Period ?? 30),
        otpType: type as TotpParameters['otpType'], counter: text(info.counter ?? info.Counter ?? 0),
        pin: text(info.pin ?? info.Pin), secretEncoding: 'base32' }, [issuer, accountName].filter(Boolean).join(': '), text(row.note)));
    } catch { skipped++; }
  }
  return { items, skipped };
}

function hex(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{2})+$/i.test(value) || value.length > 2048) throw new Error('加密文件参数无效。');
  return Uint8Array.from(value.match(/../g)!, v => parseInt(v, 16));
}
async function gcm(key: Uint8Array, ciphertext: Uint8Array, params: RecordValue): Promise<Uint8Array> {
  const nonce = hex(params.nonce), tag = hex(params.tag);
  if (nonce.length !== 12 || tag.length !== 16 || key.length !== 32) throw new Error('加密文件参数无效。');
  const material = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['decrypt']);
  const payload = new Uint8Array(ciphertext.length + tag.length); payload.set(ciphertext); payload.set(tag, ciphertext.length);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, material, payload));
}
