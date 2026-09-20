/**
 * The contract between the API and the projector.
 *
 * These are domain events, declared in the domain layer and deliberately transport-free:
 * no BullMQ, no Redis, no serialization concerns. The API emits them, the projector
 * consumes them, and the queue that carries them is an implementation detail either side
 * can change without the other noticing.
 */

export type ProjectionReason =
  | 'promotion.published'
  | 'promotion.cancelled'
  | 'promotion.window.opened'
  | 'promotion.window.closed'
  | 'reconciler';

/**
 * A unit of reprojection work.
 *
 * Category work carries a cursor because a flash sale spans tens of thousands of rows:
 * the projector processes one batch, then re-enqueues itself with the next cursor. That
 * keeps every individual job small and interruptible instead of holding one long
 * transaction across 50K updates.
 */
export type ProjectionJob =
  | {
      readonly kind: 'category';
      readonly category: string;
      readonly cursor: string | null;
      readonly reason: ProjectionReason;
    }
  | {
      readonly kind: 'ids';
      readonly ids: readonly string[];
      readonly reason: ProjectionReason;
    };

export const PROJECTION_QUEUE = 'modaco.projection';

/** Cache invalidation scope: a category name, or every listing. */
export function scopeForCategory(category: string): string {
  return category;
}
