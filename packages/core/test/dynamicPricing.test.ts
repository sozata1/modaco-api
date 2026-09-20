import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { VendorRow } from '../src/dynamicPricing.js';
import {
  DEFAULT_PRICING_POLICY,
  applyDynamicPricing,
  validateVendorRow,
} from '../src/dynamicPricing.js';

const row = (over: Partial<VendorRow> = {}): VendorRow => ({
  sku: 'ACC-001',
  name: 'Leather Belt',
  category: 'Accessories',
  vendorPriceCents: 10_000,
  stockQuantity: 25,
  ...over,
});

describe('validateVendorRow', () => {
  it('accepts a well-formed row', () => {
    expect(validateVendorRow(row())).toBeNull();
  });

  it.each([
    [{ sku: '' }, 'empty SKU'],
    [{ sku: 'a b' }, 'SKU with whitespace'],
    [{ name: '   ' }, 'blank name'],
    [{ category: '' }, 'empty category'],
    [{ vendorPriceCents: 0 }, 'zero price'],
    [{ vendorPriceCents: -1 }, 'negative price'],
    [{ vendorPriceCents: 10.5 }, 'fractional cents'],
    [{ stockQuantity: -1 }, 'negative stock'],
  ])('rejects %o (%s)', (over) => {
    expect(validateVendorRow(row(over))).not.toBeNull();
  });
});

describe('applyDynamicPricing', () => {
  it('applies the category margin and charm-rounds', () => {
    // Accessories margin is 6000 bps -> 10000 * 1.6 = 16000 -> charm -> 16099
    expect(applyDynamicPricing(row(), DEFAULT_PRICING_POLICY)).toEqual({
      ok: true,
      basePriceCents: 16_099,
    });
  });

  it('falls back to the default margin for an unknown category', () => {
    // defaultMarginBps 4000 -> 10000 * 1.4 = 14000 -> 14099
    expect(applyDynamicPricing(row({ category: 'Unknown' }), DEFAULT_PRICING_POLICY)).toEqual({
      ok: true,
      basePriceCents: 14_099,
    });
  });

  it('enforces the minimum-markup floor when the margin falls below it', () => {
    const policy = { ...DEFAULT_PRICING_POLICY, defaultMarginBps: 0, minMarkupBps: 1_500 };
    // margin 0 -> 10000, floor 1500 bps -> 11500, max -> 11500 -> charm -> 11599
    expect(applyDynamicPricing(row({ category: 'X' }), policy)).toEqual({
      ok: true,
      basePriceCents: 11_599,
    });
  });

  it('returns the raw result when charm pricing is disabled', () => {
    const policy = { ...DEFAULT_PRICING_POLICY, psychologicalPricing: false };
    expect(applyDynamicPricing(row(), policy)).toEqual({ ok: true, basePriceCents: 16_000 });
  });

  it('returns a Result instead of throwing (one bad row must not fail a 500K chunk)', () => {
    const result = applyDynamicPricing(row({ vendorPriceCents: -5 }), DEFAULT_PRICING_POLICY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('positive');
  });

  it('always lands above the vendor price and ends in .99', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50_000_000 }),
        fc.constantFrom('Accessories', 'Shoes', 'Outerwear', 'Basics', 'Other'),
        (vendorPriceCents, category) => {
          const result = applyDynamicPricing(
            row({ vendorPriceCents, category }),
            DEFAULT_PRICING_POLICY,
          );
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.basePriceCents).toBeGreaterThan(vendorPriceCents);
            expect(result.basePriceCents % 100).toBe(99);
          }
        },
      ),
    );
  });
});
