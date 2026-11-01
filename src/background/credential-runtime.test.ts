import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCredentialRuntime } from './credential-runtime';
import type { LoginItem } from '../core/model';
import type { SavePromptContext } from '../runtime/messages';

const url = 'https://login.example.test/sign-in';
const firstDocument = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const nextDocument = '11111111-2222-3333-4444-555555555555';
const sender = (documentId = firstDocument, frameId = 2, tabId = 4): chrome.runtime.MessageSender => ({ id: 'synthetic', url, origin: new URL(url).origin,
  tab: { id: tabId, index: 0, pinned: false, highlighted: false, windowId: 1, active: true, incognito: false,
    selected: true, discarded: false, autoDiscardable: true, frozen: false, groupId: -1 },
  frameId, documentId, documentLifecycle: 'active' });
beforeEach(() => {
  vi.useFakeTimers(); const stored: Record<string, unknown> = {};
  vi.stubGlobal('chrome', { runtime: { id: 'synthetic' }, tabs: { sendMessage: vi.fn(async () => undefined) }, storage: { session: {
    get: vi.fn(async (key: string | null) => key === null ? { ...stored } : { [key]: stored[key] }),
    set: vi.fn(async (input: Record<string, unknown>) => Object.assign(stored, input)),
    remove: vi.fn(async (input: string | string[]) => { for (const key of typeof input === 'string' ? [input] : input) delete stored[key]; })
  } } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function fixture() {
  const service = { status: vi.fn(async () => 'unlocked'),
    readState: vi.fn(async () => ({ items: [], providers: [{ id: 'local', kind: 'local', name: 'Local', enabled: true }], settings: { defaultProviderId: 'local' } })),
    upsertItem: vi.fn(async (item: LoginItem) => item), getItem: vi.fn(), getProvider: vi.fn() };
  const runtime = createCredentialRuntime({ service, savePromptBlocked: async () => false, anyAutofillFieldSignatureBlocked: async () => false } as unknown as Parameters<typeof createCredentialRuntime>[0]);
  const capture = async (username = 'alice') => await runtime.handlers.CREDENTIAL_CAPTURE({ type: 'CREDENTIAL_CAPTURE', candidate: {
    username, password: 'fixture-password', pageUrl: url, pageTitle: 'Fixture', captureKind: 'login' } }, sender(), false) as SavePromptContext;
  return { runtime, service, capture };
}
describe('credential runtime with navigation and stepped username capture', () => {
  it('allows a top-frame prompt to confirm an iframe candidate after same-origin navigation', async () => {
    const f = fixture(); const pending = await f.capture();
    await f.runtime.handlers.CREDENTIAL_ACCEPT({ type: 'CREDENTIAL_ACCEPT', candidateId: pending.candidateId }, sender(nextDocument, 0), false);
    expect(f.service.upsertItem).toHaveBeenCalledWith(expect.objectContaining({ username: 'alice', password: 'fixture-password', uris: [new URL(url).origin] }));
  });
  it('rejects confirmation from a different tab without writing', async () => {
    const f = fixture(); const pending = await f.capture();
    await expect(f.runtime.handlers.CREDENTIAL_ACCEPT({ type: 'CREDENTIAL_ACCEPT', candidateId: pending.candidateId }, sender(nextDocument, 0, 9), false)).rejects.toThrow('保存候选已过期');
    expect(f.service.upsertItem).not.toHaveBeenCalled();
  });
  it.each([false, true])('uses a remembered username only on a subsequent document (navigation=%s)', async navigation => {
    const f = fixture();
    await f.runtime.handlers.CREDENTIAL_USERNAME_REMEMBER({ type: 'CREDENTIAL_USERNAME_REMEMBER', username: 'alice' }, sender(), false);
    const pending = await f.runtime.handlers.CREDENTIAL_CAPTURE({ type: 'CREDENTIAL_CAPTURE', candidate: {
      username: '', password: 'fixture-password', pageUrl: url, pageTitle: 'Fixture', captureKind: 'login' } }, sender(navigation ? nextDocument : firstDocument), false) as SavePromptContext;
    expect(pending.username).toBe(navigation ? 'alice' : '');
  });
  it('clears candidates on lock so they cannot later be accepted', async () => {
    const f = fixture(); const pending = await f.capture();
    f.runtime.clearCredentialCaptures(); await f.runtime.clearPendingUsernameContexts();
    await expect(f.runtime.handlers.CREDENTIAL_ACCEPT({ type: 'CREDENTIAL_ACCEPT', candidateId: pending.candidateId }, sender(), false)).rejects.toThrow();
    expect(f.service.upsertItem).not.toHaveBeenCalled();
  });
});
