import { beforeAll, describe, expect, it } from 'vitest';
import { createLoginItem, type LoginItem, type PasskeyItem, type VaultItem } from '../core/model';
import { parseLosslessJson } from '../core/lossless-json';
import { PROJECT_CREDENTIAL_FIELD } from '../core/project-credentials';
import { bytesToBase64 } from '../security/encoding';
import type { Mdbx2ObjectRecord } from '../providers/mdbx2/native-contract';
import { nearbyLocalItemToWire, nearbyNativeObjectToWire, nearbyWireToLocalItem, nearbyWireToNativeObject } from './application-codec';
import { LOCAL_FIELDS, PASSWORD_FIELDS, nearbyNativePayload, nearbyReferenceIds, normalizeNearbyNativeData, remapNearbyAssetPaths, remapNearbyReferences, validateNearbyWireData, wireObject } from './wire-shape';
import { NearbyPasskeyConsent, inspectNearbyPasskeyIssues } from './passkey-consent';

const now = '2026-10-15T00:00:00.000Z';
const folder = '11111111-1111-4111-8111-111111111111';
const parent = '22222222-2222-4222-8222-222222222222';
const fileHash = 'ab'.repeat(32);
const metadata = { folder: 'Personal', folder_path: [{ id: folder, parent: null, title: 'Personal' }],
  labels: [{ name: 'tag', payload: '{"n":9007199254740993}', version: 1 }], relations: [{ kind: 'bound-note', target: 'note-id', payload: '{}', version: 1 }],
  assets: [{ id: fileHash, file_name: 'image.bin', media_type: 'application/octet-stream', size: 0 }] };
const target = { id: 'receiver-id', providerId: 'local-provider', now };
function native(type: string, payload: Record<string, unknown>): Mdbx2ObjectRecord {
  return { objectId: 'source-id', collectionId: folder, objectTypeId: type, payloadSchemaVersion: 1, deleted: false, title: 'Native item', payloadJson: JSON.stringify(payload) };
}
let key: PasskeyItem;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  key = { ...createLoginItem({ title: 'Passkey' }), kind: 'passkey', rpId: 'example.test', rpName: 'Example', userName: 'alice', userDisplayName: 'Alice',
    credentialId: 'AQIDBA', userHandle: 'dXNlcg', algorithm: -7, signCount: 0, discoverable: true, sourceMode: 'browser-local',
    createdAt: now, updatedAt: now, privateKeyPkcs8: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))),
    publicKey: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))) };
});

