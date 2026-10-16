/** Android 1.0.320 independent profile values. Never derive names or contacts. */
export const PROFILE_NAMES = ['firstName', 'middleName', 'lastName'] as const;
export const CARD_NAMES = ['cardholderFirstName', 'cardholderMiddleName', 'cardholderLastName'] as const;
export const PROFILE_CONTACTS = ['homeEmail', 'homePhone', 'workEmail', 'workPhone'] as const;
export const PROFILE_EXTRAS = ['district', ...PROFILE_CONTACTS] as const;
export const ADDRESS_EXTRAS = [...PROFILE_NAMES, 'addressLine3', ...PROFILE_EXTRAS] as const;
export function profileValues<K extends string>(source: object, keys: readonly K[]): Record<K, string> {
  const record = source as Record<string, unknown>;
  return Object.fromEntries(keys.map(key => [key, typeof record[key] === 'string' ? record[key] : ''])) as Record<K, string>;
}
export const PROFILE_LABELS = {
  firstName: '名', middleName: '中间名', lastName: '姓',
  cardholderFirstName: '持卡人名', cardholderMiddleName: '持卡人中间名', cardholderLastName: '持卡人姓',
  addressLine3: '地址第三行', district: '区/县',
  homeEmail: '家庭邮箱', homePhone: '家庭电话', workEmail: '工作邮箱', workPhone: '工作电话'
} as const;
