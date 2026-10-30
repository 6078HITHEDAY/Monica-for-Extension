import { describe, expect, it } from 'vitest';
import { bitwardenSteamFixture, STEAM_ID, STEAM_SECRET, STEAM_REVISION } from '../../../tests/fixtures/bitwarden-steam';
import { BitwardenProvider } from './bitwarden-provider';

function server(fixture: Awaited<ReturnType<typeof bitwardenSteamFixture>>) {
  const calls: string[] = [];
  let fail = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url.pathname);
    expect(init?.method || 'GET').toBe('GET');
    if (url.pathname === '/api/accounts/revision-date') return Response.json(Date.parse(STEAM_REVISION));
    if (url.pathname === '/api/sync') return Response.json(fixture.payload);
    if (url.pathname === '/api/ciphers/steam-cipher/attachment/steam-attachment') return Response.json({ ...fixture.descriptor, Url: 'https://objects.example.test/steam' });
    if (url.pathname === '/steam') {
      if (fail) return new Response(null, { status: 403 });
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      return new Response(fixture.body.slice());
    }
    throw new Error(`Unexpected synthetic request: ${url.pathname}`);
  };
  return { provider: new BitwardenProvider(fetcher), calls, fail(value: boolean) { fail = value; } };
}

describe('Steam through real Bitwarden synchronization and attachment decryption', () => {
  it('does not include malformed decrypted attachment contents in warnings or diagnostics', async () => {
    const fixture = await bitwardenSteamFixture({ raw: 'private-small-secret' });
    const result = await server(fixture).provider.sync(fixture.account, { localItems: [], pendingMutations: [], now: STEAM_REVISION });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings.join(' ')).not.toContain('private-small-secret');
  });
  it.each([false, true])('loads an Android maFile without session tokens (legacy=%s)', async legacy => {
    const fixture = await bitwardenSteamFixture({ legacy });
    const { provider } = server(fixture);
    const result = await provider.sync(fixture.account, { localItems: [], pendingMutations: [], now: STEAM_REVISION });
    expect(result.warnings).toEqual([]);
    expect(result.items[0]).toMatchObject({ kind: 'login', steamId: STEAM_ID, steamSharedSecretBase64: STEAM_SECRET, categoryName: 'Games', steamRawJson: fixture.raw });
  });

  it('keeps numeric SteamID exact and ignores an unrelated URL', async () => {
    const raw = `{"account_name":"synthetic","steamid":${STEAM_ID},"url":"https://steamcommunity.com","shared_secret":"${STEAM_SECRET}"}`;
    const fixture = await bitwardenSteamFixture({ raw, legacy: true });
    const result = await server(fixture).provider.sync(fixture.account, { localItems: [], pendingMutations: [], now: STEAM_REVISION });
    expect(result.warnings).toEqual([]);
    expect(result.items[0]).toMatchObject({ steamId: STEAM_ID, steamSharedSecretBase64: STEAM_SECRET, steamRawJson: raw });
  });

  it('retries a failed attachment even when the remote revision did not change, then caches success', async () => {
    const fixture = await bitwardenSteamFixture({ legacy: true });
    const s = server(fixture); s.fail(true);
    const context = { pendingMutations: [], now: STEAM_REVISION, syncHint: { type: 'check-remote' as const } };
    const first = await s.provider.sync(fixture.account, { ...context, localItems: [] });
    expect(first.warnings).toHaveLength(1);
    s.fail(false);
    const second = await s.provider.sync(fixture.account, { ...context, localItems: first.items });
    expect(second.items[0]).toMatchObject({ steamSharedSecretBase64: STEAM_SECRET, steamId: STEAM_ID, id: first.items[0].id });
    const downloads = s.calls.filter(path => path === '/steam').length;
    const third = await s.provider.sync(fixture.account, { ...context, localItems: second.items });
    expect(third.unchanged).toBe(true);
    expect(s.calls.filter(path => path === '/steam')).toHaveLength(downloads);
  });

  it('loads a bounded attachment when sync metadata omits its size', async () => {
    const fixture = await bitwardenSteamFixture({ legacy: true, unknownSize: true });
    const result = await server(fixture).provider.sync(fixture.account, { localItems: [], pendingMutations: [], now: STEAM_REVISION });
    expect(result.warnings).toEqual([]);
    expect(result.items[0]).toMatchObject({ steamSharedSecretBase64: STEAM_SECRET });
  });
});