describe('current Android nearby content shapes', () => {
  it('unwraps legacy password fields, sorting, archive/history and opaque numbers without changing the source', () => {
    const source = wireObject(parseLosslessJson('{"monica_password_encoding":"plaintext-v1","data":{"entry":{"id":8,"password":"secret","appPackageName":"example.app","loginType":4,"isArchived":true,"archivedAt":"2026-10-01T00:00:00Z","future":{"n":1.00000000000000001}},"customFields":[{"title":"second","value":"two","sortOrder":2},{"title":"first","value":"one","isProtected":true,"sortOrder":-1}],"passwordHistory":[{"password":"old","time":9007199254740993}]}}'));
    const saved = JSON.stringify(source);
    const wire = normalizeNearbyNativeData(source, 'Legacy', '', 'ssh-key');
    expect(wire).toMatchObject({ password_plain: 'secret', app_package_name: 'example.app', login_type: 'SSH_KEY', is_archived: true, archived_at: Date.parse('2026-10-01T00:00:00Z') });
    expect((wire.custom_fields as any[]).map(f => [f.title, f.is_protected])).toEqual([['first', true], ['second', false]]);
    expect(JSON.stringify(wire)).toContain('1.00000000000000001'); expect(JSON.stringify(wire)).toContain('9007199254740993');
    expect(JSON.stringify(source)).toBe(saved);
    const output = nearbyNativePayload(wire, 'new-id', folder, source);
    expect(output.data).toBeUndefined(); expect(output.password).toBeUndefined(); expect(output.appPackageName).toBeUndefined();
    expect(output).toMatchObject({ monica_password_encoding: 'plaintext-v1', monica_entry_id: 'new-id', mdbx_folder_id: folder, password_plain: 'secret' });
  });

  it.each(['note', 'totp', 'card', 'document-ref', 'identity', 'billing-address', 'payment-account', 'api-token', 'steam-mafile'] as const)('retains native and legacy %s content and metadata', async type => {
    const payload = { itemData: '{"future":1.00000000000000001}', mafile_json: '{"shared_secret":"AA==","account_name":"synthetic"}',
      createdAt: now, updatedAt: now, isFavorite: true, imagePaths: '["device-asset:' + fileHash + '"]', notes: 'note',
      monica_entry_id: 'private-source-id', device_sync_assets: { path: 'local' }, future: parseLosslessJson('{"n":9007199254740993,"__proto__":{"target":"opaque"}}') };
    const input = native(type, { data: { item: payload } });
    const result = await nearbyNativeObjectToWire(input, metadata);
    expect(result).toMatchObject({ ...metadata, entry_type: type, payload: { item_data: payload.itemData, is_favorite: true, created_at: Date.parse(now) } });
    const p = wireObject(result.payload); for (const local of LOCAL_FIELDS) expect(p).not.toHaveProperty(local);
    expect(JSON.stringify(result)).toContain('9007199254740993'); expect(JSON.stringify(result)).toContain('1.00000000000000001');
    expect(input.payloadJson).toContain('private-source-id');
  });

  it('retains folder and root metadata without pretending they are item upserts', async () => {
    const data = await nearbyNativeObjectToWire(native('folder', { path: metadata.folder_path, tags: metadata.labels }), {});
    const root = await nearbyNativeObjectToWire(native('vault-metadata', { tags: metadata.labels }), {});
    expect(() => validateNearbyWireData(root)).not.toThrow();
    await expect(nearbyWireToNativeObject(data, { logicalId: 'folder' })).rejects.toMatchObject({ code: 'metadata-requires-catalog' });
  });

  it('remaps only documented reference slots and preserves external and opaque IDs', () => {
    const data = normalizeNearbyNativeData({ password_plain: 'secret', sso_ref_entry_id: 'account-id', bound_note_entry_id: 'note-id',
      future: { id: 'opaque', target: 'opaque', path: [{ id: 'opaque' }] } }, 'Login', '', 'login');
    Object.assign(data, metadata, { folder_path: [{ id: folder, parent, title: 'Child' }] });
    const before = JSON.stringify(data), result = remapNearbyReferences(data, id => `mapped-${id}`);
    expect(nearbyReferenceIds(data).sort()).toEqual([folder, parent, 'account-id', 'note-id'].sort());
    expect(wireObject(result.extensions).future).toEqual(wireObject(data.extensions).future);
    expect(result.folder_path).toMatchObject([{ id: `mapped-${folder}`, parent: `mapped-${parent}` }]);
    expect(JSON.stringify(data)).toBe(before);
    data.relations = [{ target: 'https://external.example/reference', kind: 'ref', payload: '{}', version: 1 }];
    expect((remapNearbyReferences(data, () => 'mapped').relations as any[])[0].target).toBe('https://external.example/reference');
  });

  it('remaps note images, card paths and icons without replacing passwords or ordinary prose', () => {
    const from = `device-asset:${fileHash}`, to = 'local-attachment:target';
    const data = normalizeNearbyNativeData({ item_data: JSON.stringify({ content: `![alt](${from}) text ${from}`, photoPaths: [from],
      unknown: { text: from }, password: from, customIconValue: from }), image_paths: JSON.stringify([from]) }, 'Note', '', 'note');
    const remapped = remapNearbyAssetPaths(data, path => path === from ? to : path);
    const item = JSON.parse(String(wireObject(remapped.payload).item_data));
    expect(item).toMatchObject({ content: `![alt](${to}) text ${from}`, photoPaths: [to], password: from, unknown: { text: from }, customIconValue: to });
    expect(JSON.parse(String(wireObject(remapped.payload).image_paths))).toEqual([to]);
    expect(JSON.stringify(data)).not.toContain(to);
  });
});

