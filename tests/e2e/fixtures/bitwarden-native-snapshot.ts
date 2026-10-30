import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { expect } from '@playwright/test';
import type { PasskeyItem } from '../../../src/core/model';
import { decodeBitwardenCipher } from '../../../src/providers/bitwarden/bitwarden-cipher-codec';
import type { BitwardenSymmetricKey } from '../../../src/providers/bitwarden/bitwarden-crypto';

/** Opt-in export of synthetic native Ciphers, never browser/profile storage. */
export async function saveBitwardenNativeSnapshot(name: string, ciphers: Record<string, unknown>[], key: BitwardenSymmetricKey, originals: PasskeyItem[]) {
  const directory = process.env.MONICA_BITWARDEN_SNAPSHOT_DIR;
  if (!directory) return;
  expect(['.tmp/android-bitwarden-copies-runtime-318','.tmp/android-bitwarden-repaired-318'].map(value=>path.resolve(value))).toContain(path.resolve(directory));
  expect(name).toMatch(/^[a-z-]+$/);
  const expected = [];
  for (const raw of ciphers.filter(row => !(row.deletedDate || row.DeletedDate))) {
    for (const item of (await decodeBitwardenCipher(raw, 'snapshot', key)).items) {
      if (item.kind !== 'passkey') continue;
      const original = originals.find(row => row.credentialId === item.credentialId)!;
      expect(original?.publicKey).toBeTruthy();
      expected.push({cipherId: raw.id ?? raw.Id, credentialId: item.credentialId, rpId: item.rpId,
        userHandle: item.userHandle, userName: item.userName, userDisplayName: item.userDisplayName,
        signCount: item.signCount, notes: item.notes, spki: original.publicKey,
        keyMaterialSha256: createHash('sha256').update(Buffer.from(item.privateKeyPkcs8!, 'base64')).digest('base64')});
    }
  }
  await mkdir(directory, {recursive: true});
  await writeFile(path.join(directory, `${name}-input.json`), JSON.stringify({synthetic: true, name,
    vaultKeyEnc: Buffer.from(key.encKey).toString('base64'), vaultKeyMac: Buffer.from(key.macKey).toString('base64'),
    sync: {profile: {id: `synthetic-${name}`, email: `${name}@example.invalid`}, folders: [],
      ciphers: ciphers.filter(row => !(row.deletedDate || row.DeletedDate))}, expected}, null, 2));
}
