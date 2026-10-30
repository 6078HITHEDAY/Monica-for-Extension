import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { createLoginItem, type IdentityItem, type LoginItem, type VaultItem } from '../core/model';
import { ANDROID_URL_RULE_FIELD, effectiveLoginUriRules, writeAndroidUrlRules } from '../core/url-rules';
import { PROJECT_CREDENTIAL_FIELD, readProjectCredential } from '../core/project-credentials';
import { readAndroidBackup, writeAndroidBackup, vaultItemToAndroidRecord } from './webdav/android-backup-codec';
import { decodeMdbx2Object, encodeMdbx2Object } from './mdbx2/mdbx2-item-codec';
import { decodeBitwardenCipher, encodeBitwardenCipher } from './bitwarden/bitwarden-cipher-codec';
import { nearbyLocalItemToWire, nearbyWireToLocalItem } from '../nearby/application-codec';
import { walletPayload } from '../autofill/wallet-payload';
import { normalizeImportedVaultItem } from '../manager/import-items';

const key = { encKey: new Uint8Array(32).fill(3), macKey: new Uint8Array(32).fill(4) };
const now = '2026-10-21T00:00:00.000Z';
const base = { ...createLoginItem({ title: 'Synthetic interop', notes: 'Project note' }), createdAt: now, updatedAt: now };
const metadata = '{"version":1,"groupId":"00000000-0000-0000-0000-000000000001","passwordId":"00000000-0000-0000-0000-000000000002","label":"Work","primary":true,"groupOrder":0,"passwordOrder":0,"note":"  Per-account\\r\\n备注  ","future":9007199254740993}';
const rules = '{"version":1,"future":9007199254740993,"urls":[{"url":"^https://Example\\\\.test/(a,b|c)$","mode":"REGEX","future":1.00000000000000001},{"url":"www.Example.test","mode":"HOST"}]}';
const login: LoginItem = { ...base, password: 'synthetic', passwordGroupId: '00000000-0000-0000-0000-000000000003',
  uris: ['https://fallback.invalid'], customFields: [
    { name: ANDROID_URL_RULE_FIELD, value: rules, protected: true },
    { name: PROJECT_CREDENTIAL_FIELD, value: metadata, protected: true }
  ] };
const pass = (template: string): IdentityItem => ({ ...base, kind: 'identity', documentType: 'OTHER', documentNumber: '0000123007',
  fullName: '  Fixture 持有人  ', firstName: '', middleName: '', lastName: '', issuedBy: 'Issuer', expiryDate: '2029-10-21',
  walletTemplate: template, walletFields: { tier: 'Gold', points: '000100', pointsExpiry: '2028-02-01', serviceNumber: 'G007',
    departure: '2026-10-21T10:30:00+08:00', arrival: '2026-10-21T11:30:00+09:00', future: '  untouched\r\n  ' },
  customFields: [{ name: 'Custom', value: '007', protected: true }] });

const transports: Record<string, (item: VaultItem) => Promise<VaultItem>> = {
  'Android ZIP': async item => {
    const doc = readAndroidBackup(zipSync({}), 'zip');
    const first = readAndroidBackup(writeAndroidBackup(doc, [item], 'zip'), 'zip');
    const edited = { ...first.items[0], title: 'Renamed fixture' };
    return readAndroidBackup(writeAndroidBackup(first, [edited], 'zip'), 'fresh').items[0];
  },
  'fresh MDBX object': async item => {
    const raw = encodeMdbx2Object(item)!;
    return decodeMdbx2Object({ ...raw, payloadSchemaVersion: raw.payloadSchemaVersion ?? 1, objectId: 'object', collectionId: 'collection', deleted: false },
      { headCommitId: 'head', updatedAt: now }, 'fresh').item!;
  },
  'encrypted Bitwarden cipher': async item => {
    const raw = await encodeBitwardenCipher(item, key);
    const first = (await decodeBitwardenCipher({ ...raw, id: 'cipher' }, 'bw', key)).items[0];
    const updated = await encodeBitwardenCipher({ ...first, title: 'Renamed fixture' }, key, raw);
    return (await decodeBitwardenCipher({ ...updated, id: 'cipher' }, 'fresh', key)).items[0];
  },
  'nearby application wire': async item => nearbyWireToLocalItem(await nearbyLocalItemToWire(item, {}), { id: 'fresh', providerId: 'local', now })
};

describe('Android 1.0.321 portable fields', () => {
  for (const [name, roundtrip] of Object.entries(transports)) {
    it(`${name}: preserves URL carrier bytes and independent credential notes`, async () => {
      const result = await roundtrip(login) as LoginItem;
      expect(result.kind).toBe('login');
      expect(result.customFields).toEqual(expect.arrayContaining(login.customFields));
      expect(effectiveLoginUriRules(result)).toEqual(effectiveLoginUriRules(login));
      expect(readProjectCredential(result.customFields)?.note).toBe('  Per-account\r\n备注  ');
      expect(result.notes).toBe('Project note');
    });
    it.each(['MEMBERSHIP', 'REWARDS', 'TRAVEL', 'FUTURE_TEMPLATE'])(`${name}: preserves %s, string numbers, timezone and unknown keys`, async template => {
      const original = pass(template), result = await roundtrip(original) as IdentityItem;
      expect(result.kind).toBe('identity');
      expect(result).toMatchObject({ walletTemplate: template, walletFields: original.walletFields, documentNumber: original.documentNumber, fullName: original.fullName });
      expect(walletPayload(result).fields).toEqual({});
      expect(normalizeImportedVaultItem(JSON.parse(JSON.stringify(result)))).toMatchObject({ walletTemplate: template, walletFields: original.walletFields });
    });
  }
  it('writes cleared wallet fields atomically, retaining unknown fields supplied by the editor', () => {
    const original = pass('REWARDS'), raw = vaultItemToAndroidRecord(original)!;
    const sourceData = JSON.parse(raw.itemData as string);
    const updated = vaultItemToAndroidRecord({ ...original, walletFields: { future: original.walletFields!.future } }, raw, original)!;
    expect(JSON.parse(updated.itemData as string).walletFields).toEqual({ future: sourceData.walletFields.future });
  });
  it('carries new HOST semantics in Bitwarden metadata without writing native host match', async () => {
    const raw = await encodeBitwardenCipher({ ...base, uriRules: [{ uri: 'www.example.test', matchType: 'host' }] }, key);
    expect((raw.login as { uris: { match: unknown }[] }).uris[0].match).toBe(null);
    const result = (await decodeBitwardenCipher({ ...raw, id: 'fresh' }, 'bw', key)).items[0] as LoginItem;
    expect(effectiveLoginUriRules(result)).toEqual([{ uri: 'www.example.test', matchType: 'host' }]);
  });
  it('clears an all-default carrier while keeping BASE_DOMAIN explicit', () => {
    expect(writeAndroidUrlRules(login.customFields, [{ uri: 'example.test', matchType: 'default' }])).toEqual([login.customFields[1]]);
  });
});
