import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPasskeyJournal } from './passkey-journal';
import { PASSKEY_COMPLETION_PREFIX, PASSKEY_COMPLETION_TTL_MS, type PasskeyCompletionReceipt, type PendingPasskeyRequest } from './passkey-state-types';
import { VaultLockedError } from '../security/secure-vault-service';
import type { VaultItem } from '../core/model';

let stored: Record<string, unknown>;
const getItem = vi.fn<Parameters<typeof createPasskeyJournal>[0]['service']['getItem']>();
const cancel = vi.fn(async () => true);
const journal = () => createPasskeyJournal({ service: { getItem }, cancelPendingPasskeyRequest: cancel });
function receipt(operation: 'create' | 'get' = 'create'): PasskeyCompletionReceipt {
  return { id: 'candidate', tabId: 4, frameId: 0, documentId: 'first', origin: 'https://example.test', operation, itemId: 'item',
    result: operation === 'get' ? { operation, id: 'AQID', rawId: 'AQID', response: { clientDataJSON: '', authenticatorData: '', signature: '', userHandle: '' } }
      : { operation, id: 'AQID', rawId: 'AQID', response: { clientDataJSON: '', authenticatorData: '', attestationObject: '', publicKey: '', publicKeyAlgorithm: -7 }, clientExtensionResults: {} },
    status: 'prepared', expiresAt: Date.now() - 1 };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-01T00:00:00Z')); stored = {};
  getItem.mockReset(); cancel.mockClear();
  vi.stubGlobal('chrome', { storage: { session: {
    get: vi.fn(async (key: string | null) => key === null ? structuredClone(stored) : { [key]: structuredClone(stored[key]) }),
    set: vi.fn(async (values: Record<string, unknown>) => Object.assign(stored, structuredClone(values))),
    remove: vi.fn(async (keys: string | string[]) => { for (const key of typeof keys === 'string' ? [keys] : keys) delete stored[key]; })
  } } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Passkey journal across worker suspension and interrupted commits', () => {
  it('reloads pending document identity from storage in a fresh runtime', async () => {
    const pending: PendingPasskeyRequest = { id: 'candidate', request: { operation: 'get', challenge: 'AQID', allowCredentialIds: [] },
      tabId: 4, frameId: 0, documentId: 'first', origin: 'https://example.test', rpId: 'example.test', expiresAt: Date.now() + 10000, matches: [], saveTargets: [] };
    await journal().persistPendingPasskeyRequest(pending);
    expect(await journal().loadPendingPasskeyRequest('candidate')).toEqual(pending);
  });
  it('promotes an expired prepared registration only when the stable item was committed', async () => {
    const row = receipt(); stored[PASSKEY_COMPLETION_PREFIX + row.id] = row;
    getItem.mockResolvedValue({ id: 'item', kind: 'passkey', credentialId: 'AQID' } as VaultItem);
    expect(await journal().loadPasskeyCompletionReceipt(row.id)).toMatchObject({ status: 'committed', expiresAt: Date.now() + PASSKEY_COMPLETION_TTL_MS });
    expect(getItem).toHaveBeenCalledExactlyOnceWith('item');
  });
  it('retains an uncertain registration while locked, then reconciles after unlock', async () => {
    const row = receipt(); stored[PASSKEY_COMPLETION_PREFIX + row.id] = row;
    getItem.mockRejectedValueOnce(new VaultLockedError('locked'));
    expect(await journal().loadPasskeyCompletionReceipt(row.id)).toMatchObject({ status: 'prepared' });
    getItem.mockResolvedValue({ id: 'item', kind: 'passkey', credentialId: 'AQID' } as VaultItem);
    vi.advanceTimersByTime(PASSKEY_COMPLETION_TTL_MS + 1);
    expect(await journal().loadPasskeyCompletionReceipt(row.id)).toMatchObject({ status: 'committed' });
  });
  it.each(['missing', 'different credential', 'deleted'] as const)('does not replay a registration for a %s item', async mode => {
    const row = receipt(); stored[PASSKEY_COMPLETION_PREFIX + row.id] = row;
    getItem.mockResolvedValue(mode === 'missing' ? undefined : { id: 'item', kind: 'passkey', credentialId: mode === 'different credential' ? 'BAUG' : 'AQID', deletedAt: mode === 'deleted' ? 'now' : undefined } as VaultItem);
    expect(await journal().loadPasskeyCompletionReceipt(row.id)).toBeUndefined();
    expect(stored[PASSKEY_COMPLETION_PREFIX + row.id]).toBeUndefined();
  });
  it('never promotes an interrupted assertion using registration recovery', async () => {
    const row = receipt('get'); stored[PASSKEY_COMPLETION_PREFIX + row.id] = row;
    expect(await journal().loadPasskeyCompletionReceipt(row.id)).toBeUndefined();
    expect(getItem).not.toHaveBeenCalled();
  });
  it('keeps an in-memory committed receipt if session persistence fails', async () => {
    const row = { ...receipt(), expiresAt: Date.now() + 10000 }; const runtime = journal();
    await runtime.persistPasskeyCompletionReceipt(row);
    vi.mocked(chrome.storage.session.set).mockRejectedValueOnce(new Error('storage unavailable'));
    await runtime.promotePasskeyCompletionReceipt(row);
    expect(await runtime.loadPasskeyCompletionReceipt(row.id)).toMatchObject({ status: 'committed' });
  });
  it.each(['tabId', 'frameId', 'documentId', 'origin'] as const)('rejects a receipt whose %s differs from the requester', field => {
    const row = receipt(); const source = { tabId: row.tabId, frameId: row.frameId, documentId: row.documentId, origin: row.origin };
    expect(journal().passkeyReceiptMatchesSource(row, source)).toBe(true);
    expect(journal().passkeyReceiptMatchesSource(row, { ...source, [field]: typeof source[field] === 'number' ? 9 : 'changed' })).toBe(false);
  });
});
