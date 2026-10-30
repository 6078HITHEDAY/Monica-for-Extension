import { expect, it } from 'vitest';
import { zipSync } from 'fflate';
import type { BillingAddressItem, CardItem, IdentityItem, ProviderAccount, VaultItem } from '../core/model';
import { ADDRESS_EXTRAS, CARD_NAMES, PROFILE_EXTRAS, profileValues } from '../core/profile-fields';
import { normalizeImportedVaultItem } from '../manager/import-items';
import { monicaItemDataToVaultItem, monicaItemTypeForKind, vaultItemToMonicaItemData } from './monica-item-data';
import { readAndroidBackup, writeAndroidBackup } from './webdav/android-backup-codec';
import { decodeMdbx2Object, encodeMdbx2Object } from './mdbx2/mdbx2-item-codec';
import { KeePassProvider } from './keepass/keepass-provider';
import { buildKeePassFixture } from './keepass/keepass-fixture';
import { encodeBitwardenCipher, decodeBitwardenCipher } from './bitwarden/bitwarden-cipher-codec';
import { decryptBitwardenString } from './bitwarden/bitwarden-crypto';

const base = { title: 'Synthetic independent fields', favorite: false, notes: '', createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z', providerRefs: [] };
const extras = { district: 'Synthetic county', homeEmail: 'home@example.test', homePhone: '+12025550143', workEmail: 'work@example.test', workPhone: '+12025550144' };
const names = { firstName: 'Independent', middleName: 'Middle', lastName: 'Parts' };
const address: BillingAddressItem = { ...base, ...extras, ...names, id: 'address', kind: 'billing-address', fullName: 'Separate Full Name', company: '', streetAddress: 'Line one', apartment: 'Line two', addressLine3: 'Line three', city: 'City', stateProvince: 'State', postalCode: '00001', country: 'US', email: 'default@example.test', phone: '+12025550142' };
const identity: IdentityItem = { ...base, ...extras, ...names, id: 'identity', kind: 'identity', fullName: 'Another Full Name', documentType: 'OTHER', documentNumber: 'SYNTHETIC', address3: 'Line three', address: { streetAddress: 'Line one', apartment: 'Line two' } };
const card: CardItem = { ...base, id: 'card', kind: 'card', cardholderName: 'Separate Holder', cardholderFirstName: 'CardFirst', cardholderMiddleName: 'CardMiddle', cardholderLastName: 'CardLast', number: '4111111111111111', securityCode: '123', expiryMonth: '12', expiryYear: '2030', billingAddress: JSON.stringify({ streetAddress: 'Line one', district: 'County', addressLine3: 'Line three' }) };
const items = [address, identity, card];
function expected(item: VaultItem) {
  return item.kind === 'card' ? { ...profileValues(item, CARD_NAMES), cardholderName: item.cardholderName, billingAddress: item.billingAddress }
    : item.kind === 'identity' ? { ...profileValues(item, PROFILE_EXTRAS), ...names, fullName: item.fullName, address3: item.address3 }
    : { ...profileValues(item, ADDRESS_EXTRAS), fullName: (item as BillingAddressItem).fullName };
}
it.each(items)('preserves independent $kind values through JSON import, Monica data, Android ZIP and native object codecs', item => {
  expect(normalizeImportedVaultItem(item)).toMatchObject(expected(item));
  const data = JSON.parse(vaultItemToMonicaItemData(item)!);
  expect(monicaItemDataToVaultItem(monicaItemTypeForKind(item.kind)!, data, { ...base, id: item.id })).toMatchObject(expected(item));
  let zip = writeAndroidBackup(readAndroidBackup(zipSync({}), 'zip'), [item], 'zip');
  const doc = readAndroidBackup(zip, 'zip'); expect(doc.items[0]).toMatchObject(expected(item));
  const current = doc.items[0];
  if (current.kind !== 'card' && current.kind !== 'identity' && current.kind !== 'billing-address') throw new Error('Unexpected profile kind');
  const changed: VaultItem = current.kind === 'card'
    ? { ...current, cardholderFirstName: '' }
    : { ...current, homeEmail: '', firstName: '' };
  zip = writeAndroidBackup(doc, [changed], 'zip');
  expect(readAndroidBackup(zip, 'zip').items[0]).toMatchObject(item.kind === 'card' ? { cardholderFirstName: '', cardholderName: card.cardholderName } : { homeEmail: '', firstName: '', fullName: item.fullName });
  const encoded = encodeMdbx2Object(item)!;
  const native = decodeMdbx2Object({ ...encoded, objectId: 'synthetic-object', collectionId: 'synthetic-collection', payloadSchemaVersion: 1, deleted: false }, { headCommitId: 'synthetic-commit', updatedAt: base.updatedAt }, 'native');
  expect(native.item).toMatchObject(expected(item));
});
it('never constructs a full name from old independent name parts', () => {
  expect(monicaItemDataToVaultItem('DOCUMENT', names, { ...base, id: 'legacy' })).toMatchObject({ ...names, fullName: '' });
  expect(monicaItemDataToVaultItem('DOCUMENT', { ...names, fullName: '', name: 'Legacy alias' }, { ...base, id: 'cleared' })).toMatchObject({ ...names, fullName: '' });
});
it('preserves profiles through encrypted KDBX create, edit and reopen', async () => {
  const account: ProviderAccount = { id: 'kdbx', kind: 'keepass', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false, config: { databaseId: 320 } };
  const provider = new KeePassProvider();
  await provider.unlock(account, await buildKeePassFixture({ password: 'synthetic', entries: [] }), { password: 'synthetic' });
  for (const item of items) await provider.create(account, item);
  const bytes = await provider.exportFile(account.id); provider.lock();
  const restored = new KeePassProvider(); await restored.unlock(account, bytes, { password: 'synthetic' });
  const loaded = (await restored.sync(account, { now: base.updatedAt, localItems: [] })).items;
  for (const item of items) {
    const current = loaded.find(value => value.kind === item.kind)!; expect(current).toMatchObject({ ...expected(item), ...(item.kind === 'card' ? { billingAddress: 'Line one\nLine three\nCounty' } : {}) });
    await restored.update(account, { ...current, ...(current.kind === 'card' ? { cardholderFirstName: '' } : { firstName: '', homePhone: '' }) } as VaultItem);
  }
  const edited = await restored.exportFile(account.id); restored.lock();
  await restored.unlock(account, edited, { password: 'synthetic' });
  for (const item of (await restored.sync(account, { now: base.updatedAt, localItems: [] })).items)
    expect(item).toMatchObject(item.kind === 'card' ? { cardholderFirstName: '', cardholderName: card.cardholderName } : { firstName: '', homePhone: '' });
  restored.lock();
});
it.each([identity, card])('encrypts $kind extension names and values, preserves explicit clearing and filters duplicate custom fields', async item => {
  const key = { encKey: new Uint8Array(32).fill(3), macKey: new Uint8Array(32).fill(4) };
  let raw = await encodeBitwardenCipher({ ...item, customFields: [{ name: item.kind === 'card' ? 'Cardholder First Name' : 'monica_full_name', value: 'Duplicate', protected: true }] }, key);
  expect(JSON.stringify(raw)).not.toContain(item.kind === 'card' ? 'Cardholder First Name' : 'monica_full_name');
  const decoded = (await decodeBitwardenCipher({ ...raw, id: 'synthetic-cipher' }, 'bw', key)).items[0];
  expect(decoded).toMatchObject(expected(item)); expect((decoded as CardItem).customFields).toEqual([]);
  raw = await encodeBitwardenCipher({ ...decoded, ...(decoded.kind === 'identity' ? { fullName: '', homeEmail: '' } : { cardholderFirstName: '' }) } as VaultItem, key, raw);
  const next = await decodeBitwardenCipher({ ...raw, id: 'synthetic-cipher' }, 'bw', key);
  expect(next.items[0]).toMatchObject(item.kind === 'identity' ? { fullName: '', homeEmail: '', firstName: 'Independent' } : { cardholderFirstName: '', cardholderName: 'Separate Holder' });
  const fields = await Promise.all((raw.fields as { name: string; value: string }[]).map(async f => [await decryptBitwardenString(f.name, key), await decryptBitwardenString(f.value, key)]));
  const name = item.kind === 'identity' ? 'monica_full_name' : 'Cardholder First Name';
  expect(fields.filter(f => f[0] === name)).toEqual([[name, '']]);
  if (item.kind === 'identity') {
    expect(next.legacyIdentityFullName).toBe(false);
    const without = { ...raw, fields: (raw.fields as { name: string }[]).filter((_, i) => fields[i][0] !== name) };
    expect(await decodeBitwardenCipher({ ...without, id: 'legacy' }, 'bw', key)).toMatchObject({ legacyIdentityFullName: true, items: [{ fullName: '', firstName: 'Independent' }] });
  }
});
