import { getCountries, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';
import type { WalletFieldName } from '../runtime/messages';

const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const countryCache = new Map<string, Map<string, Set<string>>>();
function countryCode(value: string, language: string): string | undefined {
  let names = countryCache.get(language);
  if (!names) {
    names = new Map();
    for (const locale of new Set(['en', 'zh', language])) {
      let display: Intl.DisplayNames;
      try { display = new Intl.DisplayNames([locale], { type: 'region' }); } catch { continue; }
      for (const code of getCountries()) for (const name of [code, display.of(code)!]) {
        const key = normalize(name), values = names.get(key) ?? new Set(); values.add(code); names.set(key, values);
      }
    }
    countryCache.set(language, names);
  }
  const found = names.get(normalize(value)); return found?.size === 1 ? [...found][0] : undefined;
}

/** Select only one enabled option. Unknown or duplicate semantics are not a
 * reason to guess or abort filling the other controls. */
export function walletSelectOption(element: HTMLSelectElement, name: WalletFieldName, value: string): HTMLOptionElement | undefined {
  const options = [...element.options].filter(o => !o.disabled && !o.hidden && !o.closest('optgroup[disabled]') && o.value !== '');
  const language = element.ownerDocument.documentElement.lang || 'en';
  const monthNames = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2020, i, 1)));
  const matches = (text: string) => {
    if (normalize(text) === normalize(value)) return true;
    if (name === 'country') { const code = countryCode(value, language); return !!code && countryCode(text, language) === code; }
    if (name === 'cardExpiryMonth' && /^\d{1,2}$/.test(value) && +value >= 1 && +value <= 12) {
      if (/^\d{1,2}$/.test(text.trim())) return +text === +value;
      for (const locale of new Set(['en', language])) for (const format of ['long', 'short'] as const) {
        let label: string; try { label = new Intl.DateTimeFormat(locale, { month: format, timeZone: 'UTC' }).format(monthNames[+value - 1]); } catch { continue; }
        const normalized = normalize(text).replace(/^\d{1,2}\s*[-/.]?\s*/, '');
        if (normalized === normalize(label)) return true;
      }
    }
    if (name === 'cardExpiryYear' && /^(?:\d{2}|\d{4})$/.test(value) && /^(?:\d{2}|\d{4})$/.test(text.trim()))
      return text.trim().length !== value.length && text.trim().slice(-2) === value.slice(-2);
    return false;
  };
  const candidates = options.filter(o => matches(o.value) || matches(o.textContent || ''));
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function walletPhoneSegment(value: string, country: string | undefined, token: string, language: string): string | undefined {
  const region = country ? countryCode(country, language) as CountryCode | undefined : undefined;
  const phone = parsePhoneNumberFromString(value, region);
  if (!phone?.isPossible()) return undefined;
  if (token === 'tel-country-code') return `+${phone.countryCallingCode}`;
  if (token === 'tel-national') return phone.nationalNumber;
  if (token === 'tel-extension') return phone.ext;
  // NANP has an unambiguous 3+7 split. Do not infer other countries' varying
  // area-code lengths from presentation punctuation or the user's name.
  if (!['US', 'CA'].includes(phone.country ?? '') || phone.nationalNumber.length !== 10) return undefined;
  if (token === 'tel-area-code') return phone.nationalNumber.slice(0, 3);
  if (token === 'tel-local') return phone.nationalNumber.slice(3);
  if (token === 'tel-local-prefix') return phone.nationalNumber.slice(3, 6);
  if (token === 'tel-local-suffix') return phone.nationalNumber.slice(6);
  return undefined;
}
