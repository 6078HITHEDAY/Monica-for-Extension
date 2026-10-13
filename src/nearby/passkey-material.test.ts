import { beforeAll, describe, expect, it } from 'vitest';
import { prepareNearbyPasskey, retainNearbyPasskey, verifyNearbyPasskey } from './passkey-material';
import { bytesToBase64 } from '../security/encoding';
import { jsonNumber, parseLosslessJson } from '../core/lossless-json';
import { normalizeNearbyNativeData, wireInteger } from './wire-shape';

const keys = new Map<number, Record<string, unknown>>();
beforeAll(async () => {
  for (const algorithm of [-7, -257, -37, -8]) {
    const params = algorithm === -7 ? { name: 'ECDSA', namedCurve: 'P-256' }
      : algorithm === -8 ? { name: 'Ed25519' }
      : { name: algorithm === -37 ? 'RSA-PSS' : 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
    const pair = await crypto.subtle.generateKey(params, true, ['sign', 'verify']) as CryptoKeyPair;
    keys.set(algorithm, { credential_id: 'AQIDBA', rp_id: 'example.test', user_id: 'dXNlcg', public_key_algorithm: algorithm,
      public_key: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))),
      private_key_alias: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))), key_status: 'portable', sign_count: 0 });
  }
});

describe('nearby original Passkey material', () => {
  it.each([-7, -257, -37, -8])('verifies and derives legacy public material for algorithm %s without generating another key', async algorithm => {
    const source: Record<string, unknown> = { ...keys.get(algorithm)!, public_key: '', sign_count: 19 };
    const snapshot = JSON.stringify(source);
    const result = await prepareNearbyPasskey(source);
    expect(result.public_key).toBe(keys.get(algorithm)!.public_key);
    expect(result.private_key_alias).toBe(source.private_key_alias);
    expect(result.sign_count).toBe(19);
    expect(JSON.stringify(source)).toBe(snapshot);
    await expect(verifyNearbyPasskey(result)).resolves.toBeUndefined();
  });

  it.each(['arbitrary-keystore-alias', 'corrupt-private-key', ''])('does not disguise a missing or corrupt portable key as reference metadata: %s', async material => {
    await expect(prepareNearbyPasskey({ ...keys.get(-7)!, private_key_alias: material }, true)).rejects.toThrow();
  });

  it('does not drop an actual portable key when asked for a reference copy', async () => {
    await expect(prepareNearbyPasskey(keys.get(-7)!, true)).rejects.toThrow();
  });

  it('strips only recognized device references from an outgoing copy and keeps the stored alias on metadata merge', async () => {
    const source = { ...keys.get(-7)!, private_key_alias: 'monica-passkey-key-ref-v1:synthetic-device-key', key_status: 'reference' };
    const wire = await prepareNearbyPasskey(source, true);
    expect(wire.private_key_alias).toBe('');
    expect(source.private_key_alias).toBe('monica-passkey-key-ref-v1:synthetic-device-key');
    const merged = await retainNearbyPasskey({ ...wire, notes: 'new note' }, source);
    expect(merged.private_key_alias).toBe(source.private_key_alias);
    expect(merged.notes).toBe('new note');
    expect((await prepareNearbyPasskey(merged, true)).private_key_alias).toBe('');
  });

  it('keeps exact local key representation and lossless positive counters during metadata-only updates', async () => {
    const key = keys.get(-7)!;
    const source = { ...key, credential_id: 'AQIDBA==', private_key_alias: `-----BEGIN PRIVATE KEY-----\n${key.private_key_alias}\n-----END PRIVATE KEY-----`, sign_count: jsonNumber('9007199254740993'), backup_eligible: true, backup_state: true };
    const incoming = { ...key, private_key_alias: '', key_status: 'reference', notes: 'received note' };
    const result = await retainNearbyPasskey(incoming, source);
    expect(result.private_key_alias).toBe(source.private_key_alias);
    expect(result.credential_id).toBe(source.credential_id);
    expect(JSON.stringify(result.sign_count)).toBe('9007199254740993');
    expect(result.backup_eligible).toBe(true);
    expect(result.backup_state).toBe(true);
    expect(result.notes).toBe('received note');
    expect(keys.get(-7)!.sign_count).toBe(0);
  });

  it('rejects changed RP, credential, public key, backup eligibility and mismatched algorithm', async () => {
    const source = keys.get(-7)!;
    for (const change of [{ rp_id: 'other.test' }, { credential_id: 'CQgH' }, { public_key: keys.get(-8)!.public_key }, { backup_eligible: false }, { public_key_algorithm: -8 }]) {
      await expect(retainNearbyPasskey({ ...source, ...change }, source)).rejects.toThrow();
    }
    await expect(verifyNearbyPasskey({ ...source, private_key_alias: keys.get(-8)!.private_key_alias })).rejects.toThrow();
    await expect(verifyNearbyPasskey({ ...source, public_key: 'opaque private text' })).rejects.toMatchObject({ code: 'passkey-key-verification' });
  });
});

describe('nearby numeric schema boundaries', () => {
  it('accepts only real lossless numeric integers', () => {
    for (const value of ['19', 19n, { toString: () => '19' }, { rawJSON: '19' }, Infinity, 9007199254740992]) expect(() => wireInteger(value)).toThrow();
    expect(wireInteger(parseLosslessJson('9007199254740993'))).toBe(9007199254740993n);
    expect(() => wireInteger(parseLosslessJson('1e2'))).toThrow();
    expect(() => wireInteger(-1)).toThrow();
  });

  it('sorts Android signed custom field orders while preserving unknown numeric fields', () => {
    const source = parseLosslessJson('{"password":"secret","custom_fields":[{"title":"last","value":"b","sort_order":4},{"title":"first","value":"a","sortOrder":-3}],"opaque":{"id":"keep","n":1.00000000000000001}}') as Record<string, unknown>;
    const result = normalizeNearbyNativeData(source, 'login', '', 'login');
    expect((result.custom_fields as { title: string }[]).map(field => field.title)).toEqual(['first', 'last']);
    expect(JSON.stringify(result.extensions)).toContain('1.00000000000000001');
    expect((source.custom_fields as { title: string }[])[0].title).toBe('last');
  });
});
