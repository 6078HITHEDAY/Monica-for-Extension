import type { ExtensionRequest } from '../runtime/messages';
import { assertTrustedManagerPage, assertTrustedExtensionPage } from '../runtime/sender-policy';

export const WEB_PAGE_REQUEST_TYPES = new Set<ExtensionRequest["type"]>([
  "AUTOFILL_INLINE_QUERY",
  "AUTOFILL_INLINE_FILL",
  "AUTOFILL_INLINE_OPEN",
  "CREDENTIAL_USERNAME_REMEMBER",
  "CREDENTIAL_CAPTURE",
  "CREDENTIAL_PENDING",
  "CREDENTIAL_ACCEPT",
  "CREDENTIAL_DISMISS",
  "PASSKEY_BEGIN",
  "PASSKEY_UNLOCK_CONTINUE",
  "PASSKEY_ACCEPT",
  "PASSKEY_DISMISS"
]);

export function assertManagerPage(sender: chrome.runtime.MessageSender): void {
  const managerPageUrl = chrome.runtime.getURL("index.html");
  const extensionRoot = managerPageUrl.slice(0, -"/index.html".length);
  assertTrustedManagerPage(sender, chrome.runtime.id, `${extensionRoot}/`);
}

export function assertExtensionPage(sender: chrome.runtime.MessageSender): void {
  assertTrustedExtensionPage(sender, chrome.runtime.id, chrome.runtime.getURL(""));
}
