import { createSHA256 } from "hash-wasm";
import { readBoundedJsonObject, ProviderBodyReadNetworkError } from "../bounded-body";
import { ProviderTransportError, providerHttpError, resilientFetch, type ProviderResponseConsumer, type ProviderTransportPolicy } from "../provider-transport";
import { OneDriveAuthorizationError } from "../onedrive/onedrive-auth";
import {
  assertGraphUrl, identityPart, safeDownloadUrl, safeNextLink,
  type OneDriveAccessTokenProvider
} from "../onedrive/onedrive-graph-client";
import { MDBX2_MAX_BINARY_CHUNK_BYTES, MDBX2_MAX_INBOUND_FILE_BYTES } from "./native-contract";
import { mdbx2ParentPath, normalizeMdbx2RemotePath } from "./mdbx2-sync-paths";
import type { Mdbx2RemoteClient, Mdbx2RemoteDownloadResult, Mdbx2RemoteObject } from "./mdbx2-remote-client";

const GRAPH = "https://graph.microsoft.com/v1.0";
const FIELDS = "id,name,size,eTag,lastModifiedDateTime,parentReference,file,folder,deleted,remoteItem";
const MAX_METADATA_BYTES = 512 * 1024;
const MAX_CHILDREN = 10000;
const MAX_PAGES = 100;
/** Graph simple upload ceiling; larger bodies go through resumable upload sessions. */
const SIMPLE_UPLOAD_MAX_BYTES = 250 * 1024 * 1024;
/** Upload-session chunks must be multiples of 320 KiB. */
const UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;
const CAPABILITY_SUFFIXES = [".1drv.com", ".sharepoint.com", ".storage.live.com", ".microsoftpersonalcontent.com"];

/** Same six-operation contract as the WebDAV transport, addressed by Graph item paths on one drive. */
export class Mdbx2OneDriveClient implements Mdbx2RemoteClient {
  private readonly driveId: string;
  private readonly simpleUploadMaxBytes: number;
  constructor(
    driveId: string,
    private readonly accessToken: OneDriveAccessTokenProvider,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly policy: ProviderTransportPolicy = {},
    simpleUploadMaxBytes = SIMPLE_UPLOAD_MAX_BYTES
  ) {
    this.driveId = identityPart(driveId);
    if (!Number.isSafeInteger(simpleUploadMaxBytes) || simpleUploadMaxBytes < 1 || simpleUploadMaxBytes > SIMPLE_UPLOAD_MAX_BYTES) {
      throw invalidMetadata();
    }
    this.simpleUploadMaxBytes = simpleUploadMaxBytes;
  }

  async testConnection(signal?: AbortSignal): Promise<void> {
    const drive = await this.request(`${GRAPH}/drives/${encodeURIComponent(this.driveId)}?$select=id,name,driveType`, { signal }, "MDBX2 OneDrive 连接", async (response, requestSignal) => {
      if (!response.ok) throw providerHttpError("MDBX2 OneDrive 连接失败", response);
      return readBoundedJsonObject(response, MAX_METADATA_BYTES, "MDBX2 OneDrive 云盘信息", requestSignal);
    });
    // Graph may answer a drive alias with its canonical id, so only require a parsable drive.
    if (typeof drive.id !== "string" || !drive.id) {
      throw new ProviderTransportError("client", "MDBX2 OneDrive 未返回云盘信息，请重新登录。", { operation: "MDBX2 OneDrive 连接", attempts: 1, retryable: false });
    }
  }

  async stat(path: string, signal?: AbortSignal): Promise<Mdbx2RemoteObject | undefined> {
    const normalized = normalizeMdbx2RemotePath(path);
    return this.request(`${itemPathUrl(this.driveId, normalized)}?$select=${FIELDS}`, { signal }, `MDBX2 OneDrive 读取 ${normalized}`, async (response, requestSignal) => {
      if (response.status === 404) return undefined;
      if (!response.ok) throw providerHttpError(`MDBX2 OneDrive 读取 ${normalized} 失败`, response);
      const raw = await readBoundedJsonObject(response, MAX_METADATA_BYTES, "MDBX2 OneDrive 元数据", requestSignal);
      if (raw.deleted || raw.remoteItem) return undefined;
      return parseRemoteItem(raw, normalized, this.driveId);
    });
  }