describe('actual local editor mappings', () => {
  it('roundtrips rich projects through native wire and preserves unseen fields on an edit', async () => {
    const one: LoginItem = { ...createLoginItem({ title: 'Project', username: 'alice', password: 'secret', uris: ['https://example.test','https://second.test'] }),
      appPackageName: 'test.app', appName: 'App', email: 'alice@example.test', phone: '123', addressLine: 'Street', city: 'City', state: 'State', zipCode: '123', country: 'XX',
      passwordGroupId: folder, passkeyBindings: '{"credential":"AQIDBA"}', customFields: [{ name: 'duplicate', value: 'one', protected: true }, { name: 'duplicate', value: 'two', protected: false },
        { name: PROJECT_CREDENTIAL_FIELD, value: JSON.stringify({ version: 1, projectId: folder, groupId: parent, passwordId: folder, label: 'First', primary: true, groupOrder: 0, passwordOrder: 0 }), protected: true }],
      passwordHistory: [{ password: 'older', lastUsedAt: now }], createdAt: now, updatedAt: now };
    const wire = await nearbyLocalItemToWire(one, metadata);
    for (const field of PASSWORD_FIELDS) expect(typeof wire[field], field).toBe('string');
    wireObject(wire.extensions).unknown = parseLosslessJson('{"number":1.00000000000000001}');
    const projected = await nearbyWireToLocalItem(wire, target) as LoginItem;
    expect(projected).toMatchObject({ id: target.id, providerRefs: [{ providerId: target.providerId }], kind: 'login', password: one.password,
      appPackageName: one.appPackageName, email: one.email, addressLine: one.addressLine, customFields: one.customFields, passwordGroupId: folder });
    const edited = await nearbyLocalItemToWire({ ...projected, notes: 'edited' }, metadata, { item: projected, data: wire });
    expect(edited.notes).toBe('edited'); expect(edited.labels).toEqual(wire.labels); expect(edited.assets).toEqual(wire.assets);
    expect(JSON.stringify(edited)).toContain('1.00000000000000001'); expect(edited.password_history).toEqual(wire.password_history);
  });

  it('keeps API token companion labels, favorite, custom fields and strict payload separate', async () => {
    const item: VaultItem = { ...createLoginItem({ title: 'API token' }), kind: 'api-token', provider: 'Synthetic', apiBase: 'https://api.example.test',
      token: 'private token', notes: 'private notes', customFields: [{ name: 'project', value: 'secret', protected: true }], favorite: true };
    const wire = await nearbyLocalItemToWire(item, {});
    expect(wire.labels).toMatchObject([{ name: 'monica:api-token:fields:v1' }, { name: 'monica:api-token:favorite:v1' }]);
    const write = await nearbyWireToNativeObject(wire, { logicalId: 'api-token:' + folder });
    expect(JSON.parse(write.payloadJson)).not.toHaveProperty('monica_entry_id');
    expect(write.apiTokenFavorite).toBe(true);
    expect(await nearbyWireToLocalItem(wire, target)).toMatchObject({ kind: 'api-token', notes: item.notes, token: item.token, customFields: item.customFields, favorite: true });
    const source = { ...native('api-token', JSON.parse(write.payloadJson)), apiTokenMetadataJson: write.apiTokenMetadataJson, apiTokenFavorite: true };
    expect((await nearbyNativeObjectToWire(source, {})).labels).toEqual(wire.labels);
    await expect(nearbyNativeObjectToWire(source, { labels: [{ name: 'monica:api-token:fields:v1', payload: '{}', version: 1 }] })).rejects.toMatchObject({ code: 'api-token-catalog-conflict' });
    const labels = wire.labels as Record<string, unknown>[];
    labels[0].unknown = 'retain companion metadata';
    labels.push({ name: 'unknown-label', payload: '{"future":true}', version: 3 });
    const projected = await nearbyWireToLocalItem(wire, target);
    const edited = await nearbyLocalItemToWire({ ...projected, notes: 'edited private notes', favorite: false }, { labels }, { item: projected, data: wire });
    expect(edited.labels).toMatchObject([{ name: 'unknown-label', payload: '{"future":true}' }, { name: 'monica:api-token:fields:v1', unknown: 'retain companion metadata' }]);
    expect(await nearbyWireToLocalItem(edited, target)).toMatchObject({ notes: 'edited private notes', favorite: false, token: item.token, customFields: item.customFields });
    expect(labels.some(label => label.name === 'monica:api-token:favorite:v1')).toBe(true);
  });

  it('retains original key bytes and positive history when receiving metadata only', async () => {
    const wire = await nearbyLocalItemToWire(key, {});
    const p = wireObject(wire.payload); p.key_status = 'reference'; p.private_key_alias = ''; p.notes = 'new metadata';
    const old = { ...key, signCount: 19 };
    const next = await nearbyWireToLocalItem(wire, { ...target, previous: old });
    expect(next).toMatchObject({ kind: 'passkey', credentialId: key.credentialId, publicKey: key.publicKey, privateKeyPkcs8: key.privateKeyPkcs8, signCount: 19, notes: 'new metadata' });
  });
});

