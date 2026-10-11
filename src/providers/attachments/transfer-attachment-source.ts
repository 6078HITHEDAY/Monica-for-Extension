import type { ProviderAccount, VaultItem } from '../../core/model';
import type { ProviderAttachmentSummary } from './attachment-contract';

/** Internal source reader. Catalog sizes may be ciphertext sizes; read returns
 * authenticated plaintext owned by the caller, which must clear it after use. */
export interface TransferAttachmentSource {
  list(account: ProviderAccount, item: VaultItem): Promise<ProviderAttachmentSummary[]>;
  read(account: ProviderAccount, item: VaultItem, attachment: Pick<ProviderAttachmentSummary, 'attachmentId' | 'fileName'>): Promise<Uint8Array>;
}
