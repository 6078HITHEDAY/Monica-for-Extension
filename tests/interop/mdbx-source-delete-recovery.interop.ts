import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { Mdbx2NativeClient } from '../../src/providers/mdbx2/native-client';
import { prepareMdbx2TransferSourceDeletion, deleteMdbx2TransferSources } from '../../src/providers/mdbx2/mdbx2-transfer-source-delete';
import { readMdbx2SourceDeletionIntent } from '../../src/core/mdbx2-source-deletion';
import { createLoginItem, type ProviderAccount } from '../../src/core/model';
import type { Mdbx2ObjectWriteResult } from '../../src/providers/mdbx2/native-contract';
import { ProcessNativeRuntime } from './mdbx2-interop-support';

const fixtureRoot = process.env.MONICA_317_NATIVE_PASSKEY_FIXTURE, output = process.env.MONICA_SOURCE_DELETE_OUTPUT;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

it.skipIf(!fixtureRoot || !output)('native source deletion rejects attachment-only changes and replays its saved revision after a full host restart', async () => {
  if (!fixtureRoot || !output) throw new Error('Explicit synthetic fixture and output required');
  const fixture = join(fixtureRoot, 'edge-passkeys.mdbx'), proof = JSON.parse(await readFile(join(fixtureRoot, 'evidence.json'), 'utf8'));
  const bytes = await readFile(fixture);
  expect(proof.status).toBe('passed'); expect(hash(bytes)).toBe(proof.exportSha256);
  await mkdir(output, { recursive: true });
  const hostRoot = await mkdtemp(join(output, 'host-')), executable = resolve('native/mdbx2-host/target/debug/monica-mdbx2-host.exe');
  const connect = () => new Mdbx2NativeClient(new ProcessNativeRuntime(executable, hostRoot));
  const credential = { method: 'password' as const, password: 'Synthetic transfer fixture password' };
  let client = connect();
  const evidence: Record<string, unknown> = { status: 'failed', executable, hostSha256: hash(await readFile(executable)),
    fixtureSha256: hash(bytes), scope: 'Actual Native process deletion primitive and restart; no browser UI, live Android, or full Bitwarden move acceptance' };
  try {
    const incoming = await client.beginInboundTransfer(bytes.length, hash(bytes));
    for (let offset = 0; offset < bytes.length;) offset = (await client.sendInboundChunk(incoming.transferId, offset, bytes.subarray(offset, offset + incoming.maxChunkBytes))).nextOffset;
    const file = await client.finishInboundTransfer(incoming.transferId), vault = await client.openVault({ kind: 'file', handle: file.fileHandle }, credential);
    const handle = vault.vaultHandle, vaultId = (await client.readWriteRevision(handle)).vaultId, collection = randomUUID();
    await client.createCollection(handle, randomUUID(), collection, 'Synthetic guarded move');
    const account: ProviderAccount = { id: 'source', kind: 'mdbx2', name: 'Source', enabled: true, isDefaultSaveTarget: false,
      config: { vaultHandle: handle, nativeVaultId: vaultId } };
    const rows: Mdbx2ObjectWriteResult[] = [];
    for (let n = 0; n < 3; n++) {
      const logicalObjectId = `password:${randomUUID()}`;
      rows.push(await client.upsertObject(handle, randomUUID(), { logicalObjectId,
        collectionId: collection, objectTypeId: 'login', title: `Synthetic ${n}`,
        payloadJson: JSON.stringify({ monica_entry_id: logicalObjectId, password_plain: `synthetic-${n}`, notes: '  shared\r\n0007  ' }) }));
    }
    const [first, second, target] = rows;
    const items = [first, second].map(row => ({ ...createLoginItem({ title: 'Synthetic source' }),
      providerRefs: [{ providerId: account.id, remoteId: row.objectId, remoteFolderId: collection, revision: row.commitId }] }));
    const attachmentId = randomUUID(), original = new TextEncoder().encode(' source file\r\n0007 ');
    const upload = async (data: Uint8Array, mode: 'create' | 'replace') => {
      const transfer = await client.beginAttachmentUpload(handle, { operationId: randomUUID(), attachmentId, collectionId: collection,
        objectId: first.objectId, fileName: 'source.txt', sizeBytes: data.length, sha256: hash(data), mode });
      try { await client.sendAttachmentUploadChunk(transfer.transferId, 0, data); await client.finishAttachmentUpload(transfer.transferId); }
      finally { await client.abortAttachmentUpload(transfer.transferId); }
    };
    const readDigest = async () => {
      const read = await client.beginAttachmentRead(handle, attachmentId), digest = createHash('sha256');
      try {
        for (let offset = 0; offset < read.sizeBytes;) {
          const chunk = await client.readAttachmentChunk(read.readHandle, offset); digest.update(Buffer.from(chunk.dataBase64, 'base64')); offset = chunk.nextOffset;
        }
        return digest.digest('hex');
      } finally { await client.releaseAttachmentRead(read.readHandle); }
    };
    await upload(original, 'create');
    const records = await Promise.all(rows.map(row => client.revealObject(handle, row.objectId)));
    const verify = async () => {
      expect(await Promise.all(rows.map(row => client.revealObject(handle, row.objectId)))).toEqual(records);
      expect(await readDigest()).toBe(hash(original));
    };
    const rejectedId = randomUUID();
    const rejected = await prepareMdbx2TransferSourceDeletion(client, account, items, rejectedId, 'target', vaultId, verify);
    const changed = original.slice(); changed[0] ^= 1; await upload(changed, 'replace');
    expect(await client.revealObject(handle, first.objectId)).toEqual(records[0]);
    await expect(deleteMdbx2TransferSources(client, account, items, rejectedId, 'target', rejected)).rejects.toMatchObject({ code: 'vault-revision-conflict' });
    expect(await Promise.all(rows.map(row => client.revealObject(handle, row.objectId)))).toEqual(records);
    await upload(original, 'replace');
    // Restoring bytes does not authorize replacing the original revision.
    await expect(deleteMdbx2TransferSources(client, account, items, rejectedId, 'target', rejected)).rejects.toMatchObject({ code: 'vault-revision-conflict' });
    const operationId = randomUUID(), intent = await prepareMdbx2TransferSourceDeletion(client, account, items, operationId, 'target', vaultId, verify);
    await writeFile(join(output, 'saved-deletion.json'), JSON.stringify({ operationId, intent }, null, 2));
    const lossy = { vaultStatus: client.vaultStatus.bind(client),
      resolveObjectOperation: async () => { throw new Error('Synthetic disconnected after commit'); },
      mutateObjects: async (...args: Parameters<Mdbx2NativeClient['mutateObjects']>) => {
        await client.mutateObjects(...args); client.close(); throw new Error('Synthetic lost successful reply');
      } };
    await expect(deleteMdbx2TransferSources(lossy, account, items, operationId, 'target', intent)).rejects.toThrow('lost successful reply');
    client = connect(); await client.openVault({ kind: 'vault', handle }, credential);
    const saved = JSON.parse(await readFile(join(output, 'saved-deletion.json'), 'utf8'));
    const result = await deleteMdbx2TransferSources(client, account, [...items].reverse(), saved.operationId, 'target', readMdbx2SourceDeletionIntent(saved.intent));
    expect(result.alreadyCommitted).toBe(true);
    const deleted = await client.listObjects(handle, collection, { deleted: true });
    expect(deleted.items.map(row => row.objectId).sort()).toEqual([first.objectId, second.objectId].sort());
    expect(deleted.items.every(row => row.headCommitId === result.commitId)).toBe(true);
    expect(await client.revealObject(handle, target.objectId)).toEqual(records[2]);
    expect(hash(await readFile(fixture))).toBe(proof.exportSha256);
    Object.assign(evidence, { status: 'passed', attachmentOnlyEditRetainsObjectHead: true, staleDeletionHasZeroObjectWrites: true,
      restoredBytesDoNotRefreshIntent: true, lostReplyRecoveredAfterProcessRestart: true, oneDeletionCommit: result.commitId,
      reversedOrderReplay: true, targetRecordUnchanged: true, inputUnchanged: true });
  } catch (error) { evidence.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { client.close(); await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2)); }
});
