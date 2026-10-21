import { describe, expect, it } from 'vitest';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';
import { decryptVaultState, deriveVaultKey } from './vault-crypto';
import { createLoginItem } from '../core/model';

describe('authenticated exports', () => {
  it('requires confirmation and the current password, exports active items, and keeps the four-character minimum', async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    const item = createLoginItem({ title: 'Synthetic export', username: 'test', password: 'synthetic-value' });
    const archived = { ...item, id: 'archived', archivedAt: new Date().toISOString() };
    const trashed = { ...item, id: 'trashed', deletedAt: new Date().toISOString() };
    await service.setup('1234', [item, archived, trashed]);
    await expect(service.authenticatedExport({ format: 'plaintext', masterPassword: 'wrong', confirmed: true })).rejects.toThrow();
    await expect(service.authenticatedExport({ format: 'plaintext', masterPassword: '1234', confirmed: false as true })).rejects.toThrow();
    const result = await service.authenticatedExport({ format: 'plaintext', masterPassword: '1234', confirmed: true });
    expect(result).toMatchObject({ format: 'plaintext', items: [{ id: item.id, password: 'synthetic-value' }] });
    expect(result.format === 'plaintext' && result.items.length).toBe(1);
    const backup = await service.authenticatedExport({ format: 'encrypted', masterPassword: '1234', backupPassword: '5678', confirmed: true });
    if (backup.format !== 'encrypted') throw new Error('Wrong format');
    const { key } = await deriveVaultKey('5678', backup.backup.envelope.kdf);
    expect((await decryptVaultState(backup.backup.envelope, key)).items).toHaveLength(3);
  });

  it('requires a bound system verifier for device-key exports and rejects lock/reunlock during verification', async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await service.setup('');
    await expect(service.authenticatedExport({ format: 'plaintext', confirmed: true }, async () => {})).rejects.toThrow('设置主密码');
    await service.enrollWindowsHello(async bindingId => ({ version: 1, bindingId, rpId: 'monica-extension.local', verified: true, enrolledAtUnixSeconds: 1000 }));
    let finish!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const attempt = service.authenticatedExport({ format: 'plaintext', confirmed: true }, async (_binding, challenge) => { expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/); entered(); await waiting; });
    await ready;
    await service.lock();
    await service.unlockWithWindowsHello(async () => {});
    finish();
    await expect(attempt).rejects.toThrow('会话已变化');
    await expect(service.authenticatedExport({ format: 'plaintext', confirmed: true }, async () => { throw new Error('cancelled'); })).rejects.toThrow('cancelled');
    await expect(service.authenticatedExport({ format: 'plaintext', confirmed: true }, async () => {})).resolves.toMatchObject({ format: 'plaintext' });
  });
});
