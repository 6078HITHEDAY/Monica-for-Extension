import type { BitwardenSessionConfig } from '../providers/bitwarden/bitwarden-client';
import type { BitwardenSymmetricKey } from '../providers/bitwarden/bitwarden-crypto';

export interface BitwardenAttachmentContext {
  providerId: string;
  itemId: string;
  session: BitwardenSessionConfig;
  rawCipher: Record<string, unknown>;
  organizationKeys: Map<string, BitwardenSymmetricKey>;
}
