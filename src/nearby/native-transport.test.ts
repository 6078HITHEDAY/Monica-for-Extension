import { describe, expect, it, vi } from "vitest";
import { appendNearbyAsset, NearbyNativeTransport, nearbySha256, readNearbyAsset } from "./native-transport";
import { bytesToBase64, base64ToBytes } from "../security/encoding";
import type { Mdbx2NativeClient } from "../providers/mdbx2/native-client";
import { parseLosslessJson } from '../core/lossless-json';

const uuid = "12345678-1234-4234-8234-123456789012";
const encoder = new TextEncoder();
const pack = (value: unknown) => ({ json: JSON.stringify(value) });
const native = (execute: (method: string, params: Record<string, unknown>) => Promise<unknown>) => {
  let largeOutput: Uint8Array | undefined;
  const client: Pick<Mdbx2NativeClient, "request" | "close"> = {
    request: vi.fn(async (method, params) => {
      if (method === 'host.hello') return { nearbyTransportVersion: 2 };
      if (largeOutput && method === 'nearby.output.read') {
        const start = params.offset as number, end = Math.min(start + 256 * 1024, largeOutput.length);
        return { data: bytesToBase64(largeOutput.subarray(start, end)), next_offset: end, size: largeOutput.length };
      }
      if (largeOutput && method === 'nearby.output.release') { largeOutput = undefined; return {}; }
      const response = await execute(method, params);
      // An asset's base64 JSON can itself exceed a native frame. Model the
      // Host's envelope chunking rather than returning an impossible inline reply.
      if (response && typeof response === 'object' && 'json' in response && typeof response.json === 'string') {
        const bytes = encoder.encode(response.json);
        if (bytes.length > 600 * 1024) { largeOutput = bytes; return { handle: uuid, size: bytes.length, sha256: await nearbySha256(bytes) }; }
      }
      return response;
    }), close: vi.fn()
  };
  return { client, transport: new NearbyNativeTransport(client) };
};

