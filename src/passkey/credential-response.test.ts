import { afterEach, expect, it, vi } from 'vitest';
import { publicKeyCredential } from './credential-response';

afterEach(() => vi.unstubAllGlobals());

it.each(['get', 'create'] as const)('supports the webauthn-json serializer used by GitHub for %s', operation => {
  vi.stubGlobal('window', { PublicKeyCredential: class {}, AuthenticatorAssertionResponse: class {}, AuthenticatorAttestationResponse: class {} });
  const credential = publicKeyCredential({ operation, id: 'AQID', rawId: 'AQID', response: {
    clientDataJSON: 'e30', authenticatorData: 'AQID', signature: 'BAUG', userHandle: 'dXNlcg', attestationObject: 'AQID', publicKey: 'AQID', publicKeyAlgorithm: -7
  } }) as PublicKeyCredential;
  // @github/webauthn-json's get/create functions assign toJSON in strict mode.
  // Checking only Monica's own toJSON skipped this website boundary.
  const serialize = () => ({ id: credential.id, rawId: Buffer.from(credential.rawId).toString('base64url'),
    clientExtensionResults: credential.getClientExtensionResults() });
  expect(() => { credential.toJSON = serialize as typeof credential.toJSON; }).not.toThrow();
  expect(JSON.parse(JSON.stringify(credential))).toEqual({ id: 'AQID', rawId: 'AQID', clientExtensionResults: {} });
  expect(credential.response.clientDataJSON.byteLength).toBe(2);
});