  async list(path: string, signal?: AbortSignal): Promise<Mdbx2RemoteObject[]> {
    const normalized = normalizeMdbx2RemotePath(path);
    const base = `${itemPathUrl(this.driveId, normalized)}/children`;
    let next: string | undefined = `${base}?$select=${FIELDS}&$top=200`;
    const seenPages = new Set<string>();
    const items: Mdbx2RemoteObject[] = [];
    let count = 0;
    while (next) {
      if (seenPages.has(next) || seenPages.size >= MAX_PAGES) throw invalidMetadata();
      seenPages.add(next);
      const page: Record<string, unknown> = await this.request<Record<string, unknown>>(next, { signal }, `MDBX2 OneDrive 列举 ${normalized}`, async (response, requestSignal) => {
        if (!response.ok) throw providerHttpError(`MDBX2 OneDrive 列举 ${normalized} 失败`, response);
        return readBoundedJsonObject(response, MAX_METADATA_BYTES, "MDBX2 OneDrive 元数据", requestSignal);
      });
      if (!Array.isArray(page.value) || (count += page.value.length) > MAX_CHILDREN) throw invalidMetadata();
      for (const raw of page.value) {
        if (!isObject(raw) || raw.deleted || raw.remoteItem) continue;
        items.push(parseRemoteItem(raw, `${normalized}/${textField(raw.name, 256)}`, this.driveId));
      }
      next = page["@odata.nextLink"] === undefined ? undefined : safeNextLink(page["@odata.nextLink"], base);
    }
    signal?.throwIfAborted();
    return items.sort((left, right) => left.path.localeCompare(right.path));
  }

  async ensureDirectory(path: string, signal?: AbortSignal): Promise<void> {
    const normalized = normalizeMdbx2RemotePath(path);
    const components = normalized.split("/");
    let current = "";
    for (const component of components) {
      current = current ? `${current}/${component}` : component;
      const existing = await this.stat(current, signal);
      if (existing) {
        if (!existing.isDirectory) throw new Error(`MDBX2 OneDrive 位置已被文件占用: ${current}`);
        continue;
      }
      await this.createFolder(current, signal);
    }
  }

