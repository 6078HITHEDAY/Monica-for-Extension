import type { IdentityItem } from './model';

export const WALLET_TEMPLATES = ['MEMBERSHIP', 'REWARDS', 'TRAVEL'] as const;
export type WalletTemplate = typeof WALLET_TEMPLATES[number];
export const WALLET_TEMPLATE_LABELS: Record<string, string> = { MEMBERSHIP: '会员卡', REWARDS: '积分卡', TRAVEL: '旅行票证' };
export const WALLET_TEMPLATE_FIELDS: Record<string, string[]> = {
  MEMBERSHIP: ['tier', 'website'], REWARDS: ['tier', 'points', 'pointsExpiry', 'website'],
  TRAVEL: 'serviceNumber origin destination departure arrival terminal gate seat travelClass'.split(' ')
};
export const WALLET_PASS_FIELD_LABELS: Record<string, string> = {
  tier: '会员等级', website: '网站', points: '积分余额', pointsExpiry: '积分到期',
  serviceNumber: '航班或车次', origin: '出发地', destination: '目的地', departure: '出发时间', arrival: '到达时间',
  terminal: '航站楼或站台', gate: '登机口', seat: '座位', travelClass: '舱位或席别'
};
export function readWalletPassData(raw: Record<string, unknown>): Pick<IdentityItem, 'walletTemplate' | 'walletFields'> {
  const result: Pick<IdentityItem, 'walletTemplate' | 'walletFields'> = {};
  if (raw.walletTemplate !== undefined) {
    if (typeof raw.walletTemplate !== 'string') throw new Error('卡包模板格式不受支持，请保留原始数据。');
    result.walletTemplate = raw.walletTemplate;
  }
  if (raw.walletFields !== undefined) {
    if (!raw.walletFields || typeof raw.walletFields !== 'object' || Array.isArray(raw.walletFields)
      || Object.values(raw.walletFields).some(value => typeof value !== 'string')) throw new Error('卡包字段格式不受支持，请保留原始数据。');
    result.walletFields = Object.fromEntries(Object.entries(raw.walletFields));
  }
  return result;
}
export const isWalletPass = (item: Pick<IdentityItem, 'walletTemplate'>): boolean => Boolean(item.walletTemplate?.trim());
