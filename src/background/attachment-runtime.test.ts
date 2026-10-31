import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAttachmentRuntime, type AttachmentDependencies, type AttachmentRequest } from './attachment-runtime';
import { createCommandExecutor, commandHandler } from './command-router';
import { ProviderOperationQueue } from './provider-operation-queue';
import { createLoginItem, type ProviderAccount } from '../core/model';
import type { ProviderAttachmentReadBeginResult, ProviderAttachmentUploadBeginResult } from '../providers/attachments/attachment-contract';

const root = 'chrome-extension://synthetic/';
const sender = { id: 'synthetic', url: `${root}index.html` };
const operationId = '11111111-1111-4111-8111-111111111111';
beforeEach(() => vi.stubGlobal('chrome', { runtime: { id: 'synthetic', getURL: (path: string) => root + path } }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function fixture() {
  const account: ProviderAccount = { id: 'source', kind: 'monica-webdav', enabled: true, name: 'Synthetic', isDefaultSaveTarget: false, config: { backupPassword: 'synthetic' } };
  const target: ProviderAccount = { ...account, id: 'target' };
  const item = { ...createLoginItem({ title: 'Synthetic' }), id: 'item', providerRefs: [{ providerId: account.id }, { providerId: target.id, remoteId: 'object', remoteFolderId: 'collection' }] };
  const attachment = { attachmentId: 'file', fileName: 'test.bin', sizeBytes: 3, mediaType: 'application/octet-stream', providerKind: 'monica-webdav', protected: true };
  const adapter = {
    addAttachment: vi.fn(async () => attachment),
    readAttachment: vi.fn(async () => ({ ...attachment, bytes: Uint8Array.of(1, 2, 3) })),
    deleteAttachment: vi.fn(async () => ({ changed: true }))
  };
  const service = {
    getProvider: vi.fn(async (id: string) => id === target.id ? target : account), getItem: vi.fn(async () => item),
    assertNoBitwardenMdbxMove: vi.fn(async () => {}), assertNoNearbyNativeSequence: vi.fn(async () => {})
  };
  const queue = new ProviderOperationQueue(), run = vi.spyOn(queue, 'run');
  const executeCommand = createCommandExecutor(service as Parameters<typeof createCommandExecutor>[0], queue);
  const native = {
    beginAttachmentUpload: vi.fn(async () => ({ transferId: 'native-upload', nextOffset: 0, maxChunkBytes: 256 * 1024 })),
    sendAttachmentUploadChunk: vi.fn(async () => ({ transferId: 'native-upload', nextOffset: 3, acceptedBytes: 3, repeated: false })),
    finishAttachmentUpload: vi.fn(async () => ({ changed: true, attachment })),
    abortAttachmentUpload: vi.fn(async () => true),
    beginAttachmentRead: vi.fn(async () => ({ ...attachment, readHandle: 'native-read', maxChunkBytes: 256 * 1024 })),
    readAttachmentChunk: vi.fn(async () => ({ ...attachment, readHandle: 'native-read', offset: 0, nextOffset: 3, dataBase64: 'AQID', eof: true })),
    releaseAttachmentRead: vi.fn(async () => true)
  };
  const dependencies = {
    service, mdbx2NativeClient: native, keePassProvider: {}, monicaWebDavProvider: adapter,
    localAttachments: { clear: vi.fn() }, bitwardenAttachmentDownloads: { clear: vi.fn() }, bitwardenAttachmentMutations: {},
    ensureKeePassSession: vi.fn(), loadBitwardenAttachmentContext: vi.fn(), persistBitwardenSession: vi.fn(),
    acknowledgeBitwardenAttachmentMutation: vi.fn(), clearBitwardenOrganizationKeys: vi.fn(), executeKeePassDurableMutation: vi.fn(), executeCommand
  };
  const runtime = createAttachmentRuntime(dependencies as unknown as AttachmentDependencies);
  const invoke = (request: AttachmentRequest) => executeCommand(request, sender, commandHandler(runtime.handlers, request)!);
  const begin = () => invoke({ type: 'PROVIDER_ATTACHMENT_UPLOAD_BEGIN', providerId: account.id, itemId: item.id, fileName: 'test.bin', sizeBytes: 3, operationId }) as Promise<ProviderAttachmentUploadBeginResult>;
  return { account, target, item, attachment, adapter, service, native, run, runtime, invoke, begin };
}

describe('attachment runtime through the command interface', () => {
  it('routes WebDAV BEGIN/CHUNK/FINISH through one upload lifecycle and replays completion once', async () => {
    const f = fixture(), upload = await f.begin();
    await f.invoke({ type: 'PROVIDER_ATTACHMENT_UPLOAD_CHUNK', providerId: f.account.id, transferId: upload.transferId, offset: 0, dataBase64: 'AQID' });
    const request = { type: 'PROVIDER_ATTACHMENT_UPLOAD_FINISH', providerId: f.account.id, itemId: f.item.id, transferId: upload.transferId, operationId } as const;
    const result = await f.invoke(request);
    expect(result).toMatchObject({ changed: true, attachment: { fileName: 'test.bin' } });
    expect(await f.invoke(request)).toEqual(result);
    expect(f.adapter.addAttachment).toHaveBeenCalledTimes(1);
    expect(f.adapter.addAttachment.mock.calls[0]).toHaveLength(4);
    f.runtime.clear();
  });

  it('allows an explicit retry after a failed write without acknowledging success', async () => {
    const f = fixture(), upload = await f.begin();
    await f.invoke({ type: 'PROVIDER_ATTACHMENT_UPLOAD_CHUNK', providerId: f.account.id, transferId: upload.transferId, offset: 0, dataBase64: 'AQID' });
    const request = { type: 'PROVIDER_ATTACHMENT_UPLOAD_FINISH', providerId: f.account.id, itemId: f.item.id, transferId: upload.transferId, operationId } as const;
    f.adapter.addAttachment.mockRejectedValueOnce(new Error('offline'));
    await expect(f.invoke(request)).rejects.toThrow('offline');
    await expect(f.invoke(request)).resolves.toMatchObject({ changed: true });
    expect(f.adapter.addAttachment).toHaveBeenCalledTimes(2);
    f.runtime.clear();
  });

  it('rejects a handle used by another provider before remote writes', async () => {
    const f = fixture(), upload = await f.begin();
    await expect(f.invoke({ type: 'PROVIDER_ATTACHMENT_UPLOAD_CHUNK', providerId: f.target.id, transferId: upload.transferId, offset: 0, dataBase64: 'AQID' })).rejects.toThrow();
    expect(f.adapter.addAttachment).not.toHaveBeenCalled(); f.runtime.clear();
  });

  it('clears upload and read handles on lock', async () => {
    const f = fixture(), upload = await f.begin();
    const read = await f.invoke({ type: 'PROVIDER_ATTACHMENT_READ_BEGIN', providerId: f.account.id, itemId: f.item.id, attachmentId: 'file' }) as ProviderAttachmentReadBeginResult;
    f.runtime.clear();
    await expect(f.invoke({ type: 'PROVIDER_ATTACHMENT_UPLOAD_CHUNK', providerId: f.account.id, transferId: upload.transferId, offset: 0, dataBase64: 'AQID' })).rejects.toThrow();
    await expect(f.invoke({ type: 'PROVIDER_ATTACHMENT_READ_CHUNK', providerId: f.account.id, readHandle: read.readHandle, offset: 0, maxBytes: 3 })).rejects.toThrow();
  });

  it('requires explicit deletion confirmation before invoking an adapter', async () => {
    const f = fixture();
    await expect(f.invoke({ type: 'PROVIDER_ATTACHMENT_DELETE', providerId: f.account.id, itemId: f.item.id, attachmentId: 'file', operationId, confirmed: false })).rejects.toThrow();
    expect(f.adapter.deleteAttachment).not.toHaveBeenCalled(); f.runtime.clear();
  });

  it('guards internal MDBX transfer writes without dispatching back through the global router', async () => {
    const f = fixture();
    f.target.kind = 'mdbx2'; f.target.config = { vaultHandle: 'native-vault' };
    await f.invoke({ type: 'PROVIDER_ATTACHMENT_TRANSFER', operationId, sourceProviderId: 'source', sourceItemId: 'item', sourceAttachmentId: 'file', targetProviderId: 'target', targetItemId: 'item', mode: 'copy', confirmedMove: false });
    expect(f.service.assertNoBitwardenMdbxMove).toHaveBeenCalledTimes(2);
    expect(f.service.assertNoNearbyNativeSequence).toHaveBeenCalledTimes(2);
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.native.beginAttachmentUpload).toHaveBeenCalledTimes(1);
    expect(f.native.finishAttachmentUpload).toHaveBeenCalledTimes(1);
    expect(f.adapter.deleteAttachment).not.toHaveBeenCalled(); f.runtime.clear();
  });
});
