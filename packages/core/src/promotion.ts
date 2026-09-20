import type { Discount, DiscountType } from './money.js';
import { applyDiscount } from './money.js';

export type PromotionTargetType = 'product' | 'category';
export type PromotionStatus = 'draft' | 'published' | 'cancelled';

export interface PromotionCandidate {
  readonly id: string;
  readonly discountType: DiscountType;
  /** Basis points when percentage, cents when fixed. */
  readonly discountValue: number;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly targetType: PromotionTargetType;
}

export function toDiscount(p: Pick<PromotionCandidate, 'discountType' | 'discountValue'>): Discount {
  return p.discountType === 'percentage'
    ? { type: 'percentage', valueBps: p.discountValue }
    : { type: 'fixed', valueCents: p.discountValue };
}

/** Validity window is `[startsAt, endsAt)` — end excluded, matching the DB's tstzrange. */
export function isActiveAt(p: PromotionCandidate, at: Date): boolean {
  const t = at.getTime();
  return p.startsAt.getTime() <= t && t < p.endsAt.getTime();
}

/**
 * BUSINESS RULE: "A product can have at most ONE active promotion at a time."
 *
 * That sentence hides two different problems, solved in two different places:
 *
 *   A) Conflict at the SAME level — two promotions on the same product with
 *      overlapping date ranges. This is a VIOLATION. It is made physically
 *      impossible by an EXCLUDE constraint in the database. Checking for it in
 *      the application ("SELECT, then INSERT if clear") is open to a TOCTOU race:
 *      two concurrent requests both see a clear slot and both write.
 *
 *   B) Coverage at DIFFERENT levels — a product-specific promotion AND a
 *      category-wide flash sale. This is NOT a violation; it is normal and
 *      unavoidable (Scenario B produces it by design). Both are stored, exactly
 *      one is applied, and this function decides which.
 *
 * Precedence:
 *   1. Specificity: product beats category   (the narrower target wins)
 *   2. startsAt DESC                         (the more recently effective one)
 *   3. id ASC                                (stable tie-break)
 *
 * `startsAt` rather than `createdAt`: what matters commercially is when a promotion
 * took effect, not when someone happened to save the record.
 *
 * Rejected alternative: "the deepest discount wins, in the customer's favour". It
 * lets a global flash sale silently override a deliberate product-level price
 * decision, which removes the merchandiser's ability to protect a margin. See ADR-003.
 *
 * INVARIANT: this ordering must stay identical to the ORDER BY of the LATERAL
 * subquery in the projection SQL. If one changes, the other must change with it.
 */
export function resolveActivePromotion(
  candidates: readonly PromotionCandidate[],
  at: Date,
): PromotionCandidate | null {
  let winner: PromotionCandidate | null = null;

  for (const candidate of candidates) {
    if (!isActiveAt(candidate, at)) continue;
    if (winner === null || comparePrecedence(candidate, winner) < 0) winner = candidate;
  }

  return winner;
}

/** Negative means `a` wins. SQL: `ORDER BY (target_type='product') DESC, starts_at DESC, id ASC`. */
function comparePrecedence(a: PromotionCandidate, b: PromotionCandidate): number {
  const aSpecific = a.targetType === 'product' ? 0 : 1;
  const bSpecific = b.targetType === 'product' ? 0 : 1;
  if (aSpecific !== bSpecific) return aSpecific - bSpecific;

  const startDelta = b.startsAt.getTime() - a.startsAt.getTime();
  if (startDelta !== 0) return startDelta;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface EffectivePrice {
  readonly effectivePriceCents: number;
  readonly activePromotionId: string | null;
}

/** Resolves a product's effective price. With no active promotion the base price passes through. */
export function calculateEffectivePrice(
  basePriceCents: number,
  candidates: readonly PromotionCandidate[],
  at: Date,
): EffectivePrice {
  const promotion = resolveActivePromotion(candidates, at);
  if (promotion === null) {
    return { effectivePriceCents: basePriceCents, activePromotionId: null };
  }
  return {
    effectivePriceCents: applyDiscount(basePriceCents, toDiscount(promotion)),
    activePromotionId: promotion.id,
  };
}

/** Half-open `[start, end)` overlap — the counterpart of PostgreSQL's `&&` on tstzrange. */
export function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}
