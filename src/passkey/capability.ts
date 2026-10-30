import type { PasskeyItem, ProviderAccount } from '../core/model';
import { importPasskeySigningKey } from './signing-key';
import { supportsPasskeySigningAlgorithm, normalizeRpId } from './webauthn-core';
import { assertPasskeyCounterNotRegressed, resolvePasskeyOwnership } from './ownership-policy';
import { createSHA256 } from 'hash-wasm';

export type KeyCapability = 'usable' | 'missing' | 'device-reference' | 'invalid' | 'unsupported' | 'unknown' | 'checking';
export type CapabilityReason = 'metadata' | 'missing' | 'device-reference' | 'invalid' | 'unsupported' | 'unknown' | 'checking'
  | 'invalid-flags' | 'invalid-identity' | 'counter-invalid' | 'source-invalid' | 'source-disabled'
  | 'backup-restricted' | 'counter-history' | 'algorithm-restricted';
export interface PasskeyCapability {
  browser: 'available' | 'unavailable' | 'unknown' | 'checking';
  transfer: 'portable' | 'restricted' | 'original-device' | 'unknown';
  reasons: CapabilityReason[];
  localStorageOnly: boolean;
}

export async function inspectPasskeyKey(material: string | undefined, algorithm: number): Promise<KeyCapability> {
  if (!material?.trim()) return 'missing';
  if (material.trim().startsWith('monica-passkey-key-ref-v1:')) return 'device-reference';
  if (!supportsPasskeySigningAlgorithm(algorithm)) return 'unsupported';
  try { await importPasskeySigningKey(material, algorithm); return 'usable'; }
  catch (error) {
    const name = (error as Error)?.name;
    return name === 'NotSupportedError' ? 'unsupported' : ['DataError', 'SyntaxError', 'InvalidAccessError'].includes(name) ? 'invalid' : 'unknown';
  }
}

/** Bounded, session-only cache. No CryptoKey is retained, and unrelated edits reuse inspection. */
export function createPasskeyKeyInspector(inspect = inspectPasskeyKey, capacity = 512, now = Date.now) {
  type Input = Pick<PasskeyItem, 'id' | 'privateKeyPkcs8' | 'algorithm'>;
  type Entry = { fingerprint: string; result?: KeyCapability; pending?: Promise<KeyCapability>; expires: number };
  const entries = new Map<string, Entry>();
  let digest: Awaited<ReturnType<typeof createSHA256>> | undefined;
  let generation = 0;
  const ready = createSHA256().then(value => { digest = value; });
  const fingerprint = (item: Input) => digest!.init().update(`${item.algorithm}:${item.privateKeyPkcs8 ?? ''}`).digest('hex');
  return {
    // Synchronous lookup prevents a known badge disappearing during Vue remount.
    // Only a digest, enum and expiry survive inspection, never private-key bytes.
    peek(item: Input): KeyCapability | undefined {
      if (!digest) return undefined;
      const old = entries.get(item.id);
      return old?.fingerprint === fingerprint(item) ? old.result : undefined;
    },
    async inspect(item: Input): Promise<KeyCapability> {
      const started = generation;
      await ready;
      if (started !== generation) return 'unknown';
      const hash = fingerprint(item);
      const old = entries.get(item.id);
      if (old?.fingerprint === hash) {
        entries.delete(item.id); entries.set(item.id, old);
        if (old.pending) return old.pending;
        if (old.result && old.expires > now()) return old.result;
      }
      const entry: Entry = { fingerprint: hash, expires: 0, result: old?.fingerprint === hash ? old.result : undefined };
      entries.delete(item.id);
      entries.set(item.id, entry);
      if (entries.size > capacity) entries.delete(entries.keys().next().value!);
      entry.pending = inspect(item.privateKeyPkcs8, item.algorithm).catch(() => 'unknown' as const).then(result => {
        if (generation === started && entries.get(item.id) === entry) {
          entry.result = result; entry.pending = undefined;
          entry.expires = now() + (result === 'unknown' ? 5_000 : 300_000);
        }
        return result;
      });
      return entry.pending;
    },
    clear() { generation++; entries.clear(); }
  };
}