describe('recipient-specific nearby Passkey consent', () => {
  const record = async (patch: Partial<PasskeyItem> = {}) => ({ localId: key.id, deleted: false, data: await nearbyLocalItemToWire({ ...key, ...patch }, {}) });
  it('uses current key material, considers positive duplicate history and never leaks it to the review', async () => {
    const rows = [await record(), { ...await record({ signCount: 19 }), localId: 'other-copy' }];
    const issues = await inspectNearbyPasskeyIssues(rows);
    expect(issues).toHaveLength(2); expect(issues.every(issue => issue.skipForCounter && issue.restriction === 'counter-history')).toBe(true);
    expect(JSON.stringify(issues)).not.toContain(key.privateKeyPkcs8); expect(JSON.stringify(issues)).not.toContain(key.publicKey);
    expect(wireObject(rows[0].data.payload).sign_count).toBe(0);
  });
  it('binds consent to recipient, source session and current policy; rejects stale review tokens', async () => {
    const gate = new NearbyPasskeyConsent(), rows = [await record({ backupEligible: false })];
    const first = (await gate.review(rows, ['peer-a'], 'session-1/source-1'))!;
    expect(gate.confirm('wrong')).toBe(false); expect(gate.confirm(first.id)).toBe(true);
    expect(await gate.review(rows, ['peer-a'], 'session-1/source-1')).toBeUndefined();
    const other = (await gate.review(rows, ['peer-b'], 'session-1/source-1'))!;
    expect(other.peers).toEqual(['peer-b']); expect(gate.confirm(first.id)).toBe(false);
    const changed = (await gate.review([await record({ backupEligible: false, signCount: 1 })], ['peer-a'], 'session-1/source-1'))!;
    expect(gate.confirm(other.id)).toBe(false); expect(changed.issues[0].skipForCounter).toBe(true);
    gate.reset(); expect(gate.confirm(changed.id)).toBe(false);
    expect(await gate.review(rows, ['peer-a'], 'session-2/source-1')).toBeDefined();
  });
  it('fails closed for invalid keys and invalid flags instead of offering metadata consent', async () => {
    const row = await record(); wireObject(row.data.payload).private_key_alias = 'bad';
    await expect(inspectNearbyPasskeyIssues([row])).rejects.toThrow();
    await expect(record({ backupEligible: false, backupState: true })).rejects.toThrow();
    await expect(record({ signCount: 0, signCountHighWaterMark: 19 })).rejects.toThrow();
  });
  it('rejects metadata that changes the credential user handle', async () => {
    const data = (await record()).data;
    wireObject(data.payload).user_id = 'YW5vdGhlci11c2Vy';
    await expect(nearbyWireToLocalItem(data, { ...target, previous: key })).rejects.toMatchObject({ code: 'passkey-user-conflict' });
  });
});
