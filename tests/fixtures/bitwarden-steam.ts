import type { ProviderAccount } from '../../src/core/model';
import { encryptBitwardenBytes, encryptBitwardenString, type BitwardenSymmetricKey } from '../../src/providers/bitwarden/bitwarden-crypto';
import { base64ToBytes, bytesToBase64 } from '../../src/security/encoding';

export const STEAM_SECRET = 'QUJDREVGR0hJSktMTU5PUFFSU1Q=';
export const STEAM_ID = '76561198000000001';
export const STEAM_REVISION = '2026-10-10T00:00:00.000Z';

/** Synthetic Android-style Cipher with a separately wrapped attachment key. */
export async function bitwardenSteamFixture(options: { raw?: string; legacy?: boolean; unknownSize?: boolean } = {}) {
  const key = (seed: number): BitwardenSymmetricKey => ({ encKey: new Uint8Array(32).fill(seed), macKey: new Uint8Array(32).fill(seed + 1) });
  const owner = key(11), cipher = key(21), attachment = key(31);
  const wrap = (value: BitwardenSymmetricKey, parent: BitwardenSymmetricKey) => encryptBitwardenBytes(Uint8Array.from([...value.encKey, ...value.macKey]), parent);
  const raw = options.raw ?? JSON.stringify({ account_name: 'synthetic', steamid: STEAM_ID, shared_secret: STEAM_SECRET });
  const encrypted = await encryptBitwardenBytes(new TextEncoder().encode(raw), attachment);
  const [iv, data, mac] = encrypted.slice(2).split('|').map(base64ToBytes);
  const body = options.legacy ? Uint8Array.from([...iv, ...data, ...mac]) : Uint8Array.from([2, ...iv, ...mac, ...data]);
  const descriptor = { Id: 'steam-attachment', FileName: await encryptBitwardenString('synthetic.maFile', cipher),
    Key: await wrap(attachment, cipher), Size: String(body.length) };
  const rawCipher = { Id: 'steam-cipher', Type: 1, Key: await wrap(cipher, owner), Name: await encryptBitwardenString('Android Steam attachment', cipher),
    RevisionDate: STEAM_REVISION, CreationDate: STEAM_REVISION, FolderId: 'steam-folder',
    Fields: [{ Name: await encryptBitwardenString('Monica.Type', cipher), Value: await encryptBitwardenString('steam_mafile_v1', cipher), Type: 0 }],
    Login: { Username: await encryptBitwardenString(STEAM_ID, cipher), Password: null, Totp: null, Uris: [] },
    Attachments: [{ ...descriptor, ...(options.unknownSize ? { Size: '0' } : {}) }] };
  const account: ProviderAccount = { id: 'steam-provider', kind: 'bitwarden', name: 'Synthetic Bitwarden', enabled: true, isDefaultSaveTarget: false,
    config: { vaultUrl: 'https://vault.example.test', apiUrl: 'https://vault.example.test/api', identityUrl: 'https://vault.example.test/identity',
      email: 'synthetic@example.test', deviceId: 'steam-test', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 3_600_000,
      kdf: { type: 0, iterations: 1 }, vaultKeyEnc: bytesToBase64(owner.encKey), vaultKeyMac: bytesToBase64(owner.macKey) } };
  const payload = { Profile: { Id: 'synthetic-user' }, Folders: [{ Id: 'steam-folder', Name: await encryptBitwardenString('Games', owner) }], Ciphers: [rawCipher] };
  return { account, payload, body, descriptor, raw };
}
