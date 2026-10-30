import { describe, expect, it, vi } from "vitest";
import { attachmentSha256, readVerifiedAttachment, type AttachmentReader } from "./attachment-reader";
import { bytesToBase64 } from "../security/encoding";
import type { WalletAsset } from "../core/password-content";

function fixture(bytes = new Uint8Array([1, 2, 3])) {
  const attachment = { attachmentId: "a", providerKind: "mdbx2" as const, fileName: "wallet-a", sizeBytes: bytes.length, protected: true, mediaType: "image/png" };
  const client = {
    listProviderAttachments: vi.fn(async () => ({ items: [attachment] })),
    beginProviderAttachmentRead: vi.fn(async () => ({ ...attachment, readHandle: "h", maxChunkBytes: 262144 as const })),
    readProviderAttachmentChunk: vi.fn(async () => ({ ...attachment, readHandle: "h", offset: 0, nextOffset: bytes.length, dataBase64: bytesToBase64(bytes), eof: true })),
    releaseProviderAttachmentRead: vi.fn(async () => true)
  } satisfies AttachmentReader;
  return { client, bytes };
}
describe("bounded verified attachment disclosure", () => {
  it("loads a visible gallery without exceeding the backend's four active downloads", async () => {
    const { client } = fixture();
    const begun = await client.beginProviderAttachmentRead();
    const chunk = await client.readProviderAttachmentChunk();
    const handles = new Set<string>(); let peak = 0;
    client.beginProviderAttachmentRead.mockImplementation(async () => {
      if (handles.size >= 4) throw new Error('同时进行的附件下载过多，请稍后重试。');
      const readHandle=crypto.randomUUID();handles.add(readHandle);peak=Math.max(peak,handles.size);
      return {...begun,readHandle};
    });
    client.readProviderAttachmentChunk.mockImplementation(async (_provider?: string, handle?: string) => {
      await new Promise(resolve=>setTimeout(resolve,10));return {...chunk,readHandle:handle!};
    });
    client.releaseProviderAttachmentRead.mockImplementation(async (_provider?: string,handle?: string)=>{handles.delete(handle!);return true;});
    const results=await Promise.allSettled(Array.from({length:12},()=>readVerifiedAttachment(client,'local','card','wallet-a')));
    expect(results.filter(result=>result.status==='rejected')).toEqual([]);
    expect(peak).toBeLessThanOrEqual(4);expect(handles.size).toBe(0);
  });
  it('retries only a confirmed capacity rejection from another manager window',async()=>{
    const {client}=fixture(),start=await client.beginProviderAttachmentRead();
    client.beginProviderAttachmentRead.mockReset().mockRejectedValueOnce(Object.assign(new Error('Busy'),{code:'attachment-read-limit'})).mockResolvedValue(start);
    await expect(readVerifiedAttachment(client,'p','i','wallet-a')).resolves.toMatchObject({bytes:new Uint8Array([1,2,3])});
    expect(client.beginProviderAttachmentRead).toHaveBeenCalledTimes(2);expect(client.releaseProviderAttachmentRead).toHaveBeenCalledTimes(1);
    client.beginProviderAttachmentRead.mockReset().mockRejectedValue(new Error('Lost response'));
    await expect(readVerifiedAttachment(client,'p','i','wallet-a')).rejects.toThrow('Lost response');
    expect(client.beginProviderAttachmentRead).toHaveBeenCalledTimes(1);
  });
  it('removes cancelled queued reads before listing or allocating any attachment',async()=>{
    const {client}=fixture(),chunk=await client.readProviderAttachmentChunk();
    let finish!:()=>void;const hold=new Promise<void>(resolve=>finish=resolve);
    client.readProviderAttachmentChunk.mockImplementation(async()=>{await hold;return chunk;});
    const first=readVerifiedAttachment(client,'p','i','wallet-a'),second=readVerifiedAttachment(client,'p','i','wallet-a');
    const controller=new AbortController();const queued=readVerifiedAttachment(client,'p','i','wallet-a',undefined,controller.signal);
    controller.abort();await expect(queued).rejects.toMatchObject({name:'AbortError'});finish();await Promise.all([first,second]);
    expect(client.listProviderAttachments).toHaveBeenCalledTimes(2);
    expect(client.beginProviderAttachmentRead).toHaveBeenCalledTimes(2);
    await expect(readVerifiedAttachment(client,'p','i','wallet-a')).resolves.toBeDefined();
  });
  it("checks complete bytes and releases handle including empty files", async () => {
    for (const bytes of [new Uint8Array([0, 255, 3]), new Uint8Array()]) {
      const { client } = fixture(bytes);
      const expected: WalletAsset = { name: "wallet-a", displayName: "file", role: "ATTACHMENT", mimeType: "application/octet-stream", size: bytes.length, sha256: await attachmentSha256(bytes) };
      expect((await readVerifiedAttachment(client, "p", "i", "wallet-a", expected)).bytes).toEqual(bytes);
      expect(client.releaseProviderAttachmentRead).toHaveBeenCalledWith("p", "h");
    }
  });
  it("rejects a missing blob, duplicate name and repeating pagination cursor", async () => {
    const { client } = fixture();
    client.listProviderAttachments.mockResolvedValue({ items: [] });
    await expect(readVerifiedAttachment(client, "p", "i", "wallet-a")).rejects.toThrow("缺失");
    const { client: duplicate } = fixture(); const page = await duplicate.listProviderAttachments();
    duplicate.listProviderAttachments.mockResolvedValue({ items: [...page.items, ...page.items] });
    await expect(readVerifiedAttachment(duplicate, "p", "i", "wallet-a")).rejects.toThrow("重复");
    const repeating = { ...client, listProviderAttachments: vi.fn(async () => ({ items: [], nextCursor: "repeat" })) };
    await expect(readVerifiedAttachment(repeating, "p", "i", "wallet-a")).rejects.toThrow("分页");
    expect(repeating.listProviderAttachments).toHaveBeenCalledTimes(2);
  });
  it("rejects wrong hash and short/misidentified chunks without exposing bytes", async () => {
    const { client } = fixture();
    await expect(readVerifiedAttachment(client, "p", "i", "wallet-a", { name: "wallet-a", displayName: "f", role: "CARD_FACE", size: 3, mimeType: "image/png", sha256: "0".repeat(64) })).rejects.toThrow("SHA-256");
    client.readProviderAttachmentChunk.mockResolvedValue({ ...await client.readProviderAttachmentChunk(), readHandle: "wrong" });
    await expect(readVerifiedAttachment(client, "p", "i", "wallet-a")).rejects.toThrow("分段");
    expect(client.releaseProviderAttachmentRead).toHaveBeenCalledTimes(2);
  });
  it("cancels on lock or unmount and releases even when cancellation occurs during begin", async () => {
    const { client } = fixture(); const abort = new AbortController();
    const start = await client.beginProviderAttachmentRead();
    client.beginProviderAttachmentRead.mockImplementation(async () => { abort.abort(); return start; });
    await expect(readVerifiedAttachment(client, "p", "i", "wallet-a", undefined, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(client.readProviderAttachmentChunk).not.toHaveBeenCalled();
    expect(client.releaseProviderAttachmentRead).toHaveBeenCalledWith("p", "h");
  });
});
