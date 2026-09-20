import { describe, expect, it } from 'vitest';
import type { PromotionCandidate } from '../src/promotion.js';
import {
  calculateEffectivePrice,
  isActiveAt,
  rangesOverlap,
  resolveActivePromotion,
} from '../src/promotion.js';

const T = (iso: string): Date => new Date(iso);
const NOW = T('2026-06-15T12:00:00Z');

function promo(over: Partial<PromotionCandidate> & { id: string }): PromotionCandidate {
  return {
    discountType: 'percentage',
    discountValue: 1_000,
    startsAt: T('2026-06-01T00:00:00Z'),
    endsAt: T('2026-07-01T00:00:00Z'),
    targetType: 'category',
    ...over,
  };
}

describe('isActiveAt — the [startsAt, endsAt) window', () => {
  const p = promo({ id: 'a' });
  it('includes the start instant', () => {
    expect(isActiveAt(p, T('2026-06-01T00:00:00Z'))).toBe(true);
  });
  it('excludes the end instant, matching the DB tstzrange "[)"', () => {
    expect(isActiveAt(p, T('2026-07-01T00:00:00Z'))).toBe(false);
    expect(isActiveAt(p, T('2026-06-30T23:59:59Z'))).toBe(true);
  });
  it('is inactive before it starts', () => {
    expect(isActiveAt(p, T('2026-05-31T23:59:59Z'))).toBe(false);
  });
});

describe('resolveActivePromotion — precedence', () => {
  it('returns null when nothing is active', () => {
    expect(resolveActivePromotion([], NOW)).toBeNull();
    expect(
      resolveActivePromotion([promo({ id: 'expired', endsAt: T('2026-06-01T00:00:00Z') })], NOW),
    ).toBeNull();
  });

  it('rule 1 — a product promotion beats a category one, even a much newer one', () => {
    const category = promo({
      id: 'category-flash',
      targetType: 'category',
      startsAt: T('2026-06-14T00:00:00Z'), // far newer
      discountValue: 5_000, // and far deeper
    });
    const product = promo({
      id: 'product-specific',
      targetType: 'product',
      startsAt: T('2026-06-02T00:00:00Z'),
      discountValue: 1_000,
    });
    expect(resolveActivePromotion([category, product], NOW)?.id).toBe('product-specific');
  });

  it('rule 2 — at the same level the later startsAt wins', () => {
    const older = promo({ id: 'older', startsAt: T('2026-06-01T00:00:00Z') });
    const newer = promo({ id: 'newer', startsAt: T('2026-06-10T00:00:00Z') });
    expect(resolveActivePromotion([older, newer], NOW)?.id).toBe('newer');
    expect(resolveActivePromotion([newer, older], NOW)?.id).toBe('newer');
  });

  it('rule 3 — equal startsAt falls back to id ASC for a stable result', () => {
    const a = promo({ id: 'aaa' });
    const b = promo({ id: 'bbb' });
    expect(resolveActivePromotion([a, b], NOW)?.id).toBe('aaa');
    expect(resolveActivePromotion([b, a], NOW)?.id).toBe('aaa');
  });

  it('is independent of input order (required for stable pagination)', () => {
    const set = [
      promo({ id: 'c1', targetType: 'category', startsAt: T('2026-06-05T00:00:00Z') }),
      promo({ id: 'p1', targetType: 'product', startsAt: T('2026-06-03T00:00:00Z') }),
      promo({ id: 'p2', targetType: 'product', startsAt: T('2026-06-09T00:00:00Z') }),
      promo({ id: 'c2', targetType: 'category', startsAt: T('2026-06-11T00:00:00Z') }),
    ];
    for (const permutation of [set, [...set].reverse(), [set[1]!, set[3]!, set[0]!, set[2]!]]) {
      expect(resolveActivePromotion(permutation, NOW)?.id).toBe('p2');
    }
  });

  it('an expired product promotion does not shadow an active category one', () => {
    const expiredProduct = promo({
      id: 'product-expired',
      targetType: 'product',
      endsAt: T('2026-06-10T00:00:00Z'),
    });
    const activeCategory = promo({ id: 'category-active', targetType: 'category' });
    expect(resolveActivePromotion([expiredProduct, activeCategory], NOW)?.id).toBe(
      'category-active',
    );
  });
});

describe('calculateEffectivePrice', () => {
  it('passes the base price through when nothing is active', () => {
    expect(calculateEffectivePrice(14_999, [], NOW)).toEqual({
      effectivePriceCents: 14_999,
      activePromotionId: null,
    });
  });

  it('applies the winning percentage promotion and reports its id', () => {
    const result = calculateEffectivePrice(
      14_999,
      [promo({ id: 'flash', discountType: 'percentage', discountValue: 5_000 })],
      NOW,
    );
    expect(result).toEqual({ effectivePriceCents: 7_500, activePromotionId: 'flash' });
  });

  it('applies a fixed-amount promotion', () => {
    const result = calculateEffectivePrice(
      10_000,
      [promo({ id: 'f', discountType: 'fixed', discountValue: 1_550 })],
      NOW,
    );
    expect(result).toEqual({ effectivePriceCents: 8_450, activePromotionId: 'f' });
  });
});

describe('rangesOverlap — the counterpart of the DB "&&" operator', () => {
  it.each([
    ['2026-01-01', '2026-02-01', '2026-01-15', '2026-03-01', true, 'partial overlap'],
    ['2026-01-01', '2026-02-01', '2026-02-01', '2026-03-01', false, 'abutting — no overlap'],
    ['2026-01-01', '2026-03-01', '2026-01-10', '2026-02-01', true, 'containment'],
    ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', false, 'disjoint'],
  ])('%s..%s vs %s..%s -> %s (%s)', (aS, aE, bS, bE, expected) => {
    expect(rangesOverlap(T(aS), T(aE), T(bS), T(bE))).toBe(expected);
  });
});
