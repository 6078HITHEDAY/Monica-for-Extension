import { describe, expect, it } from 'vitest';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';
import { SecureVaultService } from './secure-vault-service';
import { createLoginItem } from '../core/model';
import { decryptVaultState, deriveVaultKey, type VaultEnvelope } from './vault-crypto';
import { nextRecoveryCopies, recoveryOverview, VAULT_STORAGE_LIMIT, vaultCiphertextBytes } from './vault-recovery';

describe('encrypted recovery checkpoints', () => {
  it('bounds retention, rate and protection scope without returning ciphertext in summaries', () => {
    const envelope = (ciphertext: string, salt = 'same') => ({ ciphertext, kdf: {name: 'PBKDF2', salt} }) as unknown as VaultEnvelope;
    let rows = nextRecoveryCopies(envelope('AAAA'), envelope('BBBB'), [], 0);
    expect(rows).toHaveLength(1);
    rows = nextRecoveryCopies(envelope('BBBB'), envelope('CCCC'), rows, 1000);
    expect(rows[0].envelope.ciphertext).toBe('AAAA');
    for (let time = 1; time <= 5; time++) rows = nextRecoveryCopies(envelope('CCCC'), envelope('DDDD'), rows, time * 900000);
    expect(rows).toHaveLength(3);
    expect(nextRecoveryCopies(envelope('AAAA'), envelope('BBBB', 'new'), rows)).toEqual([]);
    expect(JSON.stringify(recoveryOverview(envelope('AAAA'), rows))).not.toContain('ciphertext');
    expect(vaultCiphertextBytes(envelope('YQ=='))).toBe(1);
    const large = envelope('A'.repeat(Math.ceil(VAULT_STORAGE_LIMIT / 3) * 4 + 4));
    expect(nextRecoveryCopies(large, envelope('BBBB'), [])).toHaveLength(0);
  });
  it('exports an older encrypted state only after fresh authentication and clears history separately', async () => {
    const storage = new MemoryVaultStorage();
    const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    const item = createLoginItem({title:'Checkpoint',username:'synthetic',password:'old synthetic value'});
    await service.setup('1234', [item]);
    await service.upsertItem({...item,password:'new synthetic value'});
    const view = await service.storageOverview();
    expect(view.copies).toHaveLength(1);
    const input = {format:'encrypted' as const,confirmed:true as const,recoveryId:view.copies[0].id,backupPassword:'5678'};
    await expect(service.authenticatedExport({...input,masterPassword:'wrong'})).rejects.toThrow();
    const result = await service.authenticatedExport({...input,masterPassword:'1234'});
    if (result.format !== 'encrypted') throw new Error('Wrong format');
    const {key} = await deriveVaultKey('5678',result.backup.envelope.kdf);
    expect((await decryptVaultState(result.backup.envelope,key)).items[0]).toMatchObject({password:'old synthetic value'});
    await service.clearRecoveryCopies();
    expect((await service.readState()).items[0]).toMatchObject({password:'new synthetic value'});
    await expect(service.authenticatedExport({...input,masterPassword:'1234'})).rejects.toThrow('不再可用');
    await service.lock();
    await expect(service.storageOverview()).rejects.toThrow();
  });
});
