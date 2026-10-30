import { describe, expect, it } from 'vitest';
import type { ProviderAccount } from '../../core/model';
import { sameProviderBinding } from '../../core/provider';
import { mdbx2AccountBackend, mdbx2AccountHandleBackend } from './account-backend';

const account = (runtimeBackend?: unknown): ProviderAccount => ({ id: 'synthetic', kind: 'mdbx2', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false,
  config: { vaultHandle: 'vault', syncStateHandle: 'state', ...(runtimeBackend === undefined ? {} : { runtimeBackend }) } });
describe('encrypted MDBX account origin', () => {
  it('preserves absent legacy metadata and recognizes explicit browser ownership', () => {
    expect(mdbx2AccountBackend(account())).toBe('native'); expect(mdbx2AccountBackend(account('browser'))).toBe('browser');
    expect(sameProviderBinding(account(), account('native'))).toBe(true);
    expect(sameProviderBinding(account(), account('browser'))).toBe(false);
  });
  it('returns only owned runtime roles and refuses conflicting accounts', () => {
    expect(mdbx2AccountHandleBackend([account('browser')], 'vault', 'vault')).toBe('browser');
    expect(mdbx2AccountHandleBackend([account('browser')], 'state', 'state')).toBe('browser');
    expect(mdbx2AccountHandleBackend([account('browser')], 'vault', 'file')).toBeUndefined();
    expect(mdbx2AccountHandleBackend([account('browser')], 'elsewhere', 'vault')).toBeUndefined();
    expect(() => mdbx2AccountHandleBackend([account(), account('browser')], 'vault', 'vault')).toThrow();
  });
  it('does not reinterpret malformed metadata as native', () => {
    for (const value of [null, '', 1, {}, 'future-engine']) expect(() => mdbx2AccountBackend(account(value))).toThrow();
  });
});
