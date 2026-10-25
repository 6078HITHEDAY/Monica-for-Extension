import { matchingLogins } from "../core/matching";
import type { LoginItem } from "../core/model";
import type { CredentialCaptureInput } from "../runtime/messages";

export function credentialSaveDecision(candidate: CredentialCaptureInput, logins: LoginItem[]): { unchanged: boolean; updateCandidates: LoginItem[] } {
  const matches = matchingLogins(logins, candidate.pageUrl);
  const username = normalizedCredentialUsername(candidate.username);
  const updateCandidates = username
    ? matches.filter(item => normalizedCredentialUsername(item.username) === username)
    : candidate.captureKind === "password-change" ? matches : matches.filter(item => !normalizedCredentialUsername(item.username));
  // Without an account name, a password shared by another account does not
  // establish which record a password-change form is updating.
  const identifiedAccount = Boolean(username) || updateCandidates.length === 1
    || updateCandidates.every(item => !normalizedCredentialUsername(item.username));
  return {
    unchanged: identifiedAccount && updateCandidates.some(item => item.password === candidate.password),
    updateCandidates
  };
}

export function normalizedCredentialUsername(username: string): string {
  return username.trim().toLocaleLowerCase();
}
