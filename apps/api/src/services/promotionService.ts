import type { ProjectionJob } from '@modaco/core';
import {
  InvalidPromotionStateError,
  NotFoundError,
  PromotionOverlapError,
  ValidationError,
} from '@modaco/core';
import type { Db, Promotion, PromotionTarget } from '@modaco/db';
import {
  PG_EXCLUSION_VIOLATION,
  asPgError,
  assignAndPublish,
  cancelPromotion,
  createDraftPromotion,
  findProductById,
  findPromotionById,
} from '@modaco/db';
import type { Cache } from '../cache/cache.js';
import { ALL_SCOPE, productCacheKey } from '../cache/cache.js';

export interface ProjectionQueue {
  enqueue(job: ProjectionJob): Promise<void>;
}

export interface CreatePromotionInput {
  readonly name: string;
  readonly discountType: 'percentage' | 'fixed';
  readonly discountValue: number;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export class PromotionService {
  constructor(
    private readonly db: Db,
    private readonly cache: Cache,
    private readonly queue: ProjectionQueue,
  ) {}

  async createDraft(input: CreatePromotionInput): Promise<Promotion> {
    if (input.endsAt <= input.startsAt) {
      throw new ValidationError('endsAt must be after startsAt');
    }
    return createDraftPromotion(this.db, input);
  }

  /**
   * Assign a target and publish. This is the flash-sale entry point.
   *
   * The request returns as soon as ONE row is written — a single INSERT-shaped update,
   * roughly a millisecond — and the tens of thousands of affected product rows are
   * reprojected asynchronously. Doing that work inline would block one HTTP request on
   * 50K updates while holding locks the storefront needs.
   *
   * That is the whole of Scenario B: the write is cheap and bounded, the expensive part
   * is distributed over time, and reads never wait for it.
   */
  async assignAndPublish(promotionId: string, target: PromotionTarget): Promise<Promotion> {
    if (target.type === 'product') {
      const product = await findProductById(this.db, target.productId);
      if (product === null) {
        throw new NotFoundError(`Product ${target.productId} was not found`, {
          productId: target.productId,
        });
      }
    }

    let promotion: Promotion | null;
    try {
      promotion = await assignAndPublish(this.db, promotionId, target);
    } catch (error) {
      // The invariant is owned by the database. We do not pre-check for an overlap —
      // a SELECT-then-INSERT guard lets two concurrent publishes both see a free slot.
      // We translate the rejection instead.
      if (asPgError(error)?.code === PG_EXCLUSION_VIOLATION) {
        throw new PromotionOverlapError(
          'Another active promotion already covers this target for an overlapping period',
          { promotionId, target },
        );
      }
      throw error;
    }

    if (promotion === null) {
      const existing = await findPromotionById(this.db, promotionId);
      if (existing === null) {
        throw new NotFoundError(`Promotion ${promotionId} was not found`, { promotionId });
      }
      throw new InvalidPromotionStateError(
        `Promotion ${promotionId} is ${existing.status}; only a draft can be assigned`,
        { promotionId, status: existing.status },
      );
    }

    await this.#invalidateAndReproject(target, 'promotion.published');
    return promotion;
  }

  async cancel(promotionId: string): Promise<Promotion> {
    const cancelled = await cancelPromotion(this.db, promotionId);
    if (cancelled === null) {
      const existing = await findPromotionById(this.db, promotionId);
      if (existing === null) {
        throw new NotFoundError(`Promotion ${promotionId} was not found`, { promotionId });
      }
      throw new InvalidPromotionStateError(
        `Promotion ${promotionId} is ${existing.status}; only a published promotion can be cancelled`,
        { promotionId, status: existing.status },
      );
    }

    await this.#invalidateAndReproject(targetOf(cancelled), 'promotion.cancelled');
    return cancelled;
  }

  async findById(promotionId: string): Promise<Promotion> {
    const promotion = await findPromotionById(this.db, promotionId);
    if (promotion === null) {
      throw new NotFoundError(`Promotion ${promotionId} was not found`, { promotionId });
    }
    return promotion;
  }

  /**
   * Invalidate first, then enqueue.
   *
   * The order matters. Bumping the version before the projection runs means readers may
   * briefly miss cache and recompute from a database that is still catching up — they
   * see a slightly stale price. The reverse order would serve a *cached* stale price for
   * a full TTL after the data was already correct, which is strictly worse and lasts longer.
   */
  async #invalidateAndReproject(
    target: PromotionTarget,
    reason: ProjectionJob['reason'],
  ): Promise<void> {
    if (target.type === 'category') {
      await this.cache.bumpVersion(target.category);
      await this.cache.bumpVersion(ALL_SCOPE);
      // Detail keys are deleted by the projector as it walks the category in batches;
      // it is already touching each row, so it can pipeline the deletes with them.
      await this.queue.enqueue({
        kind: 'category',
        category: target.category,
        cursor: null,
        reason,
      });
      return;
    }

    const product = await findProductById(this.db, target.productId);
    await this.cache.del([productCacheKey(target.productId)]);
    if (product !== null) {
      await this.cache.bumpVersion(product.category);
    }
    await this.cache.bumpVersion(ALL_SCOPE);
    await this.queue.enqueue({ kind: 'ids', ids: [target.productId], reason });
  }
}

function targetOf(promotion: Promotion): PromotionTarget {
  if (promotion.target_type === 'product' && promotion.target_product_id !== null) {
    return { type: 'product', productId: promotion.target_product_id };
  }
  if (promotion.target_type === 'category' && promotion.target_category !== null) {
    return { type: 'category', category: promotion.target_category };
  }
  throw new InvalidPromotionStateError('Promotion has no assigned target', {
    promotionId: promotion.id,
  });
}
