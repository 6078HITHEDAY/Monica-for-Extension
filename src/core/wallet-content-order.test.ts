import { expect, it } from 'vitest';
import { moveWalletContent, resolveWalletContentOrder, preserveLocalWalletContentOrder, walletContentOrderOnlyChanged } from './wallet-content-order';
import type { CardItem } from './model';
const card: CardItem = { kind: 'card', id: 'card', title: 'Fixture', favorite: false, notes: '', createdAt: '2026-10-09', updatedAt: '2026-10-09', providerRefs: [],
  cardholderName: 'Fixture', number: '4111111111111111', expiryMonth: '12', expiryYear: '2030', securityCode: '123' };
it('resolves Android order without hiding new sections or displaying duplicates', () => {
  expect(resolveWalletContentOrder(['custom', 'future', 'custom'], ['billing', 'custom', 'notes'])).toEqual(['custom', 'billing', 'notes']);
});
it('moves visible sections while retaining unavailable photos and exact future tokens', () => {
  const saved = ['photos', 'custom', 'future', 'future', 'billing'];
  expect(moveWalletContent(saved, ['billing', 'custom', 'notes'], 'billing', -1)).toEqual(['billing', 'custom', 'notes', 'photos', 'future', 'future']);
  expect(saved).toEqual(['photos', 'custom', 'future', 'future', 'billing']);
  expect(moveWalletContent(undefined, ['custom'], 'custom', -1)).toBeUndefined();
});
it('retains local layout only when a matched wallet has no remote layout', () => {
  const local = { ...card, editorSectionOrder: ['custom'] };
  expect(preserveLocalWalletContentOrder(local, { ...card, title: 'Remote' })).toMatchObject({ title: 'Remote', editorSectionOrder: ['custom'] });
  expect(preserveLocalWalletContentOrder(local, { ...card, editorSectionOrder: [] })).toMatchObject({ editorSectionOrder: [] });
});
it('distinguishes layout-only saves from secret or routing changes', () => {
  const next = { ...card, editorSectionOrder: ['notes'], updatedAt: '2026-10-10' };
  expect(walletContentOrderOnlyChanged(card, next)).toBe(true);
  expect(walletContentOrderOnlyChanged(card, { ...next, securityCode: '456' })).toBe(false);
  expect(walletContentOrderOnlyChanged(card, { ...next, providerRefs: [{ providerId: 'other' }] })).toBe(false);
});
