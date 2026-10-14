import { describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { captureNearbyNativeSource, nearbyNativeRootId, type NearbyNativeClient } from './native-source';
import type { Mdbx2CollectionSummary, Mdbx2ObjectRecord, Mdbx2ObjectSummary } from '../providers/mdbx2/native-contract';

const digest = 'a'.repeat(64);
function fixture() {
  const handle = randomUUID(), providerId = randomUUID(), owner = randomUUID(), revision = { vaultId: randomUUID(), revisionSha256: digest };
  const collection: Mdbx2CollectionSummary = { collectionId: owner, title: '.monica-root', favorite: true, archived: false, attachmentCount: 0, headCommitId: randomUUID(), deleted: false, updatedAt: '2026-10-14T00:00:00Z' };
  const active: Mdbx2ObjectSummary = { objectId: randomUUID(), collectionId: owner, objectTypeId: 'future-format', title: 'Keep original', payloadSchemaVersion: 7, headCommitId: randomUUID(), deleted: false, updatedAt: collection.updatedAt };
  const deleted = { ...active, objectId: randomUUID(), deleted: true };
  const record: Mdbx2ObjectRecord = { ...active, payloadJson: '{ "big":9007199254740993,"decimal":1.00000000000000001,"private":"synthetic" }' };
  const metadata = { writeRevision: { ...revision }, labels: [{ labelId: randomUUID(), collectionId: owner, name: 'Unassigned', payloadSchemaVersion: 8, payloadJson: '{"unknown":9007199254740993}', headCommitId: randomUUID(), deleted: false, updatedAt: collection.updatedAt }], assignments: [], relations: [] };
  const client = {
    readWriteRevision: vi.fn(async () => ({ ...revision })),
    listCollections: vi.fn(async (_handle, input) => ({ items: input?.deleted ? [] : [{ ...collection }] })),
    listObjects: vi.fn(async (_handle, _owner, input) => ({ items: [{ ...(input?.deleted ? deleted : active) }] })),
    revealObject: vi.fn(async (_handle: string, id: string, _timeout?: number, retained?: boolean) => ({ ...record, ...(id === deleted.objectId && retained ? deleted : {}) })),
    readContentMetadata: vi.fn(async () => structuredClone(metadata)),
    readContentAttachments: vi.fn(async () => ({ writeRevision: { ...revision }, attachments: [] }))
  } satisfies NearbyNativeClient;
  const input: { providerId: string; vaultHandle: string } = { providerId, vaultHandle: handle };
  return { client, input, handle, providerId, collection, active, deleted, record, revision, metadata, read: (signal?: AbortSignal) => captureNearbyNativeSource(client, input, signal) };
}

describe('complete nearby native source inventory', () => {
  it('matches Android Java name UUID while never recognizing root by title', async () => {
    const f = fixture(), bytes = createHash('md5').update(`monica-root:${f.revision.vaultId}`).digest(); bytes[6] = bytes[6] & 15 | 0x30; bytes[8] = bytes[8] & 63 | 0x80;
    const hex = bytes.toString('hex'), expected = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    expect(await nearbyNativeRootId(f.revision.vaultId)).toBe(expected);
    const result = await f.read(); expect(result.rootId).toBe(expected); expect(result.rootId).not.toBe(f.collection.collectionId);
  });
  it('retains unknown schemas, exact payload lexemes, unassigned labels and explicitly disclosed trash', async () => {
    const f = fixture(), result = await f.read();
    expect(result.objects.find(row => row.summary.objectId === f.active.objectId)?.record?.payloadJson).toBe(f.record.payloadJson);
    expect(result.objects.find(row => row.summary.objectId === f.deleted.objectId)).toEqual({ summary: f.deleted, record: {...f.record,...f.deleted} });
    expect(result.metadata).toEqual(f.metadata); expect(f.client.revealObject).toHaveBeenCalledTimes(2);
    expect(f.client.revealObject).toHaveBeenCalledWith(f.handle, f.active.objectId, 30_000, false);
    expect(f.client.revealObject).toHaveBeenCalledWith(f.handle, f.deleted.objectId, 30_000, true);
    expect(f.client.readContentMetadata).toHaveBeenCalledWith(f.handle, { writeRevision: f.revision, collectionIds: [f.collection.collectionId], objectIds: [f.active.objectId, f.deleted.objectId] }, undefined);
  });
  it('snapshots provider/handle before awaiting the engine', async () => {
    const f = fixture(); f.client.readWriteRevision.mockImplementationOnce(async () => { f.input.providerId = 'changed'; f.input.vaultHandle = randomUUID(); return f.revision; });
    const result = await f.read(); expect(result.providerId).toBe(f.providerId); expect(result.vaultHandle).toBe(f.handle);
  });
  it('paginates all owners and objects, retaining both deleted and active queries', async () => {
    const f = fixture(), other = { ...f.collection, collectionId: randomUUID(), title: 'Another' };
    f.client.listCollections.mockImplementation(async (_handle, input) => input?.deleted ? { items: [] } : input?.cursor ? { items: [other] } : { items: [f.collection], nextCursor: 'page-2' });
    f.client.listObjects.mockImplementation(async (_handle, owner, input) => ({ items: owner === f.collection.collectionId ? [input?.deleted ? f.deleted : f.active] : [] }));
    expect((await f.read()).collections).toHaveLength(2); expect(f.client.listObjects).toHaveBeenCalledTimes(4);
  });
  it.each(['collection-duplicate', 'collection-deleted', 'object-owner', 'object-duplicate', 'disclosure', 'final-revision', 'metadata-revision', 'attachments-revision', 'cursor'])('rejects %s without returning a partial scan', async problem => {
    const f = fixture();
    if (problem === 'collection-duplicate') f.client.listCollections.mockResolvedValue({ items: [f.collection, f.collection] });
    if (problem === 'collection-deleted') f.collection.deleted = true;
    if (problem === 'object-owner') f.active.collectionId = randomUUID();
    if (problem === 'object-duplicate') f.client.listObjects.mockResolvedValue({ items: [f.active, f.active] });
    if (problem === 'disclosure') f.record.title = 'Changed after listing';
    if (problem === 'final-revision') f.client.readWriteRevision.mockResolvedValueOnce(f.revision).mockResolvedValue({ ...f.revision, revisionSha256: 'b'.repeat(64) });
    if (problem === 'metadata-revision') f.metadata.writeRevision.revisionSha256 = 'b'.repeat(64);
    if (problem === 'attachments-revision') f.client.readContentAttachments.mockResolvedValue({ writeRevision: { ...f.revision, revisionSha256: 'b'.repeat(64) }, attachments: [] });
    if (problem === 'cursor') f.client.listCollections.mockImplementation(async () => ({ items: [], nextCursor: 'nonempty-cursor' }));
    await expect(f.read()).rejects.toThrow();
  });
  it.each(['before', 'revision', 'objects', 'metadata', 'attachments'])('cancels source collection during %s', async when => {
    const f = fixture(), abort = new AbortController();
    if (when === 'before') abort.abort();
    if (when === 'revision') f.client.readWriteRevision.mockImplementationOnce(async () => { abort.abort(); return f.revision; });
    if (when === 'objects') f.client.revealObject.mockImplementationOnce(async () => { abort.abort(); return f.record; });
    if (when === 'metadata') f.client.readContentMetadata.mockImplementationOnce(async () => { abort.abort(); return f.metadata; });
    if (when === 'attachments') f.client.readContentAttachments.mockImplementationOnce(async () => { abort.abort(); return { writeRevision: f.revision, attachments: [] }; });
    await expect(f.read(abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('does not swallow native policy errors or synthesize a missing payload', async () => {
    const f = fixture(); f.client.revealObject.mockRejectedValue(Error('native policy denial')); await expect(f.read()).rejects.toThrow('native policy denial');
  });
  it('bounds an individual disclosure', async () => {
    const f = fixture(); f.record.payloadJson = 'x'.repeat(1024 * 1024 + 1); await expect(f.read()).rejects.toMatchObject({ code: 'native-payload-limit' });
  });
});
