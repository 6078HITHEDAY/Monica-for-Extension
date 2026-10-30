import { describe, expect, it } from "vitest";
import type { LoginItem } from "../core/model";
import type { CredentialCaptureInput } from "../runtime/messages";
import { credentialSaveDecision } from "./credential-save-decision";

const login: LoginItem = {
  id: "saved", kind: "login", title: "Saved account", username: "joy@example.test", password: " Secret ",
  uris: ["https://login.example.test"], notes: "", favorite: false, providerRefs: [], customFields: [],
  createdAt: "2026-10-25T00:00:00Z", updatedAt: "2026-10-25T00:00:00Z"
};
const candidate: CredentialCaptureInput = {
  username: login.username, password: login.password, pageUrl: "https://login.example.test/signin", pageTitle: "Sign in", captureKind: "login"
};

describe("credential save decision", () => {
  it("suppresses an exact existing credential with the same account normalization used for updates", () => {
    expect(credentialSaveDecision({ ...candidate, username: " JOY@example.test " }, [login])).toMatchObject({ unchanged: true, updateCandidates: [login] });
  });

  it.each(["Secret ", " Secret", " secret ", " Replacement "])("keeps the update prompt for the distinct password %j", password => {
    expect(credentialSaveDecision({ ...candidate, password }, [login])).toMatchObject({ unchanged: false, updateCandidates: [login] });
  });

  it("recognizes an unchanged member among same-username records without requiring all copies to agree", () => {
    const other = { ...login, id: "another-copy", password: "old-copy" };
    expect(credentialSaveDecision(candidate, [other, login]).unchanged).toBe(true);
    expect(credentialSaveDecision({ ...candidate, password: "new" }, [other, login])).toMatchObject({ unchanged: false, updateCandidates: [other, login] });
  });

  it("does not suppress saving another account that happens to reuse the same password", () => {
    expect(credentialSaveDecision({ ...candidate, username: "other@example.test" }, [login])).toEqual({ unchanged: false, updateCandidates: [] });
  });

  it.each([
    { uris: ["https://unrelated.example.net"] },
    { deletedAt: "2026-10-25T00:00:00Z" },
    { archivedAt: "2026-10-25T00:00:00Z" },
    { uriRules: [{ uri: "https://login.example.test", matchType: "never" as const }] }
  ])("does not use an ineligible record to silence saving: %j", override => {
    expect(credentialSaveDecision(candidate, [{ ...login, ...override }])).toEqual({ unchanged: false, updateCandidates: [] });
  });

  it("handles username-less saved logins without borrowing a named account", () => {
    const unnamed = { ...login, id: "unnamed", username: "" };
    expect(credentialSaveDecision({ ...candidate, username: "" }, [login, unnamed])).toEqual({ unchanged: true, updateCandidates: [unnamed] });
    expect(credentialSaveDecision({ ...candidate, username: "" }, [login])).toEqual({ unchanged: false, updateCandidates: [] });
  });

  it("recognizes unchanged password-change forms only when the account is identified", () => {
    const change = { ...candidate, username: "", captureKind: "password-change" as const };
    expect(credentialSaveDecision(change, [login]).unchanged).toBe(true);
    const other = { ...login, id: "another-account", username: "other@example.test", password: "other" };
    expect(credentialSaveDecision(change, [login, other])).toEqual({ unchanged: false, updateCandidates: [login, other] });
  });
});
