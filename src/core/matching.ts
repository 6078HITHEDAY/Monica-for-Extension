import safeRegex from "safe-regex2";
import { getDomain } from "tldts";
import type { LoginItem, LoginUriRule } from "./model";
import { effectiveLoginUriRules, hasAndroidUrlRules } from './url-rules';

const MAX_REGEX_LENGTH = 512;

export function normalizeHost(value: string): string {
  const candidate = value.trim();
  if (!candidate) return "";
  try {
    return normalizeHostname(new URL(candidate.includes("://") ? candidate : `https://${candidate}`).hostname);
  } catch {
    return normalizeHostname(candidate.split("/")[0] || "");
  }
}

export function loginMatchScore(item: LoginItem, pageUrl: string): number {
  if (item.deletedAt || item.archivedAt) return 0;
  if (item.loginType && item.loginType !== "PASSWORD" && item.loginType !== "SSO") return 0;
  const page = parsePageUrl(pageUrl);
  if (!page) return 0;
  const rules = effectiveLoginUriRules(item), android = hasAndroidUrlRules(item.customFields);
  const score = rules.reduce((best, rule) => Math.max(best, uriRuleMatchScore(rule, page, android)), 0);
  if (score > 0 || android || rules.some((rule) => rule.uri.trim())) return score;
  return uriRuleMatchScore({ uri: hostnameTitle(item.title), matchType: "base-domain" }, page, false);
}

export function matchingLogins(items: LoginItem[], pageUrl: string): LoginItem[] {
  return items
    .map((item) => ({ item, score: loginMatchScore(item, pageUrl) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || Number(right.item.favorite) - Number(left.item.favorite) || left.item.title.localeCompare(right.item.title))
    .map(({ item }) => item);
}

function uriRuleMatchScore(rule: LoginUriRule, page: URL, android: boolean): number {
  const stored = rule.uri.trim();
  if (!stored || rule.matchType === "never") return 0;
  if (rule.matchType === "exact") return comparableUrl(stored) === page.href ? 140 : 0;
  if (rule.matchType === "starts-with") {
    try {
      const saved = new URL(stored.includes('://') ? stored : `https://${stored}`);
      if (!stored.includes('://')) return saved.hostname === stored.toLowerCase() && saved.hostname === page.hostname ? 120 : 0;
      return saved.origin === page.origin && page.href.startsWith(comparableUrl(stored, false)) ? 120 : 0;
    } catch { return 0; }
  }
  if (rule.matchType === "regex") return matchesSafeRegex(stored, page.href, android) ? 115 : 0;
  if (rule.matchType === 'host') {
    try { return new URL(stored.includes('://') ? stored : `https://${stored}`).hostname === page.hostname ? 110 : 0; }
    catch { return 0; }
  }
  if (!['default', 'base-domain', 'domain'].includes(rule.matchType)) return 0;

  const storedHost = normalizeHost(stored);
  const pageHost = normalizeHostname(page.hostname);
  if (!storedHost || !pageHost) return 0;
  if (rule.matchType === "domain") {
    if (storedHost === pageHost) return 110;
    return pageHost.endsWith(`.${storedHost}`) ? 90 : 0;
  }

  if (storedHost === pageHost) return 100;
  return registrableDomain(storedHost) === registrableDomain(pageHost) ? 80 : 0;
}

function parsePageUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function comparableUrl(value: string, ensureTrailingSlash = true): string {
  const candidate = value.trim();
  if (!candidate.includes("://")) return candidate;
  try {
    const url = new URL(candidate);
    if (!ensureTrailingSlash && url.pathname === "/" && !/[/?#]$/.test(candidate)) return url.href.slice(0, -1);
    return url.href;
  } catch {
    return candidate;
  }
}

function matchesSafeRegex(pattern: string, value: string, android: boolean): boolean {
  // Android uses RE2J: unsupported lookarounds/backreferences fail closed here.
  if (pattern.length > MAX_REGEX_LENGTH || value.length > 8192 || !safeRegex(pattern)
    || android && (/\(\?[=!<]/.test(pattern) || /\\[1-9]/.test(pattern))) return false;
  try {
    return new RegExp(pattern, android ? '' : 'i').test(value);
  } catch {
    return false;
  }
}

function registrableDomain(host: string): string {
  return getDomain(host, { allowPrivateDomains: true }) || host;
}

function normalizeHostname(host: string): string {
  return host.toLocaleLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

/** KeePass/Android entries often store the site as the title and leave URL empty. */
function hostnameTitle(title: string): string {
  const candidate = title.trim();
  if (!candidate || /[\s/<>]/.test(candidate)) return "";
  const host = normalizeHost(candidate);
  if (!host.includes(".")) return "";
  if (getDomain(host, { allowPrivateDomains: true })) return host;
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) ? host : "";
}
