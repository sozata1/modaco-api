import { MAX_PRICE_CENTS, assertValidPriceCents } from './money.js';

/**
 * The case requires that "every record must pass through internal dynamic pricing
 * rules (an application-layer process) before being saved."
 *
 * This module is that process, and it is deliberately PURE: no database, no I/O, no
 * global state. That is what lets the identical code run inside the Express API and
 * inside the ingestion Lambda, guarded by one set of unit tests. See ADR-009.
 *
 * Failures are returned as a Result rather than thrown. With 500K rows per file,
 * throw/catch is both slow and wrong-shaped: one malformed row must not take down a
 * chunk. Rejected rows are recorded and the job carries on.
 */

export interface VendorRow {
  readonly sku: string;
  readonly name: string;
  readonly category: string;
  readonly vendorPriceCents: number;
  readonly stockQuantity: number;
}

export interface PricingPolicy {
  /** Per-category margin in basis points; `defaultMarginBps` when the category is unknown. */
  readonly categoryMarginBps: Readonly<Record<string, number>>;
  readonly defaultMarginBps: number;
  /** Floor: the final price may never fall below vendor price plus this markup (bps). */
  readonly minMarkupBps: number;
  /** Charm pricing: end the result in `.99`. */
  readonly psychologicalPricing: boolean;
}

export const DEFAULT_PRICING_POLICY: PricingPolicy = {
  categoryMarginBps: { Accessories: 6000, Shoes: 4500, Outerwear: 5500, Basics: 3000 },
  defaultMarginBps: 4000,
  minMarkupBps: 1500,
  psychologicalPricing: true,
};

export type PricingResult =
  | { readonly ok: true; readonly basePriceCents: number }
  | { readonly ok: false; readonly reason: string };

const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function validateVendorRow(row: VendorRow): string | null {
  if (!SKU_PATTERN.test(row.sku)) return `invalid SKU: "${row.sku}"`;
  if (row.name.trim().length === 0) return 'product name is empty';
  if (row.name.length > 500) return 'product name exceeds 500 characters';
  if (row.category.trim().length === 0) return 'category is empty';
  if (row.category.length > 200) return 'category exceeds 200 characters';
  if (!Number.isInteger(row.vendorPriceCents) || row.vendorPriceCents <= 0)
    return `vendor price must be a positive integer: ${row.vendorPriceCents}`;
  if (row.vendorPriceCents > MAX_PRICE_CENTS) return 'vendor price exceeds upper bound';
  if (!Number.isInteger(row.stockQuantity) || row.stockQuantity < 0)
    return `stock must be a non-negative integer: ${row.stockQuantity}`;
  return null;
}

/**
 * Vendor price -> ModaCo base price.
 *
 * Order: apply margin, then enforce the minimum-markup floor, then charm-round.
 * Rounding runs last and only ever moves the price up, so it cannot breach the floor.
 */
export function applyDynamicPricing(row: VendorRow, policy: PricingPolicy): PricingResult {
  const invalid = validateVendorRow(row);
  if (invalid !== null) return { ok: false, reason: invalid };

  const marginBps = policy.categoryMarginBps[row.category] ?? policy.defaultMarginBps;

  const withMargin = scaleByBps(row.vendorPriceCents, marginBps);
  const floor = scaleByBps(row.vendorPriceCents, policy.minMarkupBps);

  let price = Math.max(withMargin, floor);
  if (policy.psychologicalPricing) price = roundUpToNinetyNine(price);

  if (price > MAX_PRICE_CENTS) return { ok: false, reason: 'computed price exceeds upper bound' };
  assertValidPriceCents(price);
  return { ok: true, basePriceCents: price };
}

/** `cents * (1 + bps/10000)`, rounded half-up, in exact integer arithmetic. */
function scaleByBps(cents: number, bps: number): number {
  return Number((BigInt(cents) * BigInt(10_000 + bps) + 5_000n) / 10_000n);
}

/**
 * Raises the price to the `.99` of its current hundred: 14950 -> 14999, 15000 -> 15099.
 *
 * Since `cents = X*100 + r` with `0 <= r <= 99`, the result is always >= the input.
 * Charm rounding therefore never lowers a price and cannot breach the markup floor,
 * which is why no floor re-check is needed here.
 */
function roundUpToNinetyNine(cents: number): number {
  return Math.floor(cents / 100) * 100 + 99;
}
