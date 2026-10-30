import { describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readMdbx2ContentMetadata } from "./content-metadata";
import type { Mdbx2HostCapabilities, Mdbx2NativeMethod } from "./native-contract";

const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
function fixture(bytes = Buffer.from('{"big":9007199254740993,"decimal":1.00000000000000001,"secret":"密🔑"}')) {
  const handle = randomUUID(), owner = randomUUID(), source = randomUUID();
  const revision = { vaultId: randomUUID(), revisionSha256: "a".repeat(64) };
  const base = { headCommitId: randomUUID(), deleted: false, updatedAt: "2026-10-14T00:00:00Z" };
  const label = { ...base, labelId: randomUUID(), collectionId: owner, name: "Synthetic root", payloadSchemaVersion: 3 };
  const assignment = { ...base, assignmentId: randomUUID(), objectId: source, labelId: label.labelId, deleted: true };
  const relation = { ...base, relationId: randomUUID(), sourceObjectId: source, targetObjectId: randomUUID(), relationKind: "com.monica.synthetic", payloadSchemaVersion: 7 };
  const caps = { supportsContentMetadata: true, supportsVaultWriteRevision: true } as Mdbx2HostCapabilities;
  const hello = vi.fn(async () => caps);
  const respond = async (method: Mdbx2NativeMethod, params: Record<string, unknown> = {}): Promise<unknown> => {
    if (method === "vault.writeRevision") return { ...revision };
    if (method === "content.metadata.list") {
      return { kind: params.kind, ownerId: params.ownerId, items: [{ ...({ labels: label, assignments: assignment, relations: relation }[params.kind as string]!) }], nextCursor: null, writeRevision: { ...revision } };
    }
    if (method === "content.metadata.read") {
      const row = params.kind === "label" ? label : relation;
      const { headCommitId: _head, updatedAt: _date, ...metadata } = row;
      const offset = params.offset as number, nextOffset = Math.min(bytes.length, offset + (params.limit as number));
      return { kind: params.kind, id: params.id, metadata, sizeBytes: bytes.length, sha256: sha(bytes), offset, nextOffset, done: nextOffset === bytes.length, dataBase64: bytes.subarray(offset, nextOffset).toString("base64"), writeRevision: { ...revision } };
    }
    throw Error("Unexpected synthetic RPC");
  };
  const request = vi.fn(respond);
  const input = { writeRevision: { ...revision }, collectionIds: [owner], objectIds: [source] };
  const read = (signal?: AbortSignal) => readMdbx2ContentMetadata({ hello, request }, handle, input, signal);
  return { handle, owner, source, revision, base, label, assignment, relation, caps, hello, request, respond, input, read };
}

