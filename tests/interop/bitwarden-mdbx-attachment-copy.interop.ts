import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { bitwardenTransferFixture } from '../fixtures/bitwarden-transfer-attachment';
import { ProcessNativeRuntime } from './mdbx2-interop-support';
import { Mdbx2NativeClient } from '../../src/providers/mdbx2/native-client';
import { Mdbx2Provider } from '../../src/providers/mdbx2/mdbx2-provider';
import { Mdbx2BatchTransferCoordinator } from '../../src/providers/mdbx2/mdbx2-batch-transfer-coordinator';
import { Mdbx2TransferAttachmentService } from '../../src/providers/mdbx2/mdbx2-transfer-attachments';
import { mdbx2TransferUuid } from '../../src/providers/mdbx2/mdbx2-transfer-identity';
import { BitwardenAttachmentDownloadService } from '../../src/providers/bitwarden/bitwarden-attachments';
import { BitwardenTransferAttachmentSource } from '../../src/providers/bitwarden/bitwarden-transfer-attachments';
import { SecureVaultService } from '../../src/security/secure-vault-service';
import { MemoryVaultSessionStore } from '../../src/security/vault-session';
import type { VaultEnvelopeStorage } from '../../src/security/vault-storage';
import type { VaultEnvelope } from '../../src/security/vault-crypto';
import type { ProviderAccount } from '../../src/core/model';
import { base64ToBytes } from '../../src/security/encoding';
import { LocalAttachmentService } from '../../src/providers/attachments/local-attachments';
import { LocalTransferCoordinator } from '../../src/providers/attachments/local-transfer-coordinator';
import { readLocalTransferResource } from '../../src/providers/attachments/local-transfer-resource';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

