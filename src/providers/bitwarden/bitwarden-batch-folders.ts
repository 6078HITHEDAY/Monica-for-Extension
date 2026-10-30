import type { BitwardenBatchIntent, BitwardenBatchFolder } from '../../core/bitwarden-batch-transfer';
import { decryptBitwardenString, type BitwardenSymmetricKey } from './bitwarden-crypto';
import type { BitwardenCopySessionStore } from './bitwarden-transfer-execution';
import { BitwardenClient, type BitwardenSessionConfig } from './bitwarden-client';

export interface BitwardenBatchStore {
  copies: BitwardenCopySessionStore;
  read(operationId: string): Promise<BitwardenBatchIntent>;
  advanceFolder(operationId: string, folderKey: string, expected: BitwardenBatchFolder, stage: 'attempted' | 'created', targetId?: string): Promise<BitwardenBatchFolder>;
  cancel(operationId: string): Promise<void>;
}
export interface BitwardenBatchFolderRemote {
  list(signal?: AbortSignal): Promise<unknown>;
  create(encryptedName: string, signal?: AbortSignal): Promise<unknown>;
}

/** Do not filter malformed rows: absence in an incomplete list is not evidence
 * that an earlier create failed. Names remain encrypted for identity recovery. */
export function readBitwardenBatchFolders(raw: unknown): Array<{ id: string; encryptedName: string }> {
  if (!Array.isArray(raw) || raw.length > 50_000) throw new Error('Bitwarden 完整文件夹清单无效。');
  const ids = new Set<string>();
  return raw.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Bitwarden 文件夹记录无效。');
    const row = value as Record<string, unknown>, id = row.id ?? row.Id, name = row.name ?? row.Name;
    if (typeof id !== 'string' || !id || id.length > 512 || ids.has(id) || typeof name !== 'string' || !name.startsWith('2.')
      || row.id !== undefined && row.Id !== undefined || row.name !== undefined && row.Name !== undefined)
      throw new Error('Bitwarden 文件夹身份重复或无效。');
    ids.add(id); return { id, encryptedName: name };
  });
}

export class BitwardenBatchFoldersRemote implements BitwardenBatchFolderRemote {
  constructor(private readonly copyId: string, private readonly store: BitwardenCopySessionStore, private readonly client: BitwardenClient) {}
  async list(signal?: AbortSignal) {
    signal?.throwIfAborted(); const account = await this.store.account(this.copyId);
    const result = await this.client.sync(account.config as BitwardenSessionConfig, signal);
    signal?.throwIfAborted(); await this.store.saveSession(this.copyId, account, result.session);
    if (result.payload.folders !== undefined && result.payload.Folders !== undefined) throw new Error('Bitwarden 文件夹清单有歧义。');
    return result.payload.folders ?? result.payload.Folders;
  }
  async create(encryptedName: string, signal?: AbortSignal) {
    signal?.throwIfAborted(); const account = await this.store.account(this.copyId);
    const result = await this.client.createFolderOnce(account.config as BitwardenSessionConfig, { name: encryptedName }, signal);
    signal?.throwIfAborted(); await this.store.saveSession(this.copyId, account, result.session); return result.payload;
  }
}

/** One durable application attempt per folder. Exact randomized ciphertext is
 * its recovery identity; plaintext title matching must never trigger adoption. */
export async function executeBitwardenBatchFolders(operationId: string, store: BitwardenBatchStore,
  remote: BitwardenBatchFolderRemote, ownerKey: BitwardenSymmetricKey, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted(); let batch = await store.read(operationId);
  if (batch.status === 'completed') return;
  if (batch.status !== 'writing') throw new Error('Bitwarden 传输已取消。');
  const check = async () => { signal?.throwIfAborted(); batch = await store.read(operationId); if (batch.status !== 'writing') throw new Error('Bitwarden 传输状态已变化。'); };
  for (const saved of batch.folders || []) {
    await check(); let folder = batch.folders!.find(row => row.key === saved.key)!;
    if (await decryptBitwardenString(folder.encryptedName, ownerKey) !== folder.name) throw new Error('Bitwarden 文件夹名称校验失败。');
    let list = readBitwardenBatchFolders(await remote.list(signal)); await check();
    const matches = list.filter(row => row.encryptedName === folder.encryptedName);
    if (matches.length > 1) throw new Error('Bitwarden 文件夹匹配不唯一，已停止再次创建。');
    if (folder.stage === 'prepared' || folder.stage === 'attempted') {
      if (!matches.length) {
        if (folder.stage === 'attempted') throw new Error('Bitwarden 上次文件夹创建结果未知，已停止重试以避免重复。');
        folder = await store.advanceFolder(operationId, folder.key, folder, 'attempted'); await check();
        // The reply is not proof: always use a fresh full authenticated readback.
        await remote.create(folder.encryptedName, signal); await check();
        list = readBitwardenBatchFolders(await remote.list(signal)); await check();
      }
      const found = list.filter(row => row.encryptedName === folder.encryptedName);
      if (found.length !== 1) throw new Error('Bitwarden 文件夹创建结果缺失或不唯一，已保留恢复记录。');
      folder = await store.advanceFolder(operationId, folder.key, folder, 'created', found[0].id);
    }
    const actual = list.find(row => row.id === folder.targetId);
    if (!actual || actual.encryptedName !== folder.encryptedName) throw new Error('Bitwarden 目标文件夹已改名或删除，已停止传输。');
    await check();
  }
}
