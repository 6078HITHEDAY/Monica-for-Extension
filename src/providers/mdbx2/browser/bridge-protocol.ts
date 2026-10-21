import { parseLosslessJson } from '../../../core/lossless-json';
import type { MdbxBrowserRequest } from './session';
import { backgroundPageURL } from '../../../runtime/browser-platform';

export const MDBX_BROWSER_PORT = 'monica-mdbx-browser-v1';
export const MDBX_BROWSER_DOCUMENT_AUTH = 'MDBX_BROWSER_DOCUMENT_AUTH';
export const MDBX_BROWSER_DOCUMENT_READY = 'MDBX_BROWSER_DOCUMENT_READY';
export const MDBX_BROWSER_DOCUMENT = 'mdbx-offscreen.html';
export const MDBX_BROWSER_REQUEST_BYTES = 1024 * 1024;
export const MDBX_BROWSER_RESPONSE_BYTES = 900 * 1024;
export const MDBX_BROWSER_HEARTBEAT_MS = 15_000;
export const MDBX_BROWSER_LEASE_MS = 45_000;
export const MDBX_BROWSER_CLOSE_MS = 30_000;
export const MDBX_BROWSER_START_MS = 30_000;

export function trustedMdbxBackground(sender: chrome.runtime.MessageSender | undefined, runtime: Pick<typeof chrome.runtime, 'id' | 'getURL'>): boolean {
  const firefox = runtime.getURL('').startsWith('moz-extension://');
  return sender?.id === runtime.id && sender.url === backgroundPageURL(runtime) && sender.tab === undefined
    && (firefox || sender.documentId === undefined) && (sender.frameId === undefined || sender.frameId === 0);
}
export function bridgeObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function trustedFirefoxEngineDocument(sender: chrome.runtime.MessageSender, runtime: Pick<typeof chrome.runtime, 'id' | 'getURL'>, ownedURL: string | undefined, connected: boolean): boolean {
  return connected && typeof ownedURL === 'string' && ownedURL.startsWith(`${runtime.getURL(MDBX_BROWSER_DOCUMENT)}#`)
    && sender.id === runtime.id && sender.tab === undefined && sender.url === ownedURL
    && typeof sender.documentId === 'string' && /^[0-9a-f-]{16,64}$/i.test(sender.documentId);
}
export function boundedBridgeJson(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && new TextEncoder().encode(value).length <= limit;
}
export function browserRequest(json: unknown): MdbxBrowserRequest {
  if (!boundedBridgeJson(json, MDBX_BROWSER_REQUEST_BYTES)) throw Error('browser-request-invalid');
  const request = bridgeObject(parseLosslessJson(json));
  if (!request || Object.keys(request).length !== 4 || request.protocol !== 2 || typeof request.requestId !== 'string'
    || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(request.requestId) || typeof request.method !== 'string'
    || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(request.method) || !bridgeObject(request.params)) throw Error('browser-request-invalid');
  return request as unknown as MdbxBrowserRequest;
}
