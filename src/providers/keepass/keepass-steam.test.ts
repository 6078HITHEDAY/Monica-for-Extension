import { describe, expect, it } from 'vitest';
import { buildKeePassFixture } from './keepass-fixture';
import { openKeePassVault } from './keepass-vault';
import { projectSteamItem } from '../../core/steam-item';
import { generateOtpWithParameters } from '../../core/totp';
import { parametersFromItem } from '../../core/login-otp';
import type { LoginItem } from '../../core/model';
import * as kdbxweb from 'kdbxweb';

const rawMaFile = JSON.stringify({ account_name: 'synthetic', steamid: '76561198000000000', shared_secret: 'QUJDREVGR0hJSktMTU5PUFFSU1Q=' });
const binaryBytes = (entry: kdbxweb.KdbxEntry, name: string) => {
  const binary = entry.binaries.get(name)!;
  const value = kdbxweb.KdbxBinaries.isKdbxBinaryWithHash(binary) ? binary.value : binary;
  return value instanceof kdbxweb.ProtectedValue ? value.getBinary() : new Uint8Array(value);
};

describe('Android Steam entry discovery in KeePass', () => {
  it.each([3, 4] as const)('loads a marked KDBX%s maFile attachment while retaining its canonical login and attachment', async version => {
    const raw = JSON.stringify({ account_name: 'synthetic', steamid: '76561198000000000', shared_secret: 'QUJDREVGR0hJSktMTU5PUFFSU1Q=', identity_secret: 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=' });
    const bytes = await buildKeePassFixture({ version, entries: [{ title: 'Steam maFile', fields: {
      UserName: 'synthetic', URL: 'https://steamcommunity.com', 'Monica.Type': 'steam_mafile_v1',
      MonicaLoginType: 'STEAM_MAFILE', Notes: 'keep this note',
    }, binaries: { 'synthetic.maFile': new TextEncoder().encode(raw) } }] });
    const snapshot = await openKeePassVault(bytes, { password: 'fixture master password', databaseId: 7, providerId: 'kp' });
    expect(snapshot.items).toHaveLength(1);
    const login = snapshot.items[0] as LoginItem;
    expect(login.kind).toBe('login');
    const steam = projectSteamItem(login);
    expect(steam, 'Marked Android maFile login must appear in the Steam section').toBeDefined();
    expect(steam?.steamSharedSecretBase64).toBe('QUJDREVGR0hJSktMTU5PUFFSU1Q=');
    expect(steam?.notes).toBe('keep this note');
    expect(snapshot.entriesByUuid.get(login.keepassEntryUuid!)?.binaries.has('synthetic.maFile')).toBe(true);
    expect(new TextDecoder().decode(binaryBytes(snapshot.entriesByUuid.get(login.keepassEntryUuid!)!, 'synthetic.maFile'))).toBe(raw);
    expect(await generateOtpWithParameters(parametersFromItem(steam!), 1_700_000_000_000)).toMatch(/^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
  });

  it('does not inspect unmarked entries or silently select among different valid account attachments', async () => {
    const bytes = await buildKeePassFixture({ entries: [
      { title: 'Ordinary attachment', fields: { UserName: 'synthetic' }, binaries: { 'synthetic.maFile': new TextEncoder().encode(rawMaFile) } },
      { title: 'Ambiguous Steam', fields: { UserName: 'synthetic', 'Monica.Type': 'steam_mafile_v1' }, binaries: {
        'one.maFile': new TextEncoder().encode(rawMaFile),
        'two.maFile': new TextEncoder().encode(rawMaFile.replace('synthetic', 'another-account')),
      } },
      { title: 'Broken Steam', fields: { UserName: 'synthetic', 'Monica.Type': 'steam_mafile_v1' }, binaries: {
        'broken.maFile': new TextEncoder().encode('not JSON'), 'too-large.maFile': new Uint8Array(1024 * 1024 + 1),
      } },
    ] });
    const snapshot = await openKeePassVault(bytes, { password: 'fixture master password', databaseId: 7, providerId: 'kp' });
    expect(snapshot.items).toHaveLength(3);
    expect(projectSteamItem(snapshot.items.find(item => item.title === 'Ordinary attachment') as LoginItem)).toBeUndefined();
    for (const title of ['Ambiguous Steam', 'Broken Steam']) {
      const item = snapshot.items.find(item => item.title === title) as LoginItem;
      expect(projectSteamItem(item)).toMatchObject({ kind: 'totp', otpType: 'STEAM', secret: '' });
      expect(item.steamSharedSecretBase64).toBeUndefined();
    }
    const broken = snapshot.items.find(item => item.title === 'Broken Steam')!;
    expect(new TextDecoder().decode(binaryBytes(snapshot.entriesByUuid.get(broken.keepassEntryUuid!)!, 'broken.maFile'))).toBe('not JSON');
  });
});
