import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { monicaItemDataToVaultItem, vaultItemToMonicaItemData } from './monica-item-data';
import { androidRecordToItem, readAndroidBackup, writeAndroidBackup, vaultItemToAndroidRecord } from './webdav/android-backup-codec';
import { decodeMdbx2Object, encodeMdbx2Object } from './mdbx2/mdbx2-item-codec';
import { buildKeePassSecureItemFields, readKeePassSecureItemFields, keePassSecureItemToVaultItem } from './keepass/keepass-secure-item-codec';
import { normalizeImportedVaultItem } from '../manager/import-items';

const base = { id: 'wallet-order', title: 'Synthetic wallet', notes: '', favorite: false, providerRefs: [],
  createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' };
const cases = [
  { type: 'BANK_CARD' as const, folder: 'bank_cards', native: 'card', data: { cardNumber: '4111111111111111', cardholderName: 'Fixture', expiryMonth: '12', expiryYear: '2030', cvv: '123' } },
  { type: 'DOCUMENT' as const, folder: 'documents', native: 'document-ref', data: { documentType: 'PASSPORT', documentNumber: 'SYNTHETIC', fullName: 'Fixture' } }
];
const order = ['custom', 'extended', 'future-section', 'custom'];
const orderOf = (item: unknown) => (item as Record<string, unknown>)?.editorSectionOrder;

describe('Android 1.0.318 wallet section order', () => {
  for (const fixture of cases) {
    it(`${fixture.type}: carries exact order into a fresh MDBX and Android backup record`, () => {
      const data = { ...fixture.data, editorSectionOrder: order };
      const item = monicaItemDataToVaultItem(fixture.type, data, base)!;
      expect(orderOf(item)).toEqual(order);
      // No source envelope: this is the copy/transfer path that previously lost the field.
      const copied = normalizeImportedVaultItem(JSON.parse(JSON.stringify({ ...item, title: 'Copied wallet', providerRefs: [] })))!;
      expect(copied.kind).toBe(item.kind);
      const native = encodeMdbx2Object(copied)!;
      const reopened = decodeMdbx2Object({ ...native, payloadSchemaVersion: native.payloadSchemaVersion ?? 1, objectId: 'new-object', collectionId: 'new-collection', deleted: false },
        { headCommitId: 'new-commit', updatedAt: base.updatedAt }, 'new-provider');
      expect(orderOf(reopened.item)).toEqual(order);
      const raw = vaultItemToAndroidRecord(reopened.item!)!;
      expect(JSON.parse(raw.itemData as string).editorSectionOrder).toEqual(order);
      const restored = androidRecordToItem(`${fixture.folder}/1.json`, raw, 'backup');
      expect(orderOf(restored)).toEqual(order);
      expect(restored?.title).toBe('Copied wallet');
      const backup = readAndroidBackup(zipSync({ [`${fixture.folder}/1.json`]: strToU8(JSON.stringify(raw)) }), 'backup');
      const edited = { ...backup.items[0], title: 'Edited after import' };
      const returned = readAndroidBackup(writeAndroidBackup(backup, [edited], 'backup'), 'fresh');
      expect(orderOf(returned.items[0])).toEqual(order);
      expect(returned.items[0].title).toBe(edited.title);
    });

    it(`${fixture.type}: preserves absent, empty and unknown section tokens independently of edits`, () => {
      for (const value of [undefined, [], order]) {
        const raw = JSON.stringify({ ...fixture.data, editorSectionOrder: value, future: { retained: true } });
        const item = monicaItemDataToVaultItem(fixture.type, JSON.parse(raw), base)!;
        expect(orderOf(item)).toEqual(value);
        const encoded = JSON.parse(vaultItemToMonicaItemData({ ...item, title: 'Changed' }, raw, item)!);
        expect(encoded).toEqual(JSON.parse(raw));
        const fresh = JSON.parse(vaultItemToMonicaItemData(item)!);
        expect(fresh.editorSectionOrder).toEqual(value);
        expect(Object.prototype.hasOwnProperty.call(fresh, 'editorSectionOrder')).toBe(value !== undefined);
      }
    });

    it(`${fixture.type}: keeps malformed order data in a read-only source record`, () => {
      for (const value of [null, 'custom,extended', ['custom', 7], { future: true }]) {
        const itemData = JSON.stringify({ ...fixture.data, editorSectionOrder: value });
        const record = { id: 1, title: base.title, itemType: fixture.type, itemData };
        const bytes = JSON.stringify(record);
        const backup = readAndroidBackup(zipSync({ [`${fixture.folder}/1.json`]: strToU8(bytes) }), 'backup');
        expect(backup.items[0]).toMatchObject({ kind: 'opaque', originalPayload: bytes });
        const imported = normalizeImportedVaultItem({ ...base, kind: fixture.native === 'card' ? 'card' : 'identity', editorSectionOrder: value });
        expect(imported?.kind).toBe('opaque');
        const native = decodeMdbx2Object({ objectId: 'bad-shape', collectionId: 'wallet', objectTypeId: fixture.native,
          title: base.title, payloadSchemaVersion: 1, deleted: false, payloadJson: JSON.stringify({ item_data: itemData }) },
        { headCommitId: 'commit', updatedAt: base.updatedAt }, 'source');
        expect(native.item?.kind).toBe('opaque');
      }
    });
  }

  it('carries document order through a fresh native KeePass entry', () => {
    const item = monicaItemDataToVaultItem('DOCUMENT', { ...cases[1].data, editorSectionOrder: order }, base)!;
    const fields = buildKeePassSecureItemFields({ item })!;
    const restored = keePassSecureItemToVaultItem(readKeePassSecureItemFields(fields)!, base)!;
    expect(orderOf(restored)).toEqual(order);
  });
});
