import { parseLosslessJson } from '../../../core/lossless-json';
import type { MdbxBrowserRequest } from './session';

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
  return sender?.id === runtime.id && sender.url === runtime.getURL('background.js') && sender.tab === undefined
    && sender.documentId === undefined && (sender.frameId === undefined || sender.frameId === 0);
}
export function bridgeObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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
