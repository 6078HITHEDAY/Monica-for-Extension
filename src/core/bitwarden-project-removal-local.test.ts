import {describe, expect, it} from 'vitest';
import type {PasskeyItem} from './model';
import type {PasswordProjectRemovalRecord} from './password-project-removal-journal';
import {sameBitwardenProjectChildren, snapshotBitwardenProjectChildren} from './bitwarden-project-removal-local';

const item: PasskeyItem = {id: 'key', kind: 'passkey', title: 'Synthetic', notes: '', favorite: false,
  createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z',
  providerRefs: [{providerId: 'bw', remoteId: 'source#fido2:credential', revision: '1'}],
  credentialId: 'Y3JlZGVudGlhbA', rpId: 'example.test', rpName: 'Synthetic RP', userHandle: 'dXNlcg', userName: 'Synthetic', userDisplayName: 'Synthetic', publicKey: '',
  privateKeyPkcs8: 'synthetic-fixture-key', algorithm: -7, signCount: 0, discoverable: true, sourceMode: 'bitwarden'};
const record = {providerBindings: [{id: 'bw', kind: 'bitwarden'}], retained: [],
  removed: [{providerRefs: [{providerId: 'bw', remoteId: 'source'}]}]} as unknown as PasswordProjectRemovalRecord;

describe('Bitwarden project local credential snapshots', () => {
  it('ignores only local usage counters and time while retaining a full snapshot for old readers', async () => {
    const before = await snapshotBitwardenProjectChildren(record, [item]);
    const after = await snapshotBitwardenProjectChildren(record, [{...item, useCount: 4, lastUsedAt: '2026-10-09T23:00:00Z'}]);
    expect(before[0].snapshotSha256).not.toBe(after[0].snapshotSha256);
    expect(sameBitwardenProjectChildren(before, after)).toBe(true);
    const legacy = before.map(({usageIndependentSha256: _unused, ...row}) => row);
    expect(sameBitwardenProjectChildren(legacy, before)).toBe(true);
    expect(sameBitwardenProjectChildren(legacy, after)).toBe(false);
  });

  it.each([
    {signCount: 1}, {signCountHighWaterMark: 2}, {privateKeyPkcs8: 'changed-key'}, {credentialId: 'b3RoZXI'},
    {userHandle: 'b3RoZXI'}, {backupEligible: false}, {backupState: false}, {userVerificationRequired: true},
    {notes: 'changed note'}, {favorite: true}, {updatedAt: '2026-10-09T23:00:00Z'},
    {providerRefs: [{providerId: 'bw', remoteId: 'source#fido2:credential', revision: '2'}]}
  ])('rejects a content, signing policy, identity or reference change: %j', async change => {
    const before = await snapshotBitwardenProjectChildren(record, [item]);
    const after = await snapshotBitwardenProjectChildren(record, [{...item, ...change}]);
    expect(sameBitwardenProjectChildren(before, after)).toBe(false);
  });

  it('rejects a missing or additional projection', async () => {
    const before = await snapshotBitwardenProjectChildren(record, [item]);
    expect(sameBitwardenProjectChildren(before, [])).toBe(false);
    expect(sameBitwardenProjectChildren(before, [...before, {...before[0], itemId: 'extra'}])).toBe(false);
  });
});