  private async createFolder(current: string, signal?: AbortSignal): Promise<void> {
    const parent = mdbx2ParentPath(current);
    const name = parent ? current.slice(parent.length + 1) : current;
    const base = parent ? itemPathUrl(this.driveId, parent) : `${GRAPH}/drives/${encodeURIComponent(this.driveId)}/root`;
    const created = await this.request(`${base}/children`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" })
    }, `MDBX2 OneDrive 创建目录 ${current}`, async (response, requestSignal) => {
      if (response.ok) {
        const raw = await readBoundedJsonObject(response, MAX_METADATA_BYTES, "MDBX2 OneDrive 目录", requestSignal);
        if (!isObject(raw) || !isObject(raw.folder)) throw invalidMetadata();
        return true;
      }
      if (response.status === 409) return false;
      throw providerHttpError(`MDBX2 OneDrive 创建目录 ${current} 失败`, response);
    });
    if (!created) {
      const raced = await this.stat(current, signal);
      if (!raced?.isDirectory) throw new Error(`MDBX2 OneDrive 目录创建发生冲突: ${current}`);
    }
  }

  async download(
    path: string,
    maximumBytes: number,
    onChunk: (chunk: Uint8Array, offset: number) => Promise<void> | void,
    signal?: AbortSignal
  ): Promise<Mdbx2RemoteDownloadResult> {
    const normalized = normalizeMdbx2RemotePath(path);
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MDBX2_MAX_INBOUND_FILE_BYTES) {
      throw new Error("MDBX2 OneDrive 下载上限无效。");
    }
    const metadata = await this.request(`${itemPathUrl(this.driveId, normalized)}?$select=${FIELDS},@microsoft.graph.downloadUrl,@content.downloadUrl`, { signal }, `MDBX2 OneDrive 下载 ${normalized}`, async (response, requestSignal) => {
      if (!response.ok) throw providerHttpError(`MDBX2 OneDrive 下载 ${normalized} 失败`, response);
      const raw = await readBoundedJsonObject(response, MAX_METADATA_BYTES, "MDBX2 OneDrive 元数据", requestSignal);
      if (raw.deleted || raw.remoteItem || !isObject(raw.file)) throw invalidMetadata();
      return {
        item: parseRemoteItem(raw, normalized, this.driveId),
        downloadUrl: capabilityFrom(raw, "MDBX2 OneDrive 下载地址无效", true)
      };
    });
    if (metadata.item.sizeBytes === undefined || metadata.item.sizeBytes > maximumBytes) throw new Error("MDBX2 OneDrive 下载超过安全上限。");
    if (metadata.downloadUrl) {
      return this.capabilityDownload(metadata.downloadUrl, normalized, metadata.item.sizeBytes, maximumBytes, onChunk, signal);
    }
    // Consumer drives can omit the capability annotation entirely. Stream /content
    // through Graph's redirect instead: fetch strips the Authorization header on
    // cross-origin redirects, and the payload is sha256-verified downstream anyway.
    return this.contentDownload(metadata.item.itemId, normalized, metadata.item.sizeBytes, maximumBytes, onChunk, signal);
  }

  private capabilityDownload(
    downloadUrl: string,
    normalized: string,
    expectedSize: number,
    maximumBytes: number,
    onChunk: (chunk: Uint8Array, offset: number) => Promise<void> | void,
    signal?: AbortSignal
  ): Promise<Mdbx2RemoteDownloadResult> {
    // The preauthenticated capability URL is fetched without the bearer token,
    // cookies, or redirects, exactly like the KeePass OneDrive transport.
    return resilientFetch(downloadUrl, { method: "GET", signal, credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" }, {
      ...this.policy, operation: `MDBX2 OneDrive 下载 ${normalized}`, fetcher: this.fetcher, idempotent: true, timeoutMs: this.policy.timeoutMs ?? 600_000
    }, (response, requestSignal) => this.consumeDownload(response, requestSignal, normalized, expectedSize, maximumBytes, onChunk));
  }

  private async contentDownload(
    itemId: string,
    normalized: string,
    expectedSize: number,
    maximumBytes: number,
    onChunk: (chunk: Uint8Array, offset: number) => Promise<void> | void,
    signal?: AbortSignal
  ): Promise<Mdbx2RemoteDownloadResult> {
    assertGraphUrl(`${GRAPH}/drives/${encodeURIComponent(this.driveId)}/items/${encodeURIComponent(itemIdPart(itemId))}/content`);
    signal?.throwIfAborted();
    const token = await this.accessToken(signal);
    signal?.throwIfAborted();
    if (typeof token !== "string" || !/^[\x21-\x7e]{1,32768}$/.test(token)) throw new OneDriveAuthorizationError();
    return resilientFetch(`${GRAPH}/drives/${encodeURIComponent(this.driveId)}/items/${encodeURIComponent(itemIdPart(itemId))}/content`, {
      method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "*/*" }, signal,
      credentials: "omit", redirect: "follow", cache: "no-store", referrerPolicy: "no-referrer"
    }, {
      ...this.policy, operation: `MDBX2 OneDrive 下载 ${normalized}`, fetcher: this.fetcher, idempotent: true, timeoutMs: this.policy.timeoutMs ?? 600_000
    }, (response, requestSignal) => {
      if (!response.ok) throw providerHttpError(`MDBX2 OneDrive 下载 ${normalized} 失败`, response);
      return this.consumeDownload(response, requestSignal, normalized, expectedSize, maximumBytes, onChunk);
    });
  }

  async putImmutable(path: string, body: Blob, expectedSha256: string, signal?: AbortSignal): Promise<Mdbx2RemoteObject> {
    const normalized = normalizeMdbx2RemotePath(path);
    const digest = normalizeDigest(expectedSha256);
    if (!(body instanceof Blob) || body.size < 1 || body.size > MDBX2_MAX_INBOUND_FILE_BYTES) throw new Error("MDBX2 OneDrive 上传大小超过安全上限。");
    const existing = await this.stat(normalized, signal);
    if (existing) return this.requireIdentical(normalized, existing, body.size, digest, signal);
    try {
      if (body.size <= this.simpleUploadMaxBytes) await this.simpleUpload(normalized, body, signal);
      else await this.sessionUpload(normalized, body, signal);
      return await this.stat(normalized, signal) || { path: normalized, isDirectory: false, sizeBytes: body.size };
    } catch (error) {
      if (!(error instanceof ProviderTransportError) || error.code !== "conflict") throw error;
      const raced = await this.stat(normalized, signal);
      if (!raced) throw error;
      return this.requireIdentical(normalized, raced, body.size, digest, signal);
    }
  }

  private async simpleUpload(normalized: string, body: Blob, signal?: AbortSignal): Promise<void> {
    const url = `${itemPathUrl(this.driveId, normalized)}/content?@microsoft.graph.conflictBehavior=fail`;
    await this.request(url, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body, signal },
      `MDBX2 OneDrive 上传 ${normalized}`, async (response, requestSignal) => {
        if (!response.ok) throw providerHttpError(`MDBX2 OneDrive 上传 ${normalized} 失败`, response);
        const raw = await readBoundedJsonObject(response, MAX_METADATA_BYTES, "MDBX2 OneDrive 上传结果", requestSignal);
        if (!isObject(raw) || !Number.isSafeInteger(raw.size) || raw.size !== body.size) throw invalidMetadata();
      });
  }

  private async sessionUpload(normalized: string, body: Blob, signal?: AbortSignal): Promise<void> {
    const uploadUrl = await this.request(`${itemPathUrl(this.driveId, normalized)}/createUploadSession`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "fail" } })
    }, `MDBX2 OneDrive 创建上传会话 ${normalized}`, async (response, requestSignal) => {
      if (!response.ok) throw providerHttpError(`MDBX2 OneDrive 创建上传会话 ${normalized} 失败`, response);
      const raw = await readBoundedJsonObject(response, MAX_METADATA_BYTES, "MDBX2 OneDrive 上传会话", requestSignal);
      return safeCapabilityUrl(raw.uploadUrl);
    });
    try {
      for (let start = 0; start < body.size; start += UPLOAD_CHUNK_BYTES) {
        signal?.throwIfAborted();
        const end = Math.min(start + UPLOAD_CHUNK_BYTES, body.size);
        await this.putUploadChunk(uploadUrl, start, end, body.size, body.slice(start, end), signal);
      }
    } catch (error) {
      void resilientFetch(uploadUrl, { method: "DELETE", signal, credentials: "omit", redirect: "error", cache: "no-store" }, {
        operation: "MDBX2 OneDrive 取消上传会话", fetcher: this.fetcher, maxAttempts: 1
      }, () => undefined).catch(() => undefined);
      throw error;
    }
  }

  private async putUploadChunk(uploadUrl: string, start: number, end: number, total: number, chunk: Blob, signal?: AbortSignal): Promise<void> {
    await resilientFetch(uploadUrl, {
      method: "PUT", headers: { "Content-Range": `bytes ${start}-${end - 1}/${total}` }, body: chunk, signal,
      credentials: "omit", redirect: "error", cache: "no-store"
    }, {
      ...this.policy, operation: "MDBX2 OneDrive 上传分块", fetcher: this.fetcher, maxAttempts: 1, timeoutMs: this.policy.timeoutMs ?? 300_000
    }, async (response, requestSignal) => {
      if (!response.ok) throw providerHttpError("MDBX2 OneDrive 上传分块失败", response);
      if (end === total) return;
      const raw = await readBoundedJsonObject(response, MAX_METADATA_BYTES, "MDBX2 OneDrive 上传分块结果", requestSignal);
      const ranges = Array.isArray(raw.nextExpectedRanges) ? raw.nextExpectedRanges : [];
      if (!ranges.some(range => typeof range === "string" && range.startsWith(String(end)))) throw invalidMetadata();
    });
  }

  private async consumeDownload(
    response: Response,
    requestSignal: AbortSignal,
    normalized: string,
    expectedSize: number,
    maximumBytes: number,
    onChunk: (chunk: Uint8Array, offset: number) => Promise<void> | void
  ): Promise<Mdbx2RemoteDownloadResult> {
    if (response.status !== 200) throw providerHttpError(`MDBX2 OneDrive 下载 ${normalized} 失败`, response);
    const declared = contentLength(response.headers.get("content-length"), maximumBytes);
    const hasher = await createSHA256();
    hasher.init();
    let offset = 0;
    let received = 0;
    let pending = new Uint8Array(MDBX2_MAX_BINARY_CHUNK_BYTES);
    let pendingLength = 0;
    const emitPending = async () => {
      if (!pendingLength) return;
      const chunk = pending.slice(0, pendingLength);
      hasher.update(chunk);
      await onChunk(chunk, offset);
      offset += chunk.length;
      pending = new Uint8Array(MDBX2_MAX_BINARY_CHUNK_BYTES);
      pendingLength = 0;
    };
    const consume = async (source: Uint8Array) => {
      received += source.length;
      if (!Number.isSafeInteger(received) || received > maximumBytes) throw new Error("MDBX2 OneDrive 下载超过安全上限。");
      let start = 0;
      while (start < source.length) {
        requestSignal.throwIfAborted();
        const count = Math.min(source.length - start, MDBX2_MAX_BINARY_CHUNK_BYTES - pendingLength);
        pending.set(source.subarray(start, start + count), pendingLength);
        pendingLength += count;
        start += count;
        if (pendingLength === MDBX2_MAX_BINARY_CHUNK_BYTES) await emitPending();
      }
    };
    if (!response.body) {
      await consume(new Uint8Array(await response.arrayBuffer()));
    } else {
      const reader = response.body.getReader();
      const onAbort = () => { void reader.cancel(requestSignal.reason).catch(() => undefined); };
      requestSignal.addEventListener("abort", onAbort, { once: true });
      try {
        while (true) {
          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await reader.read();
          } catch (cause) {
            if (requestSignal.aborted) throw cause;
            throw new ProviderBodyReadNetworkError(cause);
          }
          if (result.done) break;
          await consume(result.value);
        }
      } finally {
        requestSignal.removeEventListener("abort", onAbort);
        reader.releaseLock();
      }
    }
    await emitPending();
    requestSignal.throwIfAborted();
    if (offset === 0 || offset !== received || offset !== expectedSize || declared !== undefined && declared !== offset) {
      throw new Error("MDBX2 OneDrive 下载大小与元数据不一致。");
    }
    return { path: normalized, sizeBytes: offset, sha256: hasher.digest("hex") };
  }

  private async requireIdentical(
    path: string,
    existing: Mdbx2RemoteObject,
    expectedSize: number,
    expectedSha256: string,
    signal?: AbortSignal
  ): Promise<Mdbx2RemoteObject> {
    if (existing.isDirectory || existing.sizeBytes !== undefined && existing.sizeBytes !== expectedSize) {
      throw new Error(`MDBX2 云同步不可变对象发生内容碰撞: ${path}`);
    }
    const downloaded = await this.download(path, expectedSize, () => undefined, signal);
    if (downloaded.sizeBytes !== expectedSize || downloaded.sha256 !== expectedSha256) {
      throw new Error(`MDBX2 云同步不可变对象发生内容碰撞: ${path}`);
    }
    return { ...existing, sizeBytes: expectedSize, etag: existing.etag || downloaded.etag, lastModified: existing.lastModified || downloaded.lastModified };
  }

  private async request<T>(url: string, init: RequestInit, operation: string, consume: ProviderResponseConsumer<T>): Promise<T> {
    assertGraphUrl(url);
    init.signal?.throwIfAborted();
    const token = await this.accessToken(init.signal || undefined);
    init.signal?.throwIfAborted();
    if (typeof token !== "string" || !/^[\x21-\x7e]{1,32768}$/.test(token)) throw new OneDriveAuthorizationError();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", "application/json");
    const isRead = !init.method || init.method === "GET";
    return resilientFetch(url, { ...init, headers, credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" }, {
      ...this.policy, operation, fetcher: this.fetcher, idempotent: isRead,
      // Never replay a write after an ambiguous result; putImmutable reconciles actual bytes.
      ...(!isRead ? { maxAttempts: 1, timeoutMs: this.policy.timeoutMs ?? 300_000 } : {})
    }, consume);
  }
}