it.skipIf(process.env.MONICA_TRANSFER_NATIVE !== '1')('copies authenticated Bitwarden maFile through actual Native MDBX, corruption and restart recovery', async () => {
  const archive = resolve('.tmp/complete-backup-317/110153ff/complete.mdbx-backup.zip');
  const archiveBytes = await readFile(archive);
  expect(hash(archiveBytes)).toBe('6dd0b2dc78b1aa12b3aab3bc62dbecfc11fbe400ac90b9aba6ac1a9b16f81281');
  const executable = resolve('native/mdbx2-host/target/debug/monica-mdbx2-host.exe');
  const outputRoot = resolve('.tmp/bitwarden-mdbx-copy-20261011'); await mkdir(outputRoot, { recursive: true });
  const root = await mkdtemp(join(outputRoot, 'run-'));
  const envelopePath = join(root, 'synthetic-envelope.json');
  const storage: VaultEnvelopeStorage = {
    read: async () => { try { return JSON.parse(await readFile(envelopePath, 'utf8')) as VaultEnvelope; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } },
    write: async envelope => { await writeFile(envelopePath, JSON.stringify(envelope)); },
    clear: async () => { throw new Error('Synthetic evidence must be retained'); }
  };
  let client = new Mdbx2NativeClient(new ProcessNativeRuntime(executable, root));
  let fixture: Awaited<ReturnType<typeof bitwardenTransferFixture>>, corrupted = true, requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url === '/api/ciphers/cipher-transfer/attachment/mafile-transfer') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ id: 'mafile-transfer', url: `http://127.0.0.1:${(server.address() as { port: number }).port}/file` }));
    } else if (request.url === '/file') {
      const bytes = fixture.body.slice(); if (corrupted) bytes[20] ^= 1; response.end(bytes);
    } else { response.statusCode = 404; response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const downloads = new BitwardenAttachmentDownloadService({ transportPolicy: { maxAttempts: 1 } });
  let service = new SecureVaultService(storage, new MemoryVaultSessionStore());
  try {
    fixture = await bitwardenTransferFixture({ unknownSize: true, apiUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/api` });
    const source = new BitwardenTransferAttachmentSource(downloads, async () => fixture.context(), async () => {});
    const transfer = await client.beginInboundTransfer(archiveBytes.length, hash(archiveBytes));
    for (let offset = 0; offset < archiveBytes.length;) offset = (await client.sendInboundChunk(transfer.transferId, offset,
      archiveBytes.subarray(offset, offset + transfer.maxChunkBytes))).nextOffset;
    const imported = await client.finishInboundTransfer(transfer.transferId);
    const credential = { method: 'password' as const, password: 'Synthetic transfer fixture password' };
    const opened = await client.openVault({ kind: 'file', handle: imported.fileHandle }, credential);
    await client.releaseFile(imported.fileHandle);
    const target: ProviderAccount = { id: 'native-copy-target', kind: 'mdbx2', enabled: true, name: 'Synthetic MDBX',
      isDefaultSaveTarget: false, config: { vaultHandle: opened.vaultHandle } };
    await service.setup('Synthetic local transfer password');
    await service.upsertProvider(fixture.account); await service.upsertProvider(target);
    await service.applyProviderSync(fixture.account.id, [fixture.item]);
    const original = (await service.getItem(fixture.item.id))!;
    const makeBridge = () => new Mdbx2TransferAttachmentService(client, {} as never, source, new LocalAttachmentService(service));
    const coordinator = () => new Mdbx2BatchTransferCoordinator(service, { get() { throw new Error('Copy must never delete source'); } },
      new Mdbx2Provider(client), client, makeBridge());
    const request = { itemIds: [original.id], targetProviderId: target.id, action: 'copy' as const,
      preserveCategories: false, operationId: randomUUID(), operationCreatedAt: '2026-10-11T00:00:00.000Z' };
    const invalid = await coordinator().execute(request);
    expect(invalid.failedCount).toBe(1); expect(invalid.completedCount).toBe(0);
    expect(await service.getItem(original.id)).toEqual(original);
    corrupted = false;
    const finishUpload = client.finishAttachmentUpload.bind(client);
    client.finishAttachmentUpload = async transferId => {
      const receipt = await finishUpload(transferId);
      await writeFile(join(root, 'synthetic-upload-receipt.json'), JSON.stringify(receipt, null, 2));
      return receipt;
    };
    // Fail after real object and attachment writes, before encrypted adoption.
    service.applyCompletedMdbx2Transfer = async () => { throw new Error('Synthetic interruption before local adoption'); };
    const interrupted = await coordinator().execute(request);
    expect(interrupted.failedCount).toBe(1);
    expect(interrupted.items[0].error).toContain('Synthetic interruption');
    await client.lockVault(opened.vaultHandle); client.close();
    client = new Mdbx2NativeClient(new ProcessNativeRuntime(executable, root));
    await client.openVault({ kind: 'vault', handle: opened.vaultHandle }, credential);
    service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    await service.unlock('Synthetic local transfer password');
    const completed = await coordinator().execute(request);
    expect(completed.failedCount).toBe(0); expect(completed.completedCount).toBe(1);
    const item = (await service.getItem(completed.items[0].targetItemId!))!;
    expect(item.id).not.toBe(original.id);
    const ref = item.providerRefs.find(row => row.providerId === target.id)!;
    const listed = await client.listAttachments(opened.vaultHandle, ref.remoteFolderId!, ref.remoteId!);
    expect(listed.items).toHaveLength(1); expect(listed.items[0].sizeBytes).toBe(fixture.plaintext.length);
    const read = await client.beginAttachmentRead(opened.vaultHandle, listed.items[0].attachmentId);
    const bytes = new Uint8Array(read.sizeBytes);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const chunk = await client.readAttachmentChunk(read.readHandle, offset, read.maxChunkBytes);
        const part = base64ToBytes(chunk.dataBase64); bytes.set(part, offset); part.fill(0); offset = chunk.nextOffset;
      }
      expect(hash(bytes)).toBe(hash(fixture.plaintext));
    } finally { bytes.fill(0); await client.releaseAttachmentRead(read.readHandle); }
    const proof = await makeBridge().captureMoveAttachmentProofs(fixture.account, original, target, item,
      await mdbx2TransferUuid(request.operationId, `attachment-transfer:${original.id}`));
    const repeated = await coordinator().execute(request); expect(repeated.completedCount).toBe(1);
    expect((await service.listItems()).filter(row => row.providerRefs.some(ref => ref.providerId === target.id))).toHaveLength(1);
    expect(await service.getItem(original.id)).toEqual(original);
    // The same authenticated source also flows through a durable local copy and back to Native MDBX.
    const localAccount = (await service.readState()).providers.find(row => row.kind === 'local')!;
    const localCoordinator = new LocalTransferCoordinator(service, (state, selected) => readLocalTransferResource(state, selected,
      { files: makeBridge(), prepare: async () => undefined }));
    const localRequest = { itemIds: [original.id], targetProviderId: localAccount.id, action: 'copy' as const, preserveCategories: false };
    const localPlan = await localCoordinator.plan(localRequest);
    const localResult = await localCoordinator.execute({ ...localRequest, operationId: localPlan.operationId, operationCreatedAt: localPlan.operationCreatedAt });
    localCoordinator.clear();
    expect(localResult.completedCount).toBe(1); expect(localResult.failedCount).toBe(0);
    const localItem = (await service.getItem(localResult.items[0].targetItemId!))!;
    const localFile = (await makeBridge().listSourceAttachments(localAccount, localItem))[0];
    const localBytes = await makeBridge().readSourceAttachment(localAccount, localItem, localFile);
    expect(hash(localBytes)).toBe(hash(fixture.plaintext)); localBytes.fill(0);
    const outboundRequest = { ...request, operationId: randomUUID(), itemIds: [localItem.id] };
    const outbound = await coordinator().execute(outboundRequest);
    expect(outbound.completedCount, JSON.stringify(outbound.items)).toBe(1); expect(outbound.failedCount).toBe(0);
    const outboundItem = (await service.getItem(outbound.items[0].targetItemId!))!;
    const outboundProof = await makeBridge().captureMoveAttachmentProofs(localAccount, localItem, target, outboundItem,
      await mdbx2TransferUuid(outboundRequest.operationId, `attachment-transfer:${localItem.id}`));
    expect(await service.getItem(localItem.id)).toEqual(localItem);
    expect((await coordinator().execute(outboundRequest)).completedCount).toBe(1);
    await client.lockVault(opened.vaultHandle); client.close();
    client = new Mdbx2NativeClient(new ProcessNativeRuntime(executable, root));
    await client.openVault({ kind: 'vault', handle: opened.vaultHandle }, credential);
    await makeBridge().verifyMoveAttachmentProofs(target, item, proof);
    await makeBridge().verifyMoveAttachmentProofs(target, outboundItem, outboundProof);
    expect(hash(await readFile(archive))).toBe(hash(archiveBytes));
    await writeFile(join(root, 'evidence.json'), JSON.stringify({ status: 'passed', executableSha256: hash(await readFile(executable)),
      originalFixtureSha256: hash(archiveBytes), attachmentSha256: hash(fixture.plaintext), plaintextBytes: fixture.plaintext.length,
      requests, corruptedMacRejected: true, nativeAndLocalRestart: true, repeatedCopyCount: 1, sourceUnchanged: true, localCopyThenNativeReadback: true,
      scope: 'Actual loopback HTTP authenticated binary and real Native MDBX coordinator copy. Synthetic Bitwarden metadata; no real Bitwarden server or Android runtime.' }, null, 2));
  } finally {
    client.close(); downloads.clear(); server.closeAllConnections();
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  }
});
