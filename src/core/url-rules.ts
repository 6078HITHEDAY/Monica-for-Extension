import { parseLosslessJson } from './lossless-json';
import type { LoginItem, LoginUriRule, SecureCustomField } from './model';

export const ANDROID_URL_RULE_FIELD = 'monica.autofill.url_rules';
const MODES = { DEFAULT: 'default', BASE_DOMAIN: 'base-domain', HOST: 'host', STARTS_WITH: 'starts-with', EXACT: 'exact', REGEX: 'regex', NEVER: 'never' } as const;
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function document(value: string): { raw: JsonObject; rows: JsonObject[]; rules: LoginUriRule[] } | undefined {
  try {
    if (value.length > 1024 * 1024) return undefined;
    const raw = parseLosslessJson(value);
    if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.urls) || !raw.urls.length || raw.urls.length > 1024) return undefined;
    const rules: LoginUriRule[] = [], rows: JsonObject[] = [];
    for (const row of raw.urls) {
      if (!object(row) || typeof row.url !== 'string' || !row.url.trim() || row.url.length > 8192
        || typeof row.mode !== 'string' || !Object.prototype.hasOwnProperty.call(MODES, row.mode)) return undefined;
      rules.push({ uri: row.url, matchType: MODES[row.mode as keyof typeof MODES] }); rows.push(row);
    }
    return { raw, rows, rules };
  } catch { return undefined; }
}

export function decodeAndroidUrlRules(value: string): LoginUriRule[] | undefined { return document(value)?.rules; }
export function hasAndroidUrlRules(fields: SecureCustomField[]): boolean { return fields.some(field => field.name === ANDROID_URL_RULE_FIELD); }
export function readAndroidUrlRules(fields: SecureCustomField[]): LoginUriRule[] | undefined {
  const found = fields.filter(field => field.name === ANDROID_URL_RULE_FIELD);
  return found.length === 1 ? decodeAndroidUrlRules(found[0].value) : undefined;
}

/** An unreadable/duplicate carrier denies recommendations; it never enables a broad fallback. */
export function effectiveLoginUriRules(item: Pick<LoginItem, 'customFields' | 'uriRules' | 'uris'>): LoginUriRule[] {
  if (hasAndroidUrlRules(item.customFields)) return readAndroidUrlRules(item.customFields) ?? [];
  return item.uriRules?.length ? item.uriRules : item.uris.map(uri => ({ uri, matchType: 'base-domain' }));
}

/** Patch only the known rule slots, retaining future metadata and literal numeric tokens.
 * The carrier stays in customFields even when projected into the editor. */
export function writeAndroidUrlRules(fields: SecureCustomField[], rules: LoginUriRule[]): SecureCustomField[] {
  const reserved = fields.filter(field => field.name === ANDROID_URL_RULE_FIELD);
  const previous = reserved.length === 1 ? document(reserved[0].value) : undefined;
  if (reserved.length && !previous) throw new Error('网址匹配规则版本不受支持，请保留原始数据。');
  const rows = rules.filter(rule => rule.uri.trim());
  if (previous && same(previous.rules, rows)) return fields;
  if (rows.every(rule => rule.matchType === 'default')) return fields.filter(field => field.name !== ANDROID_URL_RULE_FIELD);
  // Legacy Bitwarden domain matches include subdomains. They cannot be relabelled HOST.
  if (rows.some(rule => rule.matchType === 'domain')) {
    if (reserved.length || rows.some(rule => rule.matchType === 'host')) throw new Error('网址匹配规则不能转换，请保留原始数据。');
    return fields;
  }
  const used = new Set<number>();
  const indexes = rows.map(rule => {
    let index = previous?.rules.findIndex((old, index) => !used.has(index) && same(old, rule)) ?? -1;
    if (index < 0) index = previous?.rules.findIndex((old, index) => !used.has(index) && old.uri === rule.uri) ?? -1;
    if (index >= 0) used.add(index);
    return index;
  });
  // A single edited URL has an unambiguous original row, even after reordering.
  // Never attach unknown row metadata to an unrelated insertion.
  const missing = indexes.flatMap((index, position) => index < 0 ? [position] : []);
  const remaining = previous?.rows.flatMap((_, index) => used.has(index) ? [] : [index]) ?? [];
  if (missing.length === 1 && remaining.length === 1 && rows.length === previous?.rows.length) indexes[missing[0]] = remaining[0];
  const urls = rows.map((rule, position) => {
    const mode = Object.entries(MODES).find(([, value]) => value === rule.matchType)?.[0];
    if (!mode || rule.uri.length > 8192) throw new Error('网址匹配规则版本不受支持，请保留原始数据。');
    const index = indexes[position];
    return { ...(index < 0 ? {} : previous!.rows[index]), url: rule.uri, mode };
  });
  const value = JSON.stringify({ ...previous?.raw, version: 1, urls });
  if (!reserved.length) return [...fields, { name: ANDROID_URL_RULE_FIELD, value, protected: false }];
  return fields.map(field => field.name === ANDROID_URL_RULE_FIELD ? { ...field, value } : field);
}

/** Android transports can carry a legacy extension rule as reserved metadata without
 * changing a raw carrier on a title-only edit. */
export function androidTransportFields(item: LoginItem): SecureCustomField[] {
  if (hasAndroidUrlRules(item.customFields) || !item.uriRules?.some(rule => !['base-domain', 'domain', 'default'].includes(rule.matchType))) return item.customFields;
  return writeAndroidUrlRules(item.customFields, item.uriRules);
}
