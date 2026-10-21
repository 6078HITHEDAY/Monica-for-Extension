import type { VaultItem } from '../core/model';
import type { EncryptedVaultBackup } from './secure-vault-service';

export interface VaultExportInput {
  format: 'plaintext' | 'encrypted';
  masterPassword?: string;
  backupPassword?: string;
  confirmed: true;
  recoveryId?: string;
}
export type VaultExportResult = { format: 'plaintext'; version: 1; items: VaultItem[] }
  | { format: 'encrypted'; backup: EncryptedVaultBackup };

export function validateExportInput(input: VaultExportInput): void {
  if (!input || input.confirmed !== true || !['plaintext', 'encrypted'].includes(input.format)
    || input.masterPassword !== undefined && (typeof input.masterPassword !== 'string' || input.masterPassword.length > 1024)
    || input.format === 'encrypted' && (typeof input.backupPassword !== 'string' || input.backupPassword.length > 1024)
    || input.recoveryId !== undefined && (input.format !== 'encrypted' || typeof input.recoveryId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.recoveryId))) {
    throw new Error('导出请求无效，请重新打开导出窗口。');
  }
}
