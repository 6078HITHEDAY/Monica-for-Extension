import type { PasskeyItem } from '../../core/model';
import { parsePortablePasskeyPrivateKey } from '../../passkey/private-key-portability';

/** A local proof only: random non-WebAuthn input, no counter reservation or RP
 * assertion, and no extractable private CryptoKey/JWK. Never return key data. */
export async function assertBitwardenPasskeyPublicKey(publicKey: string, projected: PasskeyItem): Promise<void> {
  let spki: Uint8Array<ArrayBuffer> | undefined, pkcs8: Uint8Array<ArrayBuffer> | undefined, signature: Uint8Array<ArrayBuffer> | undefined;
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  try {
    const portable = parsePortablePasskeyPrivateKey(projected.privateKeyPkcs8);
    if (projected.algorithm !== -7 || portable?.algorithm !== -7) throw new Error();
    pkcs8 = Uint8Array.from(atob(portable.pkcs8Base64), c => c.charCodeAt(0));
    const parameters = { name: 'ECDSA', namedCurve: 'P-256' };
    const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, parameters, false, ['sign']);
    signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, challenge));
    if (publicKey) {
      spki = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const verificationKey = await crypto.subtle.importKey('spki', spki, parameters, false, ['verify']);
      if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verificationKey, signature, challenge)) throw new Error();
    }
  } catch {
    throw new Error('Bitwarden 无法确认 publicKey 与原私钥匹配，已保留来源。');
  } finally { spki?.fill(0); pkcs8?.fill(0); signature?.fill(0); challenge.fill(0); }
}
