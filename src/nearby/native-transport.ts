import type { Mdbx2NativeClient } from "../providers/mdbx2/native-client";
import { base64ToBytes, bytesToBase64 } from "../security/encoding";
import { parseLosslessJson } from "../core/lossless-json";

export type NearbyOperation =
  | "replica_open" | "replica_close" | "replica_scan_begin" | "replica_scan_batch" | "replica_scan_end"
  | "replica_revision" | "replica_local" | "replica_resolve" | "replica_rebind" | "replica_export"
  | "replica_merge" | "replica_pending" | "replica_applied_batch" | "snapshot_release"
  | "asset_append" | "asset_list" | "asset_read" | "start" | "connect" | "progress"
  | "cancel" | "release" | "acknowledge" | "discover" | "discovery_result" | "close_all";

const CHUNK = 256 * 1024;
const INLINE = 600 * 1024;
const MAX_INPUT = 8 * 1024 * 1024;
const MAX_OUTPUT = 16 * 1024 * 1024;
const encoder = new TextEncoder();

export class NearbyTransportError extends Error {
  constructor(readonly code: string) { super(`Nearby: ${code}.`); this.name = "NearbyTransportError"; }
}
const invalid = () => new NearbyTransportError("invalid-response");

export function nearbyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function handle(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value)) throw invalid();
  return value;
}
function size(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw invalid();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw invalid();
  return value;
}
function binary(value: unknown, limit: number): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil(limit / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw invalid();
  const bytes = base64ToBytes(value);
  if (bytes.length > limit) { bytes.fill(0); throw invalid(); }
  return bytes;
}
export async function nearbySha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  try { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", copy)), b => b.toString(16).padStart(2, "0")).join(""); }
  finally { copy.fill(0); }
}

/** Reject values JSON.stringify would silently change or omit. Raw numeric
 * lexemes from the shared lossless parser remain raw throughout this boundary. */
function jsonValue(value: unknown, depth = 0, seen = new Set<object>()): boolean {
  if (depth > 64) throw new NearbyTransportError("request-depth-limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return false;
  if ((JSON as typeof JSON & { isRawJSON?: (value: unknown) => boolean }).isRawJSON?.(value)) {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?$/.test((value as { rawJSON: string }).rawJSON)) throw new NearbyTransportError("invalid-json");
    return true;
  }
  if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return false;
  if (typeof value !== "object" || !value || seen.has(value)) throw new NearbyTransportError("invalid-json");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new NearbyTransportError("invalid-json");
  seen.add(value);
  let raw = false;
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) raw = jsonValue(value[i], depth + 1, seen) || raw; }
  else for (const entry of Object.values(value)) raw = jsonValue(entry, depth + 1, seen) || raw;
  seen.delete(value);
  return raw;
}

/** Give this class its own native port. Closing/aborting it stops all its LAN
 * workers without interrupting the independent MDBX/autofill host connection.
 * No UI/runtime message is registered here; application adoption and consent are
 * separate prerequisites before enabling nearby sync for users. */
