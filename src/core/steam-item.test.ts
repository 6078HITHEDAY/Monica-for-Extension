import { describe, expect, it } from "vitest";
import { projectSteamItem } from "./steam-item";
import { parametersFromItem } from './login-otp';
import { generateOtpWithParameters } from './totp';
import { generateSteamCode } from './steam-totp';
import type { LoginItem, TotpItem } from './model';

describe("Steam Bitwarden projection", () => {
  it('keeps Steam Base64 login URIs usable after projection to a tile', async () => {
    const item = { kind: 'login', id: 'steam', title: 'Steam', totpSecret: 'steam://QUJDREVGR0hJSktMTU5PUFFSU1Q=', customFields: [] } as unknown as LoginItem;
    const projected = projectSteamItem(item)!;
    expect(await generateOtpWithParameters(parametersFromItem(projected), 1_700_000_000_000))
      .toBe(await generateSteamCode('QUJDREVGR0hJSktMTU5PUFFSU1Q=', 1_700_000_000_000));
  });

  it('discovers KeePass encoder=steam login URIs without changing the stored login', () => {
    const item = { kind: 'login', id: 'steam', title: 'Steam', username: 'synthetic', totpSecret: 'otpauth://totp/Steam:synthetic?secret=IFBEGRCFIZDUQSKKJNGE2TSPKBIVEU2U&encoder=steam', customFields: [] } as unknown as LoginItem;
    expect(projectSteamItem(item)).toMatchObject({ id: 'steam', kind: 'totp', otpType: 'STEAM' });
    expect(item.kind).toBe('login');
  });

  it('supports raw Base64 and legacy Base32 Steam entries without a duplicated shared-secret field', async () => {
    for (const secret of ['QUJDREVGR0hJSktMTU5PUFFSU1Q=', 'IFBEGRCFIZDUQSKKJNGE2TSPKBIVEU2U']) {
      const item = { kind: 'totp', secret, otpType: 'STEAM', algorithm: 'SHA1', digits: 5, period: 30 } as TotpItem;
      expect(await generateOtpWithParameters(parametersFromItem(item), 1_700_000_000_000))
        .toBe(await generateSteamCode('QUJDREVGR0hJSktMTU5PUFFSU1Q=', 1_700_000_000_000));
    }
  });

  it("projects an Android-compatible steam:// login without changing its id", () => {
    const item = {
      id: "bitwarden:provider:cipher",
      kind: "login" as const,
      title: "Steam",
      username: "joy",
      password: "",
      uris: [],
      totpSecret: "steam://QUJDREVGR0hJSktMTU5PUFFSU1Q=",
      customFields: [],
      favorite: false,
      notes: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      providerRefs: [{ providerId: "provider", remoteId: "cipher" }]
    };
    const projected = projectSteamItem(item);
    expect(projected?.kind).toBe("totp");
    expect(projected?.otpType).toBe("STEAM");
    expect(projected?.digits).toBe(5);
    expect(projected?.period).toBe(30);
    expect(projected?.secret).toBe("QUJDREVGR0hJSktMTU5PUFFSU1Q=");
    expect(projected?.id).toBe(item.id);
  });

  it("ignores ordinary Bitwarden login TOTP values", () => {
    const item = { kind: "login", totpSecret: "JBSWY3DPEHPK3PXP" } as never;
    expect(projectSteamItem(item)).toBeUndefined();
  });
});