describe("revision-bound native content metadata", () => {
  it("preserves opaque JSON, schemas, tombstones and original IDs across multiple chunks", async () => {
    const original = '{"big":9007199254740993,"decimal":1.00000000000000001,"secret":"' + "密🔑".repeat(50000) + '"}';
    const f = fixture(Buffer.from(original));
    const read = await f.read();
    expect(read).toEqual({ writeRevision: f.revision, labels: [{ ...f.label, payloadJson: original }], assignments: [f.assignment], relations: [{ ...f.relation, payloadJson: original }] });
    expect(f.request.mock.calls.filter(([method]) => method === "content.metadata.read")).toHaveLength(4);
    expect(f.request.mock.calls[f.request.mock.calls.length - 1]?.[0]).toBe("vault.writeRevision");
  });

  it("retains tombstones without bypassing native deleted-payload policy", async () => {
    const f = fixture(); f.label.deleted = true; f.relation.deleted = true;
    const result = await f.read();
    expect(result.labels[0]).toEqual({ ...f.label, payloadJson: null });
    expect(result.relations[0]).toEqual({ ...f.relation, payloadJson: null });
    expect(f.request.mock.calls.some(([method]) => method === "content.metadata.read")).toBe(false);
  });

  it("snapshots request owners and revisions before waiting for capabilities", async () => {
    const f = fixture();
    f.hello.mockImplementationOnce(async () => {
      f.input.collectionIds[0] = randomUUID(); f.input.objectIds.splice(0); f.input.writeRevision.revisionSha256 = "b".repeat(64);
      return f.caps;
    });
    const result = await f.read();
    expect(result.writeRevision).toEqual(f.revision);
    expect(result.labels[0].collectionId).toBe(f.owner);
    expect(result.relations).toHaveLength(1);
    expect(f.request.mock.calls.filter(([method]) => method !== "vault.writeRevision").every(([, params]) => params?.writeRevision && JSON.stringify(params.writeRevision) === JSON.stringify(f.revision))).toBe(true);
  });

  it.each(["supportsContentMetadata", "supportsVaultWriteRevision"] as const)("fails usefully for an older engine without %s", async key => {
    const f = fixture(); delete f.caps[key];
    await expect(f.read()).rejects.toMatchObject({ code: "content-metadata-host-update-required" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(["before", "capabilities", "page", "chunk", "final"])("cancels at %s without returning partial content", async when => {
    const f = fixture(), abort = new AbortController();
    if (when === "before") abort.abort();
    if (when === "capabilities") f.hello.mockImplementationOnce(async () => { abort.abort(); return f.caps; });
    f.request.mockImplementation(async (method, params) => {
      const result = await f.respond(method, params);
      if ((when === "page" && method === "content.metadata.list") || (when === "chunk" && method === "content.metadata.read") || (when === "final" && method === "vault.writeRevision")) abort.abort();
      return result;
    });
    await expect(f.read(abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    if (when === "before") expect(f.hello).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong owner", (p: any) => { p.ownerId = randomUUID(); }],
    ["wrong kind", (p: any) => { p.kind = "relations"; }],
    ["stale revision", (p: any) => { p.writeRevision.revisionSha256 = "b".repeat(64); }],
    ["wrong vault", (p: any) => { p.writeRevision.vaultId = randomUUID(); }],
    ["extra envelope field", (p: any) => { p.extra = true; }],
    ["extra row field", (p: any) => { p.items[0].extra = true; }],
    ["wrong row owner", (p: any) => { p.items[0].collectionId = randomUUID(); }],
    ["duplicate IDs", (p: any) => { p.items.push({ ...p.items[0] }); }],
    ["oversized page", (p: any) => { p.items = Array.from({ length: 201 }, () => p.items[0]); }],
    ["invalid tombstone", (p: any) => { p.items[0].deleted = 1; }],
    ["invalid schema", (p: any) => { p.items[0].payloadSchemaVersion = -1; }],
    ["missing cursor", (p: any) => { delete p.nextCursor; }],
    ["empty cursor", (p: any) => { p.nextCursor = ""; }],
    ["empty nonterminal page", (p: any) => { p.items = []; p.nextCursor = "next"; }],
  ] as const)("rejects %s in the catalog", async (_name, mutate) => {
    const f = fixture(); f.request.mockImplementation(async (method, params) => {
      const response = await f.respond(method, params); if (method === "content.metadata.list") mutate(response); return response;
    });
    await expect(f.read()).rejects.toMatchObject({ code: "content-metadata-invalid" });
  });

  it("rejects a repeated cursor before trusting more pages", async () => {
    const f = fixture(); f.request.mockImplementation(async (method, params) => {
      const response: any = await f.respond(method, params);
      if (method === "content.metadata.list") { response.nextCursor = "same"; response.items[0].labelId = randomUUID(); }
      return response;
    });
    await expect(f.read()).rejects.toMatchObject({ code: "content-metadata-invalid" });
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["wrong ID", (p: any) => { p.id = randomUUID(); }],
    ["wrong kind", (p: any) => { p.kind = "relation"; }],
    ["stale revision", (p: any) => { p.writeRevision.revisionSha256 = "b".repeat(64); }],
    ["changed summary", (p: any) => { p.metadata.name = "Changed"; }],
    ["extra metadata", (p: any) => { p.metadata.extra = true; }],
    ["wrong digest", (p: any) => { p.sha256 = "b".repeat(64); }],
    ["oversized content", (p: any) => { p.sizeBytes = 1048577; }],
    ["wrong offset", (p: any) => { p.offset = 1; }],
    ["nonprogress", (p: any) => { p.nextOffset = 0; p.done = false; }],
    ["wrong completion", (p: any) => { p.done = false; }],
    ["truncated bytes", (p: any) => { p.dataBase64 = "AA=="; }],
    ["invalid base64", (p: any) => { p.dataBase64 = "*"; }],
    ["noncanonical base64", (p: any) => { p.dataBase64 += "\n"; }],
  ] as const)("rejects %s in a content chunk", async (_name, mutate) => {
    const f = fixture(); f.request.mockImplementation(async (method, params) => {
      const response = await f.respond(method, params); if (method === "content.metadata.read") mutate(response); return response;
    });
    await expect(f.read()).rejects.toMatchObject({ code: "content-metadata-invalid" });
  });

  it("rejects non-UTF8 payloads even with matching hashes", async () => {
    await expect(fixture(Buffer.from([0xff, 0xfe])).read()).rejects.toMatchObject({ code: "content-metadata-invalid" });
  });

  it("rejects a revision change after the last chunk", async () => {
    const f = fixture(); f.request.mockImplementation(async (method, params) => method === "vault.writeRevision" ? { ...f.revision, revisionSha256: "b".repeat(64) } : f.respond(method, params));
    await expect(f.read()).rejects.toMatchObject({ code: "content-metadata-invalid" });
  });

  it("rejects duplicate input owners before native requests", async () => {
    const f = fixture(); f.input.collectionIds.push(f.owner);
    await expect(f.read()).rejects.toMatchObject({ code: "content-metadata-invalid" });
    expect(f.hello).not.toHaveBeenCalled();
  });
});
