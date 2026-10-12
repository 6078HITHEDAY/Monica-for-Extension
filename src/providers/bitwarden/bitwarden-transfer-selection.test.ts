import { expect, it } from 'vitest';
import type { LoginItem, PasskeyItem, TotpItem, VaultItem, ProviderAccount } from '../../core/model';
import { createLoginItem } from '../../core/model';
import { bitwardenTransferSelection } from './bitwarden-transfer-selection';

const providers: ProviderAccount[] = ['bw', 'other'].map(id => ({ id, kind: 'bitwarden', enabled: true, name: id, config: {}, isDefaultSaveTarget: false }));
function login(id: string, cipher: string, providerId = 'bw'): LoginItem {
  return { ...createLoginItem({ title: 'Same title', username: 'same user', password: 'synthetic', providerRefs: [{ providerId, remoteId: cipher }] }), id };
}
function passkey(id: string, cipher: string, providerId = 'bw'): PasskeyItem {
  return { ...login(id, `${cipher}#fido2:${id}`, providerId), kind: 'passkey', credentialId: id, rpId: 'example.test', rpName: 'Synthetic',
    userHandle: 'dXNlcg', userName: 'synthetic', userDisplayName: 'Synthetic', algorithm: -7, publicKey: '', signCount: 0, discoverable: true, sourceMode: 'bitwarden' };
}

it('expands one Passkey to its complete native record, password project and further native siblings', () => {
  const first = { ...login('parent', 'cipher-one'), passwordGroupId: 'project' };
  const second = { ...login('second', 'cipher-two'), passwordGroupId: 'project' };
  const otp: TotpItem = { ...login('otp', 'cipher-one#totp'), kind: 'totp', secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1' };
  const items: VaultItem[] = [first, second, passkey('chosen', 'cipher-one'), passkey('sibling', 'cipher-one'), otp,
    passkey('project-sibling', 'cipher-two'), login('same-title-independent', 'third'), passkey('other-vault', 'cipher-one', 'other')];
  const result = bitwardenTransferSelection(['chosen'], items, providers);
  expect(result.selectedIds.sort()).toEqual(['parent', 'second', 'chosen', 'sibling', 'otp', 'project-sibling'].sort());
  expect(result.components).toHaveLength(1); expect(new Set(result.components[0])).toEqual(new Set(result.selectedIds));
});

it('follows a project SSO dependency and then expands that target Cipher without joining an independent record', () => {
  const owner = { ...login('owner', 'owner-cipher'), ssoRefLogicalId: 'password:account' };
  const items = [owner, passkey('entry', 'owner-cipher'), login('account', 'account-cipher'), passkey('account-passkey', 'account-cipher'), login('independent', 'separate')];
  const result = bitwardenTransferSelection(['entry', 'independent'], items, providers);
  expect(result.selectedIds).toHaveLength(5);
  expect(result.components.map(row => row.sort()).sort((a, b) => a.length - b.length)).toEqual([
    ['independent'], ['account', 'account-passkey', 'entry', 'owner']
  ]);
});

it('does not drop an inconsistently deleted native parent out of the preparation input', () => {
  const result = bitwardenTransferSelection(['entry'], [{ ...login('parent', 'cipher'), deletedAt: '2026-10-12T00:00:00Z' }, passkey('entry', 'cipher')], providers);
  expect(result.selectedIds).toEqual(['parent', 'entry']);
});

it('rejects stale selections and the expanded 200-item limit before preparing writes', () => {
  expect(() => bitwardenTransferSelection(['missing'], [], providers)).toThrow('变化');
  const items = Array.from({ length: 201 }, (_, n) => passkey(`passkey-${n}`, 'one-cipher'));
  expect(() => bitwardenTransferSelection(['passkey-0'], items, providers)).toThrow('200');
});
