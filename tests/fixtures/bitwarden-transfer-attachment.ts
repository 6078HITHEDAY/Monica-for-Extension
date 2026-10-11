import type { ProviderAccount, VaultItem } from '../../src/core/model';
import { createLoginItem } from '../../src/core/model';
import { bytesToBase64 } from '../../src/security/encoding';
import { encryptBitwardenBytes, encryptBitwardenString } from '../../src/providers/bitwarden/bitwarden-crypto';
import type { BitwardenSessionConfig } from '../../src/providers/bitwarden/bitwarden-client';

/** Synthetic encrypted maFile using Bitwarden's standard type-2 binary layout. */
export async function bitwardenTransferFixture(options: {
  organization?: boolean; unknownSize?: boolean; empty?: boolean; apiUrl?: string; suffix?: string;
} = {}) {
  const key = (seed: number) => ({ encKey: new Uint8Array(32).fill(seed), macKey: new Uint8Array(32).fill(seed + 1) });
  const owner = key(3), cipher = key(5), file = key(7), org = key(9);
  const plaintext = new TextEncoder().encode(options.empty ? '' : JSON.stringify({ account_name: 'Synthetic Steam',
    shared_secret: bytesToBase64(new Uint8Array(20).fill(1)), identity_secret: 'synthetic-only',
    Session: { SteamID: '76561198000000001' }, future: { preserved: [1, null, 'test'] } }));
  const iv = new Uint8Array(16).fill(2);
  const encryptionKey = await crypto.subtle.importKey('raw', file.encKey, 'AES-CBC', false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, encryptionKey, plaintext));
  const signed = new Uint8Array(iv.length + encrypted.length); signed.set(iv); signed.set(encrypted, iv.length);
  const hmacKey = await crypto.subtle.importKey('raw', file.macKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, signed));
  const body = new Uint8Array(1 + iv.length + mac.length + encrypted.length);
  body[0] = 2; body.set(iv, 1); body.set(mac, 17); body.set(encrypted, 49);
  const wrap = async (rawKey: typeof owner, wrapping: typeof owner) => {
    const raw = new Uint8Array(64); raw.set(rawKey.encKey); raw.set(rawKey.macKey, 32);
    try { return await encryptBitwardenBytes(raw, wrapping); } finally { raw.fill(0); }
  };
  const revision = '2026-10-11T00:00:00.000Z';
  const rawCipher: Record<string, unknown> = { Id: 'cipher-transfer', RevisionDate: revision, Type: 1,
    OrganizationId: options.organization ? 'org-transfer' : null,
    Key: await wrap(cipher, options.organization ? org : owner),
    Attachments: [{ Id: 'mafile-transfer', FileName: await encryptBitwardenString('steam.maFile', cipher),
      Size: options.unknownSize ? null : String(body.length), Key: await wrap(file, cipher) }] };
  const apiUrl = options.apiUrl || 'https://vault.example.test/api';
  const session: BitwardenSessionConfig = { vaultUrl: 'https://vault.example.test', apiUrl,
    identityUrl: 'https://vault.example.test/identity', email: 'transfer@example.test', deviceId: 'synthetic-transfer-device',
    accessToken: 'synthetic-access-token', expiresAt: Date.now() + 3_600_000, kdf: { type: 0, iterations: 1 },
    vaultKeyEnc: bytesToBase64(owner.encKey), vaultKeyMac: bytesToBase64(owner.macKey) };
  const account: ProviderAccount = { id: 'bw-transfer', kind: 'bitwarden', name: 'Synthetic Bitwarden', enabled: true,
    isDefaultSaveTarget: false, config: session };
  const item: VaultItem = { ...createLoginItem({ title: 'Synthetic Steam', username: 'synthetic' }), loginType: 'STEAM_MAFILE',
    steamSharedSecretBase64: bytesToBase64(new Uint8Array(20).fill(1)), steamId: '76561198000000001',
    steamRawJson: new TextDecoder().decode(plaintext),
    providerRefs: [{ providerId: account.id, remoteId: `cipher-transfer${options.suffix || ''}`, revision }] };
  const context = () => ({ providerId: account.id, itemId: item.id, rawCipher: structuredClone(rawCipher), session: { ...session },
    organizationKeys: new Map(options.organization ? [['org-transfer', { encKey: org.encKey.slice(), macKey: org.macKey.slice() }]] : []) });
  return { account, item, plaintext, body, rawCipher, session, context };
}
