import { pbkdf2Sync } from 'node:crypto';
import { argon2id } from 'hash-wasm';
import { describe, expect, it, vi } from 'vitest';
import { BitwardenClient } from './bitwarden-client';
import { deriveBitwardenMasterKey, stretchBitwardenMasterKey } from './bitwarden-crypto';

const email = 'auth@example.com';
const masterPassword = '  Synthetic login password  ';
const salt = 'Case-Sensitive-Unlock-Salt ';
const input = { vaultUrl: 'https://vault.bitwarden.com', email, masterPassword, deviceId: 'synthetic-device' };
const vaultKey = { encKey: new Uint8Array(32).fill(17), macKey: new Uint8Array(32).fill(29) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function unlockResponse(argon = false) {
  // Derive independently, preserving the server salt byte-for-byte.
  const master = argon
    ? await argon2id({ password: masterPassword, salt: new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt))), iterations: 1, memorySize: 1024, parallelism: 1, hashLength: 32, outputType: 'binary' })
    : new Uint8Array(pbkdf2Sync(masterPassword, salt, 2, 32, 'sha256'));
  const key = await new BitwardenClient().protectVaultKey(vaultKey, await stretchBitwardenMasterKey(master), new Uint8Array(16));
  return { Salt: salt, Kdf: { KdfType: argon ? 1 : 0, Iterations: argon ? 1 : 2, ...(argon ? { Memory: 1, Parallelism: 1 } : {}) }, MasterKeyEncryptedUserKey: key };
}

function camelCase(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key[0].toLowerCase() + key.slice(1), camelCase(child)]));
}

describe('Bitwarden authenticated master-password unlock response', () => {
  for (const flow of ['password', 'sso'] as const) for (const casing of ['Pascal', 'camel']) for (const argon of [false, true]) {
    it(`decrypts ${flow} ${casing} ${argon ? 'Argon2id' : 'PBKDF2'} nested key and exact salt`, async () => {
      const unlock = await unlockResponse(argon);
      const options = { HasMasterPassword: true, MasterPasswordUnlock: unlock };
      const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).includes('/accounts/prelogin')) return json({ Kdf: 0, KdfIterations: 1 });
        const form = init!.body as URLSearchParams;
        expect(form.get('deviceIdentifier')).toBe(input.deviceId);
        if (flow === 'password' && form.get('newDeviceOtp') !== '654321') return json({ DeviceVerified: false, ErrorModel: { Message: 'new device verification required' } }, 400);
        return json({ access_token: 'synthetic-access', ...(casing === 'Pascal' ? { UserDecryptionOptions: options } : { userDecryptionOptions: camelCase(options) }) });
      });
      const client = new BitwardenClient(fetcher);
      if (flow === 'password') expect(await client.login(input)).toEqual({ status: 'device-verification-required' });
      const result = flow === 'password'
        ? await client.login({ ...input, newDeviceOtp: '654321' })
        : await client.loginSso({ ...input, code: 'synthetic-code', codeVerifier: 'synthetic-verifier', redirectUri: 'https://example.test/callback', organizationIdentifier: 'synthetic-org' });
      expect(result.status).toBe('authenticated');
      if (result.status !== 'authenticated') throw new Error('Expected authentication');
      expect(client.vaultKey(result.session)).toEqual(vaultKey);
      expect(JSON.stringify(result.session)).not.toContain('654321');
      expect(JSON.stringify(result.session)).not.toContain(masterPassword);
    });
  }

  it.each(['missing-key', 'missing-salt', 'missing-kdf', 'missing-type', 'zero-iterations', 'oversized-memory', 'bad-mac'])(
    'rejects %s without falling back to a valid legacy Key', async (failure) => {
      const unlock: Record<string, unknown> = await unlockResponse();
      if (failure === 'missing-key') delete unlock.MasterKeyEncryptedUserKey;
      if (failure === 'missing-salt') delete unlock.Salt;
      if (failure === 'missing-kdf') delete unlock.Kdf;
      if (failure === 'missing-type') unlock.Kdf = { Iterations: 2 };
      if (failure === 'zero-iterations') unlock.Kdf = { KdfType: 0, Iterations: 0 };
      if (failure === 'oversized-memory') unlock.Kdf = { KdfType: 1, Iterations: 1, Memory: 129, Parallelism: 1 };
      if (failure === 'bad-mac') unlock.Salt = 'incorrect-salt';
      const legacyMaster = await deriveBitwardenMasterKey(masterPassword, email, { type: 0, iterations: 1 });
      const legacyKey = await new BitwardenClient().protectVaultKey(vaultKey, await stretchBitwardenMasterKey(legacyMaster), new Uint8Array(16));
      const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).includes('/accounts/prelogin')
        ? json({ Kdf: 0, KdfIterations: 1 })
        : json({ access_token: 'synthetic-access', Key: legacyKey, UserDecryptionOptions: { MasterPasswordUnlock: unlock } }));
      await expect(new BitwardenClient(fetcher).login({ ...input, newDeviceOtp: '654321' })).rejects.toThrow();
    }
  );
});
