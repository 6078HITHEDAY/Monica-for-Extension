import { describe, expect, it } from 'vitest';
import { createCipheriv, pbkdf2Sync, scryptSync } from 'node:crypto';
import { argon2id } from 'hash-wasm';
import { strToU8 } from 'fflate';
import { previewImport } from './file-transfer';

const password = 'synthetic-encryption-password';
const stratum = { Authenticators: [{ Type: 2, Issuer: 'Synthetic', Username: 'alice', Secret: 'JBSWY3DPEHPK3PXP', Algorithm: 1, Digits: 8, Period: 60 }] };
function seal(key: Uint8Array, plain: Uint8Array, modern = true) {
  const iv = Buffer.alloc(modern ? 12 : 16, 3);
  const cipher = createCipheriv(modern ? 'aes-256-gcm' : 'aes-256-cbc', key, iv);
  const bytes = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { iv, bytes, tag: modern ? (cipher as ReturnType<typeof createCipheriv> & { getAuthTag(): Buffer }).getAuthTag() : Buffer.alloc(0) };
}

describe('encrypted authenticator file compatibility', () => {
  it.each([true, false])('imports Stratum modern=%s with the actual header length', async modern => {
    const salt = Buffer.alloc(modern ? 16 : 20, 2);
    const key = modern ? await argon2id({ password, salt, parallelism: 4, iterations: 3, memorySize: 65536, hashLength: 32, outputType: 'binary' }) : pbkdf2Sync(password, salt, 64000, 32, 'sha1');
    const encrypted = seal(key, strToU8(JSON.stringify(stratum)), modern);
    const bytes = Buffer.concat([Buffer.from(modern ? 'AUTHENTICATORPRO' : 'AuthenticatorPro'), salt, encrypted.iv, encrypted.bytes, encrypted.tag]);
    key.fill(0);
    const result = await previewImport({ name: 'backup.bin', bytes, password });
    expect(result.items[0]).toMatchObject({ kind: 'totp', algorithm: 'SHA256', digits: 8, period: 60 });
    await expect(previewImport({ name: 'backup.bin', bytes, password: 'wrong' })).rejects.toThrow();
    await expect(previewImport({ name: 'backup.bin', bytes })).rejects.toThrow('密码');
  });

  it('imports authenticated Aegis slots and rejects wrong passwords and tampering', async () => {
    const salt = Buffer.alloc(32, 4), key = Buffer.alloc(32, 5);
    const derived = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const wrapped = seal(derived, key), db = seal(key, strToU8(JSON.stringify({ entries: [{ type: 'totp', name: 'alice', issuer: 'Synthetic', info: { secret: 'JBSWY3DPEHPK3PXP', algo: 'SHA256', digits: 8, period: 60 } }] })));
    const root = { header: { slots: [{ type: 1, salt: salt.toString('hex'), n: 32768, r: 8, p: 1, key: wrapped.bytes.toString('hex'), key_params: { nonce: wrapped.iv.toString('hex'), tag: wrapped.tag.toString('hex') } }], params: { nonce: db.iv.toString('hex'), tag: db.tag.toString('hex') } }, db: db.bytes.toString('base64') };
    derived.fill(0); key.fill(0);
    const input = { name: 'aegis.json', bytes: strToU8(JSON.stringify(root)), password };
    expect((await previewImport(input)).items[0]).toMatchObject({ kind: 'totp', algorithm: 'SHA256', digits: 8, period: 60 });
    await expect(previewImport({ ...input, password: 'wrong' })).rejects.toThrow();
    db.bytes[0] ^= 1;
    await expect(previewImport({ ...input, bytes: strToU8(JSON.stringify({ ...root, db: db.bytes.toString('base64') })) })).rejects.toThrow();
    root.header.slots[0].n = 1 << 30;
    await expect(previewImport({ ...input, bytes: strToU8(JSON.stringify(root)) })).rejects.toThrow('安全范围');
  });
});
