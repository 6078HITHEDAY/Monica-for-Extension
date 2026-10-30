import { describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readMdbx2ContentAttachments, readMdbx2ContentAttachmentBytes, type Mdbx2ContentAttachment } from './content-attachments';
import type { Mdbx2HostCapabilities, Mdbx2NativeMethod } from './native-contract';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture(bytes = Buffer.from(Array.from({ length: 600_000 }, (_, n) => n % 251))) {
  const handle = randomUUID(), owner = randomUUID(), readHandle = randomUUID();
  const revision = { vaultId: randomUUID(), revisionSha256: 'a'.repeat(64) };
  const attachment: Mdbx2ContentAttachment = { attachmentId: randomUUID(), collectionId: owner, objectId: null,
    fileName: 'synthetic folder asset.bin', mediaType: null, storageMode: 'embedded-chunked', contentHash: sha(bytes),
    originalSize: bytes.length, storedSize: bytes.length, chunkCount: 3, headCommitId: randomUUID(), deleted: false, updatedAt: '2026-10-14T00:00:00Z' };
  const objectAttachment = { ...attachment, attachmentId: randomUUID(), objectId: randomUUID() };
  const tombstone = { ...attachment, attachmentId: randomUUID(), deleted: true };
  const foreignTombstone = { ...tombstone, attachmentId: randomUUID(), collectionId: randomUUID() };
  const caps = { supportsContentAttachments: true, supportsVaultWriteRevision: true } as Mdbx2HostCapabilities;
  const hello = vi.fn(async () => caps);
  const respond = async (method: Mdbx2NativeMethod, params: Record<string, unknown> = {}): Promise<any> => {
    if (method === 'vault.writeRevision') return { ...revision };
    if (method === 'content.attachments.list') return { collectionId: params.collectionId, items: structuredClone(params.collectionId === null ? [tombstone, foreignTombstone] : [attachment, objectAttachment]), nextCursor: null, writeRevision: { ...revision } };
    if (method === 'content.attachments.begin') return { readHandle, attachmentId: attachment.attachmentId, fileName: attachment.fileName, mediaType: attachment.mediaType, sizeBytes: bytes.length, maxChunkBytes: 262144, metadata: { ...attachment }, writeRevision: { ...revision } };
    if (method === 'attachment.read.release') return { released: true };
    if (method === 'attachment.read.chunk') {
      const offset = params.offset as number, nextOffset = Math.min(bytes.length, offset + 262144);
      return { readHandle, attachmentId: attachment.attachmentId, fileName: attachment.fileName, mediaType: attachment.mediaType, sizeBytes: bytes.length, offset, nextOffset, eof: nextOffset === bytes.length, dataBase64: bytes.subarray(offset, nextOffset).toString('base64') };
    }
    throw Error('Unexpected synthetic RPC');
  };
  const request = vi.fn(respond), client = { hello, request };
  const input = { writeRevision: { ...revision }, collectionIds: [owner] };
  const byteInput = { writeRevision: { ...revision }, attachment: { ...attachment } };
  return { handle, owner, readHandle, revision, attachment, objectAttachment, tombstone, foreignTombstone, input, byteInput, caps, hello, request, respond, bytes,
    read: (signal?: AbortSignal) => readMdbx2ContentAttachments(client, handle, input, signal),
    download: (signal?: AbortSignal) => readMdbx2ContentAttachmentBytes(client, handle, byteInput, signal) };
}