function itemPathUrl(driveId: string, path: string): string {
  const encoded = normalizeMdbx2RemotePath(path).split("/").map(encodeURIComponent).join("/");
  return `${GRAPH}/drives/${encodeURIComponent(driveId)}/root:/${encoded}:`;
}

interface ParsedRemoteItem extends Mdbx2RemoteObject { itemId: string }

function parseRemoteItem(value: Record<string, unknown>, path: string, driveId: string): ParsedRemoteItem {
  if (!isObject(value.parentReference) || value.parentReference.driveId !== driveId) throw invalidMetadata();
  const itemId = itemIdPart(value.id);
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0) throw invalidMetadata();
  const isFolder = isObject(value.folder);
  const isFile = isObject(value.file);
  if (isFolder === isFile) throw invalidMetadata();
  return {
    path,
    isDirectory: isFolder,
    itemId,
    ...(isFolder ? {} : { sizeBytes: value.size as number }),
    ...(value.eTag === undefined ? {} : { etag: textField(value.eTag, 1024) }),
    ...(value.lastModifiedDateTime === undefined ? {} : { lastModified: textField(value.lastModifiedDateTime, 64) })
  };
}

/** DriveItem ids are opaque and wider than drive ids; only require printable ASCII without whitespace. */
function itemIdPart(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256 || !/^[\x21-\x7e]+$/.test(value)) throw invalidMetadata();
  return value;
}

function safeCapabilityUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 16384) throw invalidMetadata();
  let url: URL;
  try { url = new URL(value); } catch { throw invalidMetadata(); }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
    !CAPABILITY_SUFFIXES.some(suffix => url.hostname.endsWith(suffix))) throw invalidMetadata();
  return url.href;
}

function contentLength(value: string | null, maximum: number): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new Error("MDBX2 OneDrive 下载超过安全上限。");
  return parsed;
}

function normalizeDigest(value: string): string {
  const digest = value.toLocaleLowerCase("en-US");
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("MDBX2 云同步对象摘要无效。");
  return digest;
}

/** Personal OneDrive sometimes exposes the old annotation name; both carry a preauthenticated capability URL. */
function downloadAnnotation(item: Record<string, unknown>): unknown {
  return item["@microsoft.graph.downloadUrl"] ?? item["@content.downloadUrl"];
}

function annotationKeys(item: Record<string, unknown>): string {
  return Object.keys(item).filter(key => key.startsWith("@")).join(",") || "none";
}

function capabilityFrom(item: Record<string, unknown>, label: string, allowMissing: boolean): string | undefined {
  const value = downloadAnnotation(item);
  if (typeof value !== "string" || !value) {
    if (allowMissing) return undefined;
    throw new ProviderTransportError("client", `${label}（Graph 注解: ${annotationKeys(item)}），请重试。`, { operation: "MDBX2 OneDrive 下载", attempts: 1, retryable: false });
  }
  try {
    return safeDownloadUrl(value);
  } catch {
    let host = "格式无效";
    try { host = new URL(value).hostname; } catch { /* keep placeholder */ }
    throw new ProviderTransportError("client", `${label}（下载地址主机 ${host} 不在允许列表），请重试。`, { operation: "MDBX2 OneDrive 下载", attempts: 1, retryable: false });
  }
}

function textField(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) throw invalidMetadata();
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

function invalidMetadata(): ProviderTransportError {
  return new ProviderTransportError("client", "MDBX2 OneDrive 文件信息无效，请重新同步。", { operation: "MDBX2 OneDrive 元数据", attempts: 1, retryable: false });
}