export class NearbyNativeTransport {
  private closed = false;
  private ready = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly client: Pick<Mdbx2NativeClient, "request" | "close">) {}

  close(): void { this.closed = true; this.client.close(); }

  call(operation: NearbyOperation, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    const run = this.tail.then(async () => {
      this.check(signal);
      const abort = () => this.close();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (!this.ready) {
          const hello = nearbyObject(await this.client.request("host.hello", {}));
          this.check(signal);
          if (hello.nearbyTransportVersion !== 2) throw new NearbyTransportError("host-update-required");
          this.ready = true;
        }
        return await this.execute(operation, params, signal);
      } catch (error) {
        // A timed-out mutation may have succeeded. Never silently reconnect and
        // repeat it; reopen the encrypted replica in a new explicit session.
        this.close();
        if (signal?.aborted) throw new NearbyTransportError("cancelled");
        throw error;
      } finally { signal?.removeEventListener("abort", abort); }
    });
    this.tail = run.catch(() => {});
    return run;
  }

  private check(signal?: AbortSignal): void {
    if (signal?.aborted) throw new NearbyTransportError("cancelled");
    if (this.closed) throw new NearbyTransportError("closed");
  }

  private async execute(operation: NearbyOperation, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const raw = jsonValue(params);
    const bytes = encoder.encode(JSON.stringify({ operation, params }));
    let upload: string | undefined;
    try {
      if (bytes.length > MAX_INPUT) throw new NearbyTransportError("request-size-limit");
      let result: unknown;
      // Send serialized JSON text through the upload path even for small values.
      // Browser structured-message serialization must not reinterpret RawJSON.
      if (bytes.length <= INLINE && !raw) result = await this.client.request("nearby.call", { operation, params });
      else {
        const sha256 = await nearbySha256(bytes); this.check(signal);
        const begin = nearbyObject(await this.client.request("nearby.input.begin", { size: bytes.length, sha256 }));
        upload = handle(begin.handle);
        if (begin.chunk_bytes !== CHUNK) throw invalid();
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
          this.check(signal);
          const end = Math.min(bytes.length, offset + CHUNK);
          const part = nearbyObject(await this.client.request("nearby.input.chunk", { handle: upload, offset, data: bytesToBase64(bytes.subarray(offset, end)) }));
          if (part.next_offset !== end) throw invalid();
        }
        this.check(signal);
        result = await this.client.request("nearby.input.finish", { handle: upload });
        upload = undefined;
      }
      this.check(signal);
      return await this.unpack(result, signal);
    } finally {
      bytes.fill(0);
      if (upload && !this.closed) await this.client.request("nearby.input.release", { handle: upload }).catch(() => {});
    }
  }

  private async unpack(input: unknown, signal?: AbortSignal): Promise<unknown> {
    const value = nearbyObject(input);
    if (Object.prototype.hasOwnProperty.call(value, "json")) {
      if (Object.keys(value).length !== 1) throw invalid();
      if (typeof value.json !== "string" || encoder.encode(value.json).length > INLINE) throw invalid();
      const parsed = parseLosslessJson(value.json);
      jsonValue(parsed);
      return parsed;
    }
    const output = handle(value.handle);
    const length = size(value.size, MAX_OUTPUT);
    const sha256 = hash(value.sha256);
    if (!length) throw invalid();
    const bytes = new Uint8Array(length);
    try {
      let offset = 0;
      while (offset < length) {
        this.check(signal);
        const result = nearbyObject(await this.client.request("nearby.output.read", { handle: output, offset }));
        this.check(signal);
        const part = binary(result.data, CHUNK);
        try {
          if (!part.length || offset + part.length > length || result.next_offset !== offset + part.length || result.size !== length) throw invalid();
          bytes.set(part, offset); offset += part.length;
        } finally { part.fill(0); }
      }
      if (await nearbySha256(bytes) !== sha256) throw new NearbyTransportError("response-integrity");
      this.check(signal);
      const result: unknown = parseLosslessJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      jsonValue(result);
      return result;
    } finally {
      bytes.fill(0);
      if (!this.closed) await this.client.request("nearby.output.release", { handle: output }).catch(() => {});
    }
  }
}

export interface NearbyAsset { id: string; size: number }

export async function appendNearbyAsset(transport: NearbyNativeTransport, snapshot: string, asset: NearbyAsset, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
  const expected = size(asset.size, 64 * 1024 * 1024);
  if (bytes.length !== expected || await nearbySha256(bytes) !== hash(asset.id)) throw new NearbyTransportError("asset-integrity");
  let offset = 0;
  do {
    const end = Math.min(bytes.length, offset + 512 * 1024);
    await transport.call("asset_append", { handle: snapshot, id: asset.id, index: offset / (512 * 1024), final: end === bytes.length, data: bytesToBase64(bytes.subarray(offset, end)) }, signal);
    offset = end;
  } while (offset < bytes.length);
}

export async function readNearbyAsset(transport: NearbyNativeTransport, session: string, asset: NearbyAsset, signal?: AbortSignal): Promise<Uint8Array> {
  const length = size(asset.size, 64 * 1024 * 1024); const expectedHash = hash(asset.id);
  const listing = nearbyObject(await transport.call("asset_list", { session }, signal));
  if (!Array.isArray(listing.items) || listing.items.length > 100_000) throw invalid();
  const ids = new Set<string>(); let offset: number | undefined;
  for (const entry of listing.items) {
    const item = nearbyObject(entry); const id = hash(item.id);
    if (ids.has(id)) throw new NearbyTransportError("duplicate-asset");
    ids.add(id);
    if (id === expectedHash) offset = size(item.offset, 512 * 1024 * 1024);
  }
  if (offset === undefined) throw new NearbyTransportError("asset-missing");
  const bytes = new Uint8Array(length); let written = 0; let index = 0;
  try {
    for (;;) {
      const result = nearbyObject(await transport.call("asset_read", { session, offset }, signal));
      const part = binary(result.data, 512 * 1024);
      try {
        if (result.id !== expectedHash || result.index !== index++ || typeof result.final !== "boolean" || written + part.length > length || (result.final === false && part.length !== 512 * 1024)) throw new NearbyTransportError("asset-integrity");
        bytes.set(part, written); written += part.length;
        if (result.final) break;
        const next = size(result.next, 512 * 1024 * 1024);
        if (next <= offset) throw new NearbyTransportError("asset-integrity");
        offset = next;
      } finally { part.fill(0); }
    }
    if (written !== length || await nearbySha256(bytes) !== expectedHash) throw new NearbyTransportError("asset-integrity");
    return bytes;
  } catch (error) { bytes.fill(0); throw error; }
}