describe('revision-bound native attachment catalog', () => {
  it('keeps collection and object owners, hashes and tombstones without requesting plaintext', async () => {
    const f = fixture(); expect(await f.read()).toEqual({ writeRevision: f.revision, attachments: [f.attachment, f.objectAttachment, f.tombstone] });
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['content.attachments.list', 'content.attachments.list', 'vault.writeRevision']);
  });
  it('reads every page and queries global tombstones once', async () => {
    const f = fixture();
    f.request.mockImplementation(async (method, params) => {
      const result = await f.respond(method, params);
      if (method === 'content.attachments.list' && params?.collectionId !== null) {
        result.items = [params?.cursor ? f.objectAttachment : f.attachment]; result.nextCursor = params?.cursor ? null : 'synthetic-cursor';
      }
      return result;
    });
    expect((await f.read()).attachments).toHaveLength(3);
    expect(f.request.mock.calls.filter(([method, params]) => method === 'content.attachments.list' && params?.collectionId === null)).toHaveLength(1);
  });
  it('snapshots inputs before capabilities resolve', async () => {
    const f = fixture(); f.hello.mockImplementationOnce(async () => { f.input.collectionIds[0] = randomUUID(); f.input.writeRevision.revisionSha256 = 'b'.repeat(64); return f.caps; });
    expect((await f.read()).attachments).toHaveLength(3);
  });
  it.each(['supportsContentAttachments', 'supportsVaultWriteRevision'] as const)('requires %s for both APIs', async key => {
    const f = fixture(); delete f.caps[key];
    await expect(f.read()).rejects.toMatchObject({ code: 'content-attachments-host-update-required' });
    await expect(f.download()).rejects.toMatchObject({ code: 'content-attachments-host-update-required' }); expect(f.request).not.toHaveBeenCalled();
  });
  it.each(['owner', 'deleted', 'duplicate', 'cursor', 'empty-cursor', 'hash', 'size', 'extra', 'page-size', 'oversize-response'])('rejects malformed %s catalog results', async problem => {
    const f = fixture();
    f.request.mockImplementation(async (method, params) => {
      const result = await f.respond(method, params);
      if (method === 'content.attachments.list') {
        if (problem === 'owner') result.items[0].collectionId = randomUUID();
        if (problem === 'deleted') result.items[0].deleted = true;
        if (problem === 'duplicate') result.items = [result.items[0], result.items[0]];
        if (problem === 'cursor') result.nextCursor = 'repeated';
        if (problem === 'empty-cursor') { result.items = []; result.nextCursor = 'cursor'; }
        if (problem === 'hash') result.items[0].contentHash = 'bad';
        if (problem === 'size') result.items[0].storedSize = Number.MAX_SAFE_INTEGER + 1;
        if (problem === 'extra') result.items[0].payload = 'unexpected';
        if (problem === 'page-size') result.items = Array.from({ length: 51 }, () => ({ ...result.items[0], attachmentId: randomUUID() }));
        if (problem === 'oversize-response') result.items[0].fileName = 'x'.repeat(851 * 1024);
      }
      return result;
    });
    await expect(f.read()).rejects.toMatchObject({ code: 'content-attachments-invalid' });
  });
  it('bounds total row count even when tombstones belong to other collections', async () => {
    const f = fixture(); let pages = 0;
    f.request.mockImplementation(async (method, params) => {
      if (method === 'content.attachments.list') return { collectionId: params?.collectionId, items: Array.from({ length: 50 }, () => ({ ...f.foreignTombstone, attachmentId: randomUUID() })), nextCursor: `page-${++pages}`, writeRevision: f.revision };
      return f.respond(method, params);
    });
    // First active page is empty; the deleted global query consumes the budget.
    f.request.mockImplementationOnce(async (_method, params) => ({ collectionId: params?.collectionId, items: [], nextCursor: null, writeRevision: f.revision }));
    await expect(f.read()).rejects.toMatchObject({ code: 'content-attachments-invalid' }); expect(pages).toBe(201);
  });
  it('rejects duplicate owner input before contacting the engine', async () => {
    const f = fixture(); f.input.collectionIds.push(f.owner); await expect(f.read()).rejects.toMatchObject({ code: 'content-attachments-invalid' }); expect(f.hello).not.toHaveBeenCalled();
  });
  it('bounds aggregate metadata bytes across otherwise valid pages', async () => {
    const f = fixture(); let pages = 0;
    f.request.mockImplementation(async (method, params) => {
      if (method === 'content.attachments.list') return { collectionId: params?.collectionId, items: Array.from({ length: 4 }, () => ({ ...f.attachment, attachmentId: randomUUID(), fileName: 'x'.repeat(64000), mediaType: 'y'.repeat(64000) })), nextCursor: `page-${++pages}`, writeRevision: f.revision };
      return f.respond(method, params);
    });
    await expect(f.read()).rejects.toMatchObject({ code: 'content-attachments-invalid' }); expect(pages).toBeLessThan(70);
  });
  it.each(['before', 'capabilities', 'page', 'final'])('cancels catalog reads at %s', async when => {
    const f = fixture(), cancel = new AbortController();
    if (when === 'before') cancel.abort();
    if (when === 'capabilities') f.hello.mockImplementationOnce(async () => { cancel.abort(); return f.caps; });
    f.request.mockImplementation(async (method, params) => { const result = await f.respond(method, params); if (method === ({ page: 'content.attachments.list', final: 'vault.writeRevision' }[when])) cancel.abort(); return result; });
    await expect(f.read(cancel.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('rejects a concurrent content change at the final boundary', async () => {
    const f = fixture(); f.request.mockImplementation(async (method, params) => method === 'vault.writeRevision' ? { ...f.revision, revisionSha256: 'b'.repeat(64) } : f.respond(method, params));
    await expect(f.read()).rejects.toMatchObject({ code: 'content-attachments-stale', retryable: true });
  });
});

describe('verified native attachment download', () => {
  it('reads exact multi-chunk bytes, verifies their native hash and releases the session', async () => {
    const f = fixture(), read = await f.download(); expect(Buffer.from(read)).toEqual(f.bytes);
    expect(f.request.mock.calls.filter(([method]) => method === 'attachment.read.chunk')).toHaveLength(3);
    expect(f.request.mock.calls[f.request.mock.calls.length - 1]).toEqual(['attachment.read.release', { readHandle: f.readHandle }, 5000]);
  });
  it('supports zero-byte attachments without invalid chunk requests', async () => {
    const f = fixture(Buffer.alloc(0)); expect(await f.download()).toHaveLength(0); expect(f.request.mock.calls.some(([method]) => method === 'attachment.read.chunk')).toBe(false);
  });
  it('snapshots the selected metadata before any await', async () => {
    const f = fixture(); f.hello.mockImplementationOnce(async () => { f.byteInput.attachment.fileName = 'mutated'; f.byteInput.writeRevision.revisionSha256 = 'b'.repeat(64); return f.caps; });
    expect(sha(await f.download())).toBe(sha(f.bytes));
  });
  it.each(['deleted', 'oversize'])('rejects %s content without opening a read', async problem => {
    const f = fixture(); if (problem === 'deleted') f.byteInput.attachment.deleted = true; else f.byteInput.attachment.storedSize = 64 * 1024 * 1024 + 1;
    await expect(f.download()).rejects.toMatchObject({ code: 'content-attachments-invalid' }); expect(f.hello).not.toHaveBeenCalled();
  });
  it.each(['begin', 'chunk', 'final', 'release'])('releases native buffers on cancellation during %s', async when => {
    const f = fixture(), cancel = new AbortController();
    f.request.mockImplementation(async (method, params) => { const result = await f.respond(method, params); if (method === ({ begin: 'content.attachments.begin', chunk: 'attachment.read.chunk', final: 'vault.writeRevision', release: 'attachment.read.release' }[when])) cancel.abort(); return result; });
    await expect(f.download(cancel.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(f.request.mock.calls[f.request.mock.calls.length - 1]?.[0]).toBe('attachment.read.release');
  });
  it.each(['metadata', 'begin-extra', 'begin-size', 'chunk-id', 'offset', 'eof', 'base64', 'hash', 'chunk-error', 'final-revision'])('rejects %s and releases staged plaintext', async problem => {
    const f = fixture();
    f.request.mockImplementation(async (method, params) => {
      const result = await f.respond(method, params);
      if (method === 'content.attachments.begin') {
        if (problem === 'metadata') result.metadata.headCommitId = randomUUID();
        if (problem === 'begin-extra') result.extra = true;
        if (problem === 'begin-size') result.sizeBytes++;
      }
      if (method === 'attachment.read.chunk') {
        if (problem === 'chunk-id') result.attachmentId = randomUUID();
        if (problem === 'offset') result.nextOffset--;
        if (problem === 'eof') result.eof = true;
        if (problem === 'base64') result.dataBase64 += '\n';
        if (problem === 'hash') { const changed = Buffer.from(result.dataBase64, 'base64'); changed[0] ^= 1; result.dataBase64 = changed.toString('base64'); }
        if (problem === 'chunk-error') throw Error('synthetic read failure');
      }
      if (method === 'vault.writeRevision' && problem === 'final-revision') result.revisionSha256 = 'b'.repeat(64);
      return result;
    });
    await expect(f.download()).rejects.toThrow(); expect(f.request.mock.calls[f.request.mock.calls.length - 1]?.[0]).toBe('attachment.read.release');
  });
  it('does not allocate a read session when already cancelled', async () => {
    const f = fixture(), cancel = new AbortController(); cancel.abort(); await expect(f.download(cancel.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(f.hello).not.toHaveBeenCalled();
  });
});
