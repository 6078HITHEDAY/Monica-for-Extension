import { describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { writeMdbx2Content, type Mdbx2ContentWriteInput } from './content-write';
import { Mdbx2NativeHostError, type Mdbx2HostCapabilities, type Mdbx2NativeMethod } from './native-contract';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const handle = randomUUID(), writeHandle = randomUUID(), commitId = randomUUID(), assetId = randomUUID();
  const caps = { supportsContentWrite: true, supportsVaultWriteRevision: true } as Mdbx2HostCapabilities;
  const input: Mdbx2ContentWriteInput = {
    operationId: randomUUID(), writeRevision: { vaultId: randomUUID(), revisionSha256: 'a'.repeat(64) },
    plan: { commands: [{ kind: 'object-update', objectId: randomUUID(), collectionId: randomUUID(), objectTypeId: 'passkey', title: 'Synthetic original', payloadJson: '{"id":"original","sign_count":0,"big":9007199254740993,"decimal":1.00000000000000001}' }],
      attachments: [{ kind: 'create', attachmentId: randomUUID(), collectionId: randomUUID(), fileName: 'synthetic.bin', assetId }] },
    assets: [{ id: assetId, bytes: Uint8Array.from({ length: 600_000 }, (_, n) => n % 251) }]
  };
  const parts = new Map<string, Buffer>(); let begin: any;
  const respond = async (method: Mdbx2NativeMethod, params: Record<string, unknown> = {}): Promise<unknown> => {
    if (method === 'content.write.begin') { begin = structuredClone(params); return { writeHandle, maxChunkBytes: 262144 }; }
    if (method === 'content.write.chunk') {
      const id = params.partId as string, previous = parts.get(id) || Buffer.alloc(0); expect(params.offset).toBe(previous.length);
      const bytes = Buffer.from(params.dataBase64 as string, 'base64'); parts.set(id, Buffer.concat([previous, bytes]));
      return { writeHandle, partId: id, nextOffset: previous.length + bytes.length, repeated: false };
    }
    if (method === 'content.write.finish') {
      for (const descriptor of [{ id: 'plan', ...begin.plan }, ...begin.assets]) {
        const bytes = parts.get(descriptor.id) || Buffer.alloc(0); expect(bytes.length).toBe(descriptor.sizeBytes); expect(sha(bytes)).toBe(descriptor.sha256);
      }
      return { operationId: begin.operationId, commitId, alreadyCommitted: false };
    }
    if (method === 'content.write.abort') return { released: true };
    throw Error('unexpected synthetic RPC');
  };
  const hello = vi.fn(async () => caps), request = vi.fn(respond);
  const write = (signal?: AbortSignal) => writeMdbx2Content({ hello, request }, handle, input, signal);
  return { handle, input, caps, hello, request, respond, write, parts, writeHandle, commitId };
}