describe("nearby native boundary", () => {
  it.each([undefined, 1, '1', true, 2])('uses only an exact optional host capability and keeps old-v2 compatibility (%s)', async capability => {
    const client = { request: vi.fn(async (method: string) => method === 'host.hello'
      ? { nearbyTransportVersion: 2, nearbyIncrementalSync: capability } : pack({ ready: true })), close: vi.fn() };
    const transport = new NearbyNativeTransport(client);
    expect(transport.supportsIncrementalSync).toBe(false);
    expect(await transport.call('replica_revision', { handle: uuid })).toEqual({ ready: true });
    expect(transport.supportsIncrementalSync).toBe(capability === 1);
    expect(client.close).not.toHaveBeenCalled();
  });
  it('preserves numeric lexemes and literal marker keys through both directions, including small uploads', async () => {
    const json = '{"clock":{"peer":9007199254740993},"decimal":1.00000000000000001,"huge":1e999,"zero":-0,"__proto__":{"safe":true},"$serde_json::private::Number":"literal"}';
    const source = parseLosslessJson(json) as Record<string, unknown>;
    const chunks: Uint8Array[] = [];
    const { transport, client } = native(async (method, params) => {
      if (method === 'nearby.input.begin') return { handle: uuid, chunk_bytes: 256 * 1024 };
      if (method === 'nearby.input.chunk') { const chunk = base64ToBytes(params.data as string); chunks.push(chunk); return { next_offset: chunk.length }; }
      expect(method).toBe('nearby.input.finish');
      expect(chunks).toHaveLength(1);
      expect(new TextDecoder().decode(chunks[0])).toBe(`{"operation":"replica_scan_batch","params":${json}}`);
      return { json };
    });
    const result = await transport.call('replica_scan_batch', source);
    expect(JSON.stringify(result)).toBe(json);
    expect(vi.mocked(client.request).mock.calls.some(([method]) => method === 'nearby.call')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true);
    expect(({} as { safe?: unknown }).safe).toBeUndefined();
  });

  it('refuses a version-one host before any operation and sanitizes invalid JSON', async () => {
    const client = { request: vi.fn(async () => ({ nearbyTransportVersion: 1 })), close: vi.fn() };
    await expect(new NearbyNativeTransport(client).call('start')).rejects.toMatchObject({ code: 'host-update-required' });
    expect(client.request).toHaveBeenCalledTimes(1);
    const { transport } = native(async () => ({ json: '{"password":"synthetic-secret" broken' }));
    await expect(transport.call('replica_pending')).rejects.toThrow('JSON 数据无效。');
  });

  it("requires the transport version and never probes the network from an old host", async () => {
    const client = { request: vi.fn(async () => ({})), close: vi.fn() };
    const transport = new NearbyNativeTransport(client);
    await expect(transport.call("start")).rejects.toMatchObject({ code: "host-update-required" });
    expect(client.request).toHaveBeenCalledTimes(1); expect(client.close).toHaveBeenCalledOnce();
    await expect(transport.call("start")).rejects.toMatchObject({ code: "closed" });
  });

  it("chunks a rich project above one native frame without changing bytes", async () => {
    const chunks: Uint8Array[] = []; let uploadHash = ""; let byteSize = 0; let received = 0;
    const data = { passwords: [{ password: "synthetic\n中文" }], unknown: "x".repeat(1_200_000), passkey: { id: "AQID", counter: 0, privateKey: "bytes-unchanged" } };
    const { transport } = native(async (method, p) => {
      if (method === "nearby.input.begin") { uploadHash = p.sha256 as string; byteSize = p.size as number; return { handle: uuid, chunk_bytes: 256 * 1024 }; }
      if (method === "nearby.input.chunk") {
        expect(p.offset).toBe(received); const bytes = base64ToBytes(p.data as string);
        expect(bytes.length).toBeLessThanOrEqual(256 * 1024); chunks.push(bytes); received += bytes.length; return { next_offset: received };
      }
      expect(method).toBe("nearby.input.finish");
      const bytes = new Uint8Array(received); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      expect(bytes.length).toBe(byteSize); expect(await nearbySha256(bytes)).toBe(uploadHash);
      expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ operation: "replica_scan_batch", params: { data } });
      return pack({ accepted: true });
    });
    await expect(transport.call("replica_scan_batch", { data })).resolves.toEqual({ accepted: true });
    expect(chunks.length).toBeGreaterThan(4);
  });

  it("assembles large pending results with a complete hash and releases the buffer", async () => {
    const value = { entries: [{ data: "y".repeat(1_200_000) }] }; const bytes = encoder.encode(JSON.stringify(value)); const sha = await nearbySha256(bytes);
    const { transport, client } = native(async (method, p) => {
      if (method === "nearby.call") return { handle: uuid, size: bytes.length, sha256: sha };
      if (method === "nearby.output.release") return {};
      expect(method).toBe("nearby.output.read"); const start = p.offset as number; const end = Math.min(start + 256 * 1024, bytes.length);
      return { data: bytesToBase64(bytes.subarray(start, end)), next_offset: end, size: bytes.length };
    });
    await expect(transport.call("replica_pending", { handle: uuid })).resolves.toEqual(value);
    expect(client.request).toHaveBeenLastCalledWith("nearby.output.release", { handle: uuid });
  });

  it.each(["wrong-hash", "wrong-offset", "wrong-size", "empty-chunk"])("rejects %s without returning partial secrets", async fault => {
    const bytes = encoder.encode('{"password":"synthetic"}'); const sha = await nearbySha256(bytes);
    const { transport, client } = native(async method => {
      if (method === "nearby.call") return { handle: uuid, size: bytes.length, sha256: fault === "wrong-hash" ? "0".repeat(64) : sha };
      if (method === "nearby.output.release") return {};
      return { data: fault === "empty-chunk" ? "" : bytesToBase64(bytes), next_offset: fault === "wrong-offset" ? 1 : bytes.length, size: fault === "wrong-size" ? 1 : bytes.length };
    });
    await expect(transport.call("replica_pending")).rejects.toThrow();
    expect(client.request).toHaveBeenCalledWith("nearby.output.release", { handle: uuid });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("closes its dedicated host immediately on cancellation and sends no later chunks", async () => {
    const controller = new AbortController();
    const { transport, client } = native(async method => {
      if (method === "nearby.input.begin") return { handle: uuid, chunk_bytes: 256 * 1024 };
      if (method === "nearby.input.chunk") { controller.abort(); return { next_offset: 256 * 1024 }; }
      throw new Error("unexpected native write");
    });
    await expect(transport.call("replica_scan_batch", { data: "secret".repeat(150_000) }, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(client.close).toHaveBeenCalled();
    expect(vi.mocked(client.request).mock.calls.filter(([method]) => method === "nearby.input.chunk")).toHaveLength(1);
    expect(vi.mocked(client.request).mock.calls.some(([method]) => method === "nearby.input.finish")).toBe(false);
  });

  it("rejects already-lossy inputs and legacy parsed native envelopes", async () => {
    for (const value of [undefined, NaN, Infinity, 9007199254740992, new Date(), [undefined]]) {
      const { transport, client } = native(async () => pack({}));
      await expect(transport.call("replica_scan_batch", { value })).rejects.toMatchObject({ code: "invalid-json" });
      expect(client.request).toHaveBeenCalledTimes(1);
    }
    const { transport } = native(async () => ({ value: { clock: { peer: 9007199254740992 } } }));
    await expect(transport.call("replica_pending")).rejects.toThrow();
  });

  it("serializes operations and does not replay a mutation after uncertain failure", async () => {
    let reject: (reason: Error) => void = () => {};
    const { transport, client } = native(() => new Promise((_, no) => { reject = no; }));
    const first = transport.call("replica_scan_end"); const second = transport.call("replica_export");
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(2));
    reject(new Error("native request timed out"));
    await expect(first).rejects.toThrow("timed out"); await expect(second).rejects.toMatchObject({ code: "closed" });
    expect(client.request).toHaveBeenCalledTimes(2);
  });
});

describe("nearby authenticated assets", () => {
  it("reassembles two chunks and verifies the declared whole-file hash", async () => {
    const bytes = new Uint8Array(600_000).fill(23); const id = await nearbySha256(bytes);
    const { transport } = native(async (_, p) => {
      if (p.operation === "asset_list") return pack({ items: [{ id, offset: 20 }] });
      const offset = (p.params as Record<string, unknown>).offset;
      const index = offset === 20 ? 0 : 1; const chunk = bytes.subarray(index * 512 * 1024, (index + 1) * 512 * 1024);
      return pack({ id, index, final: index === 1, data: bytesToBase64(chunk), next: 600_500 });
    });
    await expect(readNearbyAsset(transport, uuid, { id, size: bytes.length })).resolves.toEqual(bytes);
  });

  it.each(["duplicate", "wrong-index", "wrong-bytes", "oversized", "missing"])("fails closed for %s assets", async fault => {
    const bytes = encoder.encode("test"); const id = await nearbySha256(bytes);
    const { transport } = native(async (_, p) => {
      if (p.operation === "asset_list") return pack({ items: fault === "missing" ? [] : Array.from({ length: fault === "duplicate" ? 2 : 1 }, () => ({ id, offset: 20 })) });
      return pack({ id, index: fault === "wrong-index" ? 1 : 0, final: true, data: bytesToBase64(fault === "wrong-bytes" ? encoder.encode("oops") : fault === "oversized" ? encoder.encode("extra") : bytes), next: 50 });
    });
    await expect(readNearbyAsset(transport, uuid, { id, size: bytes.length })).rejects.toThrow();
  });

  it("sends an empty file once and verifies bytes before any append", async () => {
    const bytes = new Uint8Array(); const id = await nearbySha256(bytes);
    const { transport, client } = native(async () => pack({}));
    await appendNearbyAsset(transport, uuid, { id, size: 0 }, bytes);
    expect(client.request).toHaveBeenLastCalledWith("nearby.call", { operation: "asset_append", params: { handle: uuid, id, index: 0, final: true, data: "" } });
    await expect(appendNearbyAsset(transport, uuid, { id: "0".repeat(64), size: 0 }, bytes)).rejects.toMatchObject({ code: "asset-integrity" });
    expect(client.request).toHaveBeenCalledTimes(2);
  });
});
