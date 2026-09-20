/**
 * Money is integer CENTS everywhere. No floats, no Decimal library.
 *
 * Rationale: the effective price is computed in TWO places — PostgreSQL's
 * `apply_discount()` (the projection write path) and here (the ingestion Lambda).
 * The two must agree bit-for-bit. A NUMERIC column + a JS Decimal library + a
 * driver-level parser is three rounding contracts pretending to be one, and it
 * produces silent one-cent drift. Integers have no such ambiguity.
 *
 * See ADR-007.
 */

export type DiscountType = 'percentage' | 'fixed';

/** Percentage discounts are stored as basis points: 10000 bps = 100%. */
export const BPS_SCALE = 10_000;

/**
 * Upper bound that keeps the intermediate product `baseCents * BPS_SCALE` inside
 * Number.MAX_SAFE_INTEGER: 1e11 cents x 1e4 = 1e15 < 9.007e15.
 * Enforced here and at validation time rather than by a DB CHECK, because the
 * constraint is about JavaScript's number range, not about the data model.
 */
export const MAX_PRICE_CENTS = 100_000_000_000;

export type Discount =
  | { readonly type: 'percentage'; readonly valueBps: number }
  | { readonly type: 'fixed'; readonly valueCents: number };

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

export function assertValidPriceCents(cents: number): void {
  if (!Number.isInteger(cents)) throw new InvalidMoneyError(`Cents must be an integer: ${cents}`);
  if (cents < 0) throw new InvalidMoneyError(`Price cannot be negative: ${cents}`);
  if (cents > MAX_PRICE_CENTS) throw new InvalidMoneyError(`Price exceeds upper bound: ${cents}`);
}

/**
 * Effective price in cents, i.e. the price after the discount is applied.
 *
 * This is the exact counterpart of PostgreSQL's `apply_discount(base_cents, dtype, dvalue)`.
 * The equivalence is verified against a real database by a property-based test over
 * 10,000 random inputs (packages/db/test/pricing-parity.test.ts) — not by inspection.
 *
 * Rounding: we round the EFFECTIVE PRICE half-up, not the discount amount.
 *   effective = round(base * (1 - bps/10000))
 * An earlier version rounded the discount instead, which yields 7499 for 14999 at 50%
 * where the correct answer is 7500. One cent — but systematic across 500K rows.
 *
 * BigInt is not fastidiousness: in floating-point division a true quotient that sits
 * just below an integer can round up, and `trunc` then overshoots by one. BigInt
 * division truncates toward zero exactly, matching PostgreSQL's integer division.
 */
export function applyDiscount(baseCents: number, discount: Discount): number {
  assertValidPriceCents(baseCents);

  switch (discount.type) {
    case 'percentage': {
      const { valueBps } = discount;
      if (!Number.isInteger(valueBps) || valueBps < 0 || valueBps > BPS_SCALE) {
        throw new InvalidMoneyError(`Percentage discount must be within 0..${BPS_SCALE} bps`);
      }
      const numerator = BigInt(baseCents) * BigInt(BPS_SCALE - valueBps) + BigInt(BPS_SCALE / 2);
      return Number(numerator / BigInt(BPS_SCALE));
    }
    case 'fixed': {
      const { valueCents } = discount;
      if (!Number.isInteger(valueCents) || valueCents < 0) {
        throw new InvalidMoneyError('Fixed discount must be a non-negative integer');
      }
      return Math.max(0, baseCents - valueCents);
    }
  }
}

/** Presentation at the API boundary: 14999 -> "149.99". Never written to the database. */
export function formatCents(cents: number): string {
  assertValidPriceCents(cents);
  const major = Math.trunc(cents / 100);
  const minor = cents % 100;
  return `${major}.${minor.toString().padStart(2, '0')}`;
}

/** Parsing at the API boundary: "149.99" -> 14999, without float arithmetic. */
export function parseCents(input: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) throw new InvalidMoneyError(`Invalid price format: ${input}`);
  const major = Number(match[1]);
  const minor = Number((match[2] ?? '0').padEnd(2, '0'));
  const cents = major * 100 + minor;
  assertValidPriceCents(cents);
  return cents;
}