/** Storage location and transfer ability are separate; local PKCS8 keys remain exportable. */
export function passkeyCapability(item: PasskeyItem, key: KeyCapability, providers: ProviderAccount[]): PasskeyCapability {
  if (key === 'missing' && item.keyMaterialHint === 'device-reference') key = 'device-reference';
  const reasons: CapabilityReason[] = [];
  let browser: PasskeyCapability['browser'] = 'available';
  let localStorageOnly = false;
  if (key !== 'usable') { reasons.push(key); browser = key === 'unknown' || key === 'checking' ? key : 'unavailable'; }
  if (item.sourceMode === 'android-metadata-only') { reasons.push('metadata'); browser = 'unavailable'; }
  if (!item.credentialId.trim() || !normalizeRpId(item.rpId)) { reasons.push('invalid-identity'); browser = 'unavailable'; }
  if (item.backupEligible === false && item.backupState === true) { reasons.push('invalid-flags'); browser = 'unavailable'; }
  try { assertPasskeyCounterNotRegressed(item); }
  catch { reasons.push('counter-invalid'); browser = 'unavailable'; }
  try {
    const ownership = resolvePasskeyOwnership(item, providers);
    localStorageOnly = ownership.kind === 'local';
    if (ownership.kind !== 'local' && item.signCount > 0 && !ownership.account.enabled) {
      reasons.push('source-disabled'); browser = 'unavailable';
    }
  } catch { reasons.push('source-invalid'); browser = 'unavailable'; }
  if (item.backupEligible === false) reasons.push('backup-restricted');
  if (Math.max(item.signCount, item.signCountHighWaterMark ?? 0) > 0) reasons.push('counter-history');
  if (item.algorithm !== -7 && supportsPasskeySigningAlgorithm(item.algorithm)) reasons.push('algorithm-restricted');
  const transfer = key === 'device-reference' ? 'original-device' : key !== 'usable' || browser !== 'available' ? 'unknown'
    : reasons.length ? 'restricted' : 'portable';
  return {browser,transfer,reasons,localStorageOnly};
}

export function capabilityLabel(status: PasskeyCapability): string {
  return status.browser === 'unavailable' ? '浏览器不可用' : status.browser === 'unknown' ? '状态待确认'
    : status.browser === 'checking' ? '正在检查' : status.transfer === 'restricted' ? '跨端受限' : '可跨端保存';
}

export const capabilityReasonText: Record<CapabilityReason, string> = {
  checking: '正在本机检查密钥，检查结果不会修改凭据。',
  unknown: '暂时无法确认密钥能力，请重新解锁密码库后重试。',
  metadata: '此记录仅含 Android 元数据，浏览器无法用它登录。请在原设备检查密钥，或在网站重新创建 Passkey。',
  missing: '没有可用私钥。请从包含私钥的加密备份恢复，或在网站重新创建 Passkey。',
  'device-reference': '仅原设备密钥：这里保存的是设备密钥引用，浏览器无法读取。请从原设备导出包含私钥的加密备份；无法导出时需在网站重新注册。',
  invalid: '私钥损坏或与所标算法不匹配，浏览器无法签名。原始数据已保留，请从可信备份恢复。',
  unsupported: '当前浏览器不支持此密钥的签名算法，原始数据已保留。',
  'invalid-flags': '备份标志互相冲突，已停止签名；请从可信来源恢复。',
  'invalid-identity': '凭据 ID 或网站信息不完整，无法用于浏览器登录。',
  'counter-invalid': '签名计数无效或低于本机已知历史，已停止登录以避免计数回退。',
  'source-invalid': '密码源绑定失效或存在多个绑定，请重新连接正确的密码源。',
  'source-disabled': '此凭据需要更新签名计数，但密码源已停用；请启用并同步后重试。',
  'backup-restricted': '注册时标记为不可备份。复制私钥也不能改变此属性；跨设备使用可能被网站拒绝。',
  'counter-history': '已有非零签名计数历史。Android 使用零计数，严格检查计数的网站可能拒绝跨端登录。',
  'algorithm-restricted': '浏览器可签名，但当前 Bitwarden Passkey 写入仅支持 ES256；Android 的跨端兼容策略也将此算法标为受限。'
};