describe('atomic native content staging client', () => {
  it('preserves original IDs, zero counters, exact number lexemes and multi-chunk assets', async () => {
    const f = fixture(); const original = structuredClone(f.input);
    const receipt = await f.write();
    expect(receipt).toEqual({ operationId: original.operationId, commitId: f.commitId, alreadyCommitted: false });
    expect(JSON.parse(f.parts.get('plan')!.toString())).toEqual(original.plan);
    expect(f.parts.get(original.assets[0].id)!.equals(Buffer.from(original.assets[0].bytes))).toBe(true);
    expect({ ...f.input, assets: [] }).toEqual({ ...original, assets: [] });
    expect(sha(f.input.assets[0].bytes)).toBe(sha(original.assets[0].bytes)); expect(f.request.mock.calls.some(([method]) => method === 'content.write.abort')).toBe(false);
  });
  it('snapshots revision, plan and asset bytes before waiting for capabilities', async () => {
    const f = fixture(), original = structuredClone(f.input);
    f.hello.mockImplementationOnce(async () => {
      f.input.operationId = randomUUID(); f.input.writeRevision.revisionSha256 = 'b'.repeat(64);
      (f.input.plan.commands[0] as any).payloadJson = '{}'; f.input.assets[0].bytes.fill(9); return f.caps;
    });
    expect((await f.write()).operationId).toBe(original.operationId);
    expect(JSON.parse(f.parts.get('plan')!.toString())).toEqual(original.plan);
    expect(f.parts.get(original.assets[0].id)!.equals(Buffer.from(original.assets[0].bytes))).toBe(true);
    expect(f.request.mock.calls[0][1]?.writeRevision).toEqual(original.writeRevision);
  });
  it.each(['supportsContentWrite', 'supportsVaultWriteRevision'] as const)('requires %s in older engines', async key => {
    const f = fixture(); delete f.caps[key]; await expect(f.write()).rejects.toMatchObject({ code: 'content-write-host-update-required' }); expect(f.request).not.toHaveBeenCalled();
  });
  it.each(['before', 'hello', 'begin', 'chunk'])('aborts safely before finish at %s', async when => {
    const f = fixture(), abort = new AbortController();
    if (when === 'before') abort.abort();
    if (when === 'hello') f.hello.mockImplementationOnce(async () => { abort.abort(); return f.caps; });
    f.request.mockImplementation(async (method, params) => { const response = await f.respond(method, params); if (method === `content.write.${when}`) abort.abort(); return response; });
    await expect(f.write(abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.request.mock.calls.some(([method]) => method === 'content.write.finish')).toBe(false);
    expect(f.request.mock.calls.some(([method]) => method === 'content.write.abort')).toBe(['begin', 'chunk'].includes(when));
  });
  it('returns a confirmed receipt when cancellation races the commit', async () => {
    const f = fixture(), abort = new AbortController();
    f.request.mockImplementation(async (method, params) => { const result = await f.respond(method, params); if (method === 'content.write.finish') abort.abort(); return result; });
    expect((await f.write(abort.signal)).commitId).toBe(f.commitId);
  });
  it('distinguishes a definite revision rejection from an uncertain transport outcome', async () => {
    const f = fixture(); f.request.mockImplementation(async (method, params) => {
      if (method === 'content.write.finish') throw new Mdbx2NativeHostError('content-write-stale', 'synthetic native revision rejection', true);
      return f.respond(method, params);
    });
    await expect(f.write()).rejects.toMatchObject({ code: 'content-write-stale', retryable: true });
  });
  it.each(['transport', 'malformed receipt'])('marks %s after finish as unknown and keeps the operation ID', async failure => {
    const f = fixture(); f.request.mockImplementation(async (method, params) => {
      const result = await f.respond(method, params);
      if (method === 'content.write.finish') { if (failure === 'transport') throw Error('synthetic transport secret'); return { ...(result as object), commitId: 'bad' }; }
      return result;
    });
    await expect(f.write()).rejects.toMatchObject({ code: 'content-write-outcome-unknown', operationId: f.input.operationId });
    expect(f.request.mock.calls[f.request.mock.calls.length - 1]?.[0]).toBe('content.write.abort');
  });
  it.each(['wrong handle', 'wrong part', 'wrong offset', 'extra field', 'invalid repeated'])('rejects %s in upload acknowledgements', async mutation => {
    const f = fixture(); f.request.mockImplementation(async (method, params) => {
      const result: any = await f.respond(method, params);
      if (method === 'content.write.chunk') {
        if (mutation === 'wrong handle') result.writeHandle = randomUUID();
        if (mutation === 'wrong part') result.partId = 'other';
        if (mutation === 'wrong offset') result.nextOffset++;
        if (mutation === 'extra field') result.extra = true;
        if (mutation === 'invalid repeated') result.repeated = 'false';
      }
      return result;
    });
    await expect(f.write()).rejects.toMatchObject({ code: 'content-write-invalid' });
    expect(f.request.mock.calls[f.request.mock.calls.length - 1]?.[0]).toBe('content.write.abort');
    expect(f.request.mock.calls.some(([method]) => method === 'content.write.finish')).toBe(false);
  });
  it.each(['unknown command field', 'duplicate asset', 'missing asset', 'unreferenced asset', 'too many commands', 'invalid Unicode'])('rejects %s before any RPC', async mutation => {
    const f = fixture();
    if (mutation === 'unknown command field') (f.input.plan.commands[0] as any).extra = true;
    if (mutation === 'duplicate asset') f.input.assets = [f.input.assets[0], f.input.assets[0]];
    if (mutation === 'missing asset') f.input.assets = [];
    if (mutation === 'unreferenced asset') f.input.plan.attachments = [];
    if (mutation === 'too many commands') f.input.plan.commands = Array.from({ length: 129 }, () => f.input.plan.commands[0]);
    if (mutation === 'invalid Unicode') (f.input.plan.commands[0] as any).title = '\ud800';
    await expect(f.write()).rejects.toMatchObject({ code: 'content-write-invalid' }); expect(f.hello).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });
  it('supports attachment-only writes including empty assets', async () => {
    const f = fixture(); f.input.plan.commands = []; f.input.assets[0].bytes = new Uint8Array();
    expect((await f.write()).commitId).toBe(f.commitId);
    expect(f.request.mock.calls.filter(([method]) => method === 'content.write.chunk')).toHaveLength(1);
  });
});
