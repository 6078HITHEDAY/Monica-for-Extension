import type { ProviderAccount } from '../core/model';
import type { BitwardenSessionConfig } from '../providers/bitwarden/bitwarden-client';
import { ProviderAttachmentError } from '../providers/attachments/attachment-contract';

export function readBitwardenSession(account: ProviderAccount): BitwardenSessionConfig {
  const config = account.config as Partial<BitwardenSessionConfig>;
  const required = [config.vaultUrl, config.apiUrl, config.identityUrl, config.email, config.deviceId, config.accessToken, config.vaultKeyEnc, config.vaultKeyMac];
  if (required.some((value) => typeof value !== "string" || !value) || !config.kdf || typeof config.expiresAt !== "number") {
    throw new ProviderAttachmentError("attachment-provider-not-authenticated", "Bitwarden 密码源尚未完成登录，请重新登录。");
  }
  return config as BitwardenSessionConfig;
}
