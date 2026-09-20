import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  BPS_SCALE,
  InvalidMoneyError,
  MAX_PRICE_CENTS,
  applyDiscount,
  formatCents,
  parseCents,
} from '../src/money.js';

describe('applyDiscount — percentage', () => {
  /**
   * Expected values were produced by running `apply_discount()` on PostgreSQL 16,
   * not by reasoning about the formula. The first version of the formula rounded the
   * discount amount and returned 7499 for 14999 at 50%; the correct answer is 7500.
   */
  it.each([
    [14_999, 5_000, 7_500, 'half-cent rounds up (7499.5 -> 7500)'],
    [10_000, 3_333, 6_667, 'repeating decimal'],
    [1_000, 10_000, 0, '100% discount'],
    [333, 5_000, 167, 'small amount, half-cent'],
    [1, 5_000, 1, 'one cent at 50%'],
    [999_999_999, 1, 999_899_999, 'large amount, 0.01%'],
    [12_345, 0, 12_345, '0% returns the base price'],
  ])('%i cents at %i bps = %i (%s)', (base, bps, expected) => {
    expect(applyDiscount(base, { type: 'percentage', valueBps: bps })).toBe(expected);
  });

  it('rejects out-of-range basis points', () => {
    expect(() => applyDiscount(100, { type: 'percentage', valueBps: BPS_SCALE + 1 })).toThrow(
      InvalidMoneyError,
    );
    expect(() => applyDiscount(100, { type: 'percentage', valueBps: -1 })).toThrow(InvalidMoneyError);
  });
});

describe('applyDiscount — fixed amount', () => {
  it.each([
    [10_000, 1_550, 8_450],
    [1_000, 5_000, 0],
    [1_000, 1_000, 0],
    [1_000, 0, 1_000],
  ])('%i - %i = %i', (base, value, expected) => {
    expect(applyDiscount(base, { type: 'fixed', valueCents: value })).toBe(expected);
  });

  it('clamps at zero rather than going negative', () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), fc.nat({ max: 5_000_000 }), (base, cut) => {
        expect(applyDiscount(base, { type: 'fixed', valueCents: cut })).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

describe('applyDiscount — invariants', () => {
  it('never exceeds the base price and never goes negative', () => {
    fc.assert(
      fc.property(fc.nat({ max: MAX_PRICE_CENTS }), fc.nat({ max: BPS_SCALE }), (base, bps) => {
        const result = applyDiscount(base, { type: 'percentage', valueBps: bps });
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(base);
        expect(Number.isSafeInteger(result)).toBe(true);
      }),
    );
  });

  it('is monotonic: a deeper discount never yields a higher price', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 10_000_000 }),
        fc.nat({ max: BPS_SCALE }),
        fc.nat({ max: BPS_SCALE }),
        (base, a, b) => {
          const [low, high] = a <= b ? [a, b] : [b, a];
          const priceLow = applyDiscount(base, { type: 'percentage', valueBps: low });
          const priceHigh = applyDiscount(base, { type: 'percentage', valueBps: high });
          expect(priceHigh).toBeLessThanOrEqual(priceLow);
        },
      ),
    );
  });

  it('rejects a base price beyond the safe-integer bound', () => {
    expect(() => applyDiscount(MAX_PRICE_CENTS + 1, { type: 'fixed', valueCents: 0 })).toThrow(
      InvalidMoneyError,
    );
  });
});

describe('formatCents / parseCents', () => {
  it.each([
    [14_999, '149.99'],
    [100, '1.00'],
    [5, '0.05'],
    [0, '0.00'],
  ])('%i <-> %s', (cents, text) => {
    expect(formatCents(cents)).toBe(text);
    expect(parseCents(text)).toBe(cents);
  });

  it('round-trips without loss', () => {
    fc.assert(
      fc.property(fc.nat({ max: 10_000_000_000 }), (cents) => {
        expect(parseCents(formatCents(cents))).toBe(cents);
      }),
    );
  });

  it.each(['abc', '12.345', '-5.00', '', '1,99'])('rejects invalid input: %s', (input) => {
    expect(() => parseCents(input)).toThrow(InvalidMoneyError);
  });
});
