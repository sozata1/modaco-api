import type { Db } from '../client.js';
import type { Promotion } from '../types.js';

export interface NewPromotionInput {
  readonly name: string;
  readonly discountType: 'percentage' | 'fixed';
  /** Basis points when percentage, cents when fixed. */
  readonly discountValue: number;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export type PromotionTarget =
  | { readonly type: 'product'; readonly productId: string }
  | { readonly type: 'category'; readonly category: string };

/**
 * Promotions are created as drafts and given a target later.
 *
 * The case asks for "create, cancel, and assign promotions to products or categories",
 * so assignment is a first-class operation rather than a field set at creation. Keeping
 * the target on the promotion row (instead of a join table) is what lets the EXCLUDE
 * constraint enforce the one-active-promotion rule directly; with a join table the
 * dates would have to be denormalised onto it and kept in sync. See ADR-004.
 */
export async function createDraftPromotion(
  db: Db,
  input: NewPromotionInput,
): Promise<Promotion> {
  return db
    .insertInto('promotions')
    .values({
      name: input.name,
      discount_type: input.discountType,
      discount_value: input.discountValue,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      status: 'draft',
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Assigns a target and publishes, in one statement.
 *
 * Publishing is where the EXCLUDE constraint bites: if another published promotion
 * already covers this target over an overlapping window, PostgreSQL raises 23P01 and
 * nothing is written. The application does not pre-check — a SELECT-then-INSERT guard
 * would let two concurrent requests both observe a free slot. The caller translates
 * 23P01 into a 409.
 */
export async function assignAndPublish(
  db: Db,
  promotionId: string,
  target: PromotionTarget,
): Promise<Promotion | null> {
  const result = await db
    .updateTable('promotions')
    .set({
      status: 'published',
      target_type: target.type,
      target_product_id: target.type === 'product' ? target.productId : null,
      target_category: target.type === 'category' ? target.category : null,
    })
    .where('id', '=', promotionId)
    .where('status', '=', 'draft')
    .returningAll()
    .executeTakeFirst();

  return result ?? null;
}

/**
 * Cancels a promotion. Soft, never a DELETE: the row is referenced by
 * `products.active_promotion_id` and it is part of the pricing audit trail —
 * why a customer saw a given price last Tuesday has to stay answerable.
 */
export async function cancelPromotion(db: Db, promotionId: string): Promise<Promotion | null> {
  const result = await db
    .updateTable('promotions')
    .set({ status: 'cancelled', cancelled_at: new Date() })
    .where('id', '=', promotionId)
    .where('status', '=', 'published')
    .returningAll()
    .executeTakeFirst();

  return result ?? null;
}

export async function findPromotionById(db: Db, id: string): Promise<Promotion | null> {
  const row = await db
    .selectFrom('promotions')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row ?? null;
}

/**
 * Published promotions whose window opens or closes inside the given interval.
 *
 * A promotion becomes active or inactive purely by the passage of time, with no write
 * to trigger a reprojection. The scheduler uses this to enqueue work at those instants
 * rather than polling every product.
 */
export async function findPromotionsCrossingWindow(
  db: Db,
  from: Date,
  to: Date,
): Promise<Promotion[]> {
  return db
    .selectFrom('promotions')
    .selectAll()
    .where('status', '=', 'published')
    .where('cancelled_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb.and([eb('starts_at', '>=', from), eb('starts_at', '<', to)]),
        eb.and([eb('ends_at', '>=', from), eb('ends_at', '<', to)]),
      ]),
    )
    .execute();
}
