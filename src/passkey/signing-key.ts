import { parsePortablePasskeyPrivateKey, portablePasskeyKeyMatchesAlgorithm } from './private-key-portability';

/** Shared by capability inspection and the real signer; inspection never returns a key to UI. */
export async function importPasskeySigningKey(material: string, algorithm: number): Promise<CryptoKey> {
  const portable = parsePortablePasskeyPrivateKey(material);
  if (!portablePasskeyKeyMatchesAlgorithm(portable, algorithm)) throw new DOMException('Invalid Passkey private key', 'DataError');
  const parameters = algorithm === -7 ? { name: 'ECDSA', namedCurve: 'P-256' }
    : algorithm === -8 ? { name: 'Ed25519' }
      : { name: algorithm === -37 ? 'RSA-PSS' : 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  return crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(portable.pkcs8Base64), c => c.charCodeAt(0)), parameters, false, ['sign']);
}
