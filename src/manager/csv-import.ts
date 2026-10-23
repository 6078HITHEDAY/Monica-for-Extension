import type { VaultItem } from "../core/model";
import { normalizeImportedVaultItem } from "./import-items";
import { otpItem } from './authenticator-import';
import { parseOtpUris } from '../core/totp';

const MAX_FIELD_LENGTH = 1024 * 1024;
const MAX_ROWS = 100000;

export interface CsvImportResult {
  items: VaultItem[];
  skipped: number;
}

type FieldKey = "title" | "username" | "password" | "uris" | "notes" | "totpSecret" | "favorite" | "categoryName";

const HEADER_ALIASES: Record<string, FieldKey> = {
  name: "title", title: "title", account: "title", entry: "title",
  username: "username", user: "username", login: "username", login_username: "username", userid: "username",
  password: "password", pass: "password", login_password: "password", pwd: "password",
  url: "uris", uri: "uris", website: "uris", login_uri: "uris", urls: "uris", web: "uris", site: "uris",
  notes: "notes", note: "notes", extra: "notes", comment: "notes", comments: "notes", description: "notes",
  totp: "totpSecret", login_totp: "totpSecret", otp: "totpSecret", otpsecret: "totpSecret",
  favorite: "favorite", fav: "favorite", favourite: "favorite",
  folder: 'categoryName', group: 'categoryName', grouping: 'categoryName', vault: 'categoryName', category: 'categoryName',
  '标题': 'title', '名称': 'title', '用户名': 'username', '账号': 'username', '密码': 'password', '网址': 'uris', '网站': 'uris', '备注': 'notes', '分类': 'categoryName',
  'login name': 'username', 'login password': 'password', 'web site': 'uris'
};

export function parseCsvToVaultItems(text: string, now?: string): CsvImportResult {
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  if (rows.length === 0) return { items: [], skipped: 0 };
  const fieldMap = buildFieldMap(rows[0]);
  const items: VaultItem[] = [];
  let skipped = 0;
  const header = rows[0].map(value => value.trim().toLowerCase());
  const secretIndex = header.indexOf('secret'), uriIndex = header.indexOf('otpauth');
  const typeIndex = header.indexOf('type');
  if (!fieldMap.title.length && !fieldMap.username.length && secretIndex < 0 && uriIndex < 0) throw new Error('无法识别 CSV 列名。');
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (secretIndex >= 0 && !fieldMap.password.length || uriIndex >= 0) {
      try {
        const value = row[uriIndex >= 0 ? uriIndex : secretIndex] || '';
        const parsed = parseOtpUris(value)[0];
        const column = (name: string) => row[header.indexOf(name)];
        items.push(otpItem({ ...parsed.parameters, issuer: column('issuer') || parsed.parameters.issuer,
          accountName: column('accountname') || column('username') || parsed.accountName,
          ...(column('algorithm') ? { algorithm: column('algorithm').toUpperCase() as 'SHA1' | 'SHA256' | 'SHA512' } : {}),
          ...(column('digits') ? { digits: Number(column('digits')) } : {}), ...(column('period') ? { period: Number(column('period')) } : {}) }, firstNonEmpty(row, fieldMap.title) || parsed.label));
      } catch { skipped++; }
      continue;
    }
    const type = (row[typeIndex] || '').toLowerCase();
    if (type && !['login', '1', 'note', 'secure note', 'securenote', '2'].includes(type)) { skipped++; continue; }
    const raw = buildRawItem(row, fieldMap);
    if (['note', 'secure note', 'securenote', '2'].includes(type)) { raw.kind = 'secure-note'; raw.content = raw.notes; }
    if (!raw.title && !raw.username && !raw.password && !raw.notes) { skipped++; continue; }
    const normalized = normalizeImportedVaultItem(raw, now);
    if (normalized) items.push(normalized);
    else skipped++;
  }
  return { items, skipped };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStart = true;
  const flushField = () => { row.push(field); field = ""; fieldStart = true; };
  const flushRow = () => {
    if (!(row.length === 1 && row[0].trim() === "")) {
      rows.push(row);
      if (rows.length > MAX_ROWS) throw new Error("CSV row count exceeds maximum");
    }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (fieldStart && ch === '"') {
      inQuotes = true;
      fieldStart = false;
    } else if (ch === '"') {
      field += ch;
    } else if (ch === ",") {
      flushField();
    } else if (ch === "\r") {
      flushField();
      if (text[i + 1] === "\n") i++;
      flushRow();
    } else if (ch === "\n") {
      flushField();
      flushRow();
    } else {
      field += ch;
      fieldStart = false;
    }
    if (field.length > MAX_FIELD_LENGTH) throw new Error("CSV field exceeds maximum length");
  }
  if (inQuotes) throw new Error('CSV 引号未闭合，未导入任何项目。');
  if (field.length > 0 || row.length > 0) {
    flushField();
    flushRow();
  }
  return rows;
}

interface FieldMap {
  title: number[];
  username: number[];
  password: number[];
  uris: number[];
  notes: number[];
  totpSecret: number[];
  favorite: number[];
  categoryName: number[];
}

function buildFieldMap(header: string[]): FieldMap {
  const map: FieldMap = {
    title: [], username: [], password: [], uris: [], notes: [], totpSecret: [], favorite: [], categoryName: []
  };
  const emailColumns: number[] = [];
  for (let i = 0; i < header.length; i++) {
    const normalized = header[i].trim().toLowerCase();
    if (!normalized) continue;
    if (normalized === "email") { emailColumns.push(i); continue; }
    const field = HEADER_ALIASES[normalized];
    if (field && Object.prototype.hasOwnProperty.call(map, field)) map[field].push(i);
  }
  if (map.username.length === 0) map.username = emailColumns;
  return map;
}

function buildRawItem(row: string[], fieldMap: FieldMap): Record<string, unknown> {
  const title = firstNonEmpty(row, fieldMap.title);
  const username = firstNonEmpty(row, fieldMap.username);
  const password = firstNonEmpty(row, fieldMap.password);
  const notes = firstNonEmpty(row, fieldMap.notes);
  const totpSecret = firstNonEmpty(row, fieldMap.totpSecret);
  const uris = splitUris(firstNonEmpty(row, fieldMap.uris));
  const raw: Record<string, unknown> = {
    kind: "login", title, username, password, notes, favorite: isFavoriteTrue(firstNonEmpty(row, fieldMap.favorite)), categoryName: firstNonEmpty(row, fieldMap.categoryName)
  };
  if (uris.length > 0) raw.uris = uris;
  if (totpSecret) raw.totpSecret = totpSecret;
  return raw;
}

function firstNonEmpty(row: string[], columns: number[]): string {
  for (const col of columns) {
    if (col < row.length && row[col].trim()) return row[col];
  }
  // All-space passwords and usernames are still credential values.
  return columns.map(column => row[column]).find(value => value !== undefined) || "";
}

function splitUris(value: string): string[] {
  return value.split(/[;\r\n]+/).map((part) => part.trim()).filter(Boolean);
}

function isFavoriteTrue(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return lower === "1" || lower === "true" || lower === "yes";
}
