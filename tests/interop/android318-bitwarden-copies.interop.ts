import { readFile, writeFile } from 'node:fs/promises';
import { createHash, createPublicKey, verify } from 'node:crypto';
import path from 'node:path';
import { expect, it } from 'vitest';
import { decodeBitwardenCipher } from '../../src/providers/bitwarden/bitwarden-cipher-codec';
import type { PasskeyItem } from '../../src/core/model';

const directory = process.env.MONICA_BITWARDEN_SNAPSHOT_DIR;
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
for (const name of ['direct', 'copies-complete', 'copies-cancel']) it.skipIf(!directory)(`current Android native Bitwarden return preserves ${name}`, async () => {
  if (!directory) throw new Error('Explicit fixture required');
  expect(['.tmp/android-bitwarden-copies-runtime-318','.tmp/android-bitwarden-repaired-318'].map(value=>path.resolve(value))).toContain(path.resolve(directory));
  const read = async (file: string) => JSON.parse(await readFile(path.join(directory, file), 'utf8'));
  const device = await read('bitwarden-copies-evidence.json');
  for (const field of ['androidSourcesUnchanged', 'testSourcesUnchanged', 'installedApplicationUnchanged', 'installedTestApkUnchanged', 'deviceBootUnchanged'])
    expect(device[field], field).toBe(true);
  const outputBytes = await readFile(path.join(directory, 'android-bitwarden-copies.json'));
  expect(hash(outputBytes)).toBe(device.outputs.find((row: any) => row.name === 'android-bitwarden-copies.json').sha256);
  const source = await read(`${name}-input.json`), returned = JSON.parse(outputBytes.toString()).cases.find((row: any) => row.name === name);
  const key = {encKey: new Uint8Array(Buffer.from(source.vaultKeyEnc, 'base64')), macKey: new Uint8Array(Buffer.from(source.vaultKeyMac, 'base64'))};
  const evidence: any = {name, status: 'failed', androidCaseStatus: returned.status, signatures: 0,
    beforeCredentials: source.expected.length, afterCredentials: 0, missingCredentials: [], changedSharedFields: [], notesPreserved: true,
    syntheticHttp: true, systemCredentialManagerTested: false, androidCounterPolicyVerified: false};
  try {
    for (const proof of [...(returned.before || []), ...(returned.fresh || [])]) {
      const wanted = source.expected.find((row: any) => row.credentialId === proof.credentialId && row.cipherId === proof.cipherId);
      expect(wanted).toBeDefined();
      expect(proof).toMatchObject({rpId: wanted.rpId, userHandle: wanted.userHandle, keyMaterialSha256: wanted.keyMaterialSha256,
        storedSignCount: wanted.signCount, protectedRoomReference: true});
      const auth = Buffer.from(proof.authenticatorData, 'base64'), client = Buffer.from(proof.clientDataJSON, 'base64');
      expect(auth.length).toBe(37); expect(auth.subarray(0, 32).toString('hex')).toBe(hash(wanted.rpId));
      expect(auth[32]).toBe(0x1d); expect(auth.readUInt32BE(33)).toBe(0);
      expect(JSON.parse(client.toString())).toMatchObject({type: 'webauthn.get', origin: `https://${wanted.rpId}`, crossOrigin: false});
      expect(verify('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]),
        createPublicKey({key: Buffer.from(wanted.spki, 'base64'), format: 'der', type: 'spki'}), Buffer.from(proof.signature, 'base64'))).toBe(true);
      evidence.signatures++;
    }
    const decoded = [];
    for (const raw of returned.ciphers || []) {
      const items = (await decodeBitwardenCipher(raw, 'snapshot', key)).items;
      decoded.push(...items);
      const prior = source.sync.ciphers.find((row: any) => (row.id ?? row.Id) === (raw.id ?? raw.Id));
      // Compare the whole native parent, including unknown fields, not only modeled login fields.
      const stableParent = (cipher: any) => {
        const value=structuredClone(cipher);
        // The older Edge mock echoed the request-only CAS token into GET responses.
        // It is a transport precondition, not persisted Cipher content.
        for (const field of ['notes','Notes','revisionDate','RevisionDate','lastKnownRevisionDate','LastKnownRevisionDate']) delete value[field];
        for (const field of ['login','Login']) if(value[field]) {
          delete value[field].fido2Credentials; delete value[field].Fido2Credentials;
        }
        return value;
      };
      expect(stableParent(raw), 'Native parent fields must survive a Passkey edit').toEqual(stableParent(prior));
      const oldLogin = (await decodeBitwardenCipher(prior, 'snapshot', key)).items.find(row => row.kind === 'login');
      const newLogin = items.find(row => row.kind === 'login');
      for (const field of ['password', 'username', 'passwordGroupId', 'customFields', 'uris']) {
        if (JSON.stringify(oldLogin && Reflect.get(oldLogin, field)) !== JSON.stringify(newLogin && Reflect.get(newLogin, field)))
          evidence.changedSharedFields.push({cipherId: raw.id ?? raw.Id, field});
      }
    }
    const passkeys = decoded.filter((row): row is PasskeyItem => row.kind === 'passkey');
    evidence.afterCredentials = passkeys.length;
    evidence.distinctCredentialsBefore = new Set(source.expected.map((row: any) => row.credentialId)).size;
    evidence.distinctCredentialsAfter = new Set(passkeys.map(row => row.credentialId)).size;
    evidence.globallyMissingCredentialIds = [...new Set<string>(source.expected.map((row: any) => row.credentialId))]
      .filter(id => !passkeys.some(row => row.credentialId === id));
    for (const wanted of source.expected) {
      const item = passkeys.find(row => row.credentialId === wanted.credentialId && row.providerRefs[0].remoteId?.split('#')[0] === wanted.cipherId);
      if (!item) { evidence.missingCredentials.push({credentialId: wanted.credentialId, cipherId: wanted.cipherId}); continue; }
      expect(createHash('sha256').update(Buffer.from(item.privateKeyPkcs8!, 'base64')).digest('base64')).toBe(wanted.keyMaterialSha256);
      expect(item.signCount).toBe(wanted.signCount);
      const notes = `Android ${name} ${wanted.cipherId}\n---\n完整备注🔑`;
      if (item.notes !== notes) evidence.notesPreserved = false;
    }
    expect(evidence.missingCredentials, 'Every original source credential binding must survive native Android upload').toEqual([]);
    expect(evidence.changedSharedFields, 'Editing a Passkey must preserve its parent login content').toEqual([]);
    expect(evidence.notesPreserved).toBe(true);
    expect(returned.status).toBe('passed');
    evidence.status = 'passed';
  } finally { await writeFile(path.join(directory, `independent-${name}.json`), JSON.stringify(evidence, null, 2)); }
});
