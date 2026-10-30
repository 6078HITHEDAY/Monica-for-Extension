import type { ProviderAccount } from '../../core/model';
import { mdbx2RoutingError, type Mdbx2Backend, type Mdbx2HandleRole } from './backend-origin-store';

export function mdbx2AccountBackend(account: ProviderAccount): Mdbx2Backend {
  const value = account.config.runtimeBackend;
  if (value === undefined) return 'native';
  if (value !== 'native' && value !== 'browser') throw mdbx2RoutingError('mdbx-account-backend-invalid');
  return value;
}

/** Synchronous projection of an already authenticated snapshot. Never reads
 * storage or reenters the vault's exclusive transaction from a native callback. */
export function mdbx2AccountHandleBackend(accounts: readonly ProviderAccount[], handle: string, role: Mdbx2HandleRole): Mdbx2Backend | undefined {
  if (role !== 'vault' && role !== 'state') return undefined;
  const field = role === 'vault' ? 'vaultHandle' : 'syncStateHandle';
  let backend: Mdbx2Backend | undefined;
  for (const account of accounts) {
    if (account.kind !== 'mdbx2' || account.config[field] !== handle) continue;
    const next = mdbx2AccountBackend(account);
    if (backend && backend !== next) throw mdbx2RoutingError();
    backend = next;
  }
  return backend;
}
