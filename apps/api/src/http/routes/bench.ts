import { Router } from 'express';
import { NotFoundError, formatCents } from '@modaco/core';
import type { Db, ProductRecord } from '@modaco/db';
import { findProductById, findProductByIdComputed } from '@modaco/db';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ProductIdParam } from '../schemas.js';

/**
 * Measurement routes, mounted only when ENABLE_BENCH_ROUTES is set.
 *
 * They exist so the central read-path claim can be measured under identical conditions —
 * same process, same pool, same serialization — rather than argued. Two arms:
 *
 *   materialized  the shipped design: primary-key lookup, no join, no cache
 *   lateral       the first plan's design: effective price resolved at read time
 *
 * The third arm is the real endpoint, which adds cache-aside on top of `materialized`.
 * Comparing a raw SQL timing against an HTTP endpoint would measure the framework as much
 * as the query, which is why these are routes and not a script.
 */
export function benchRoutes(db: Db): Router {
  const router = Router();

  router.get(
    '/materialized/:id',
    asyncHandler(async (req, res) => {
      const { id } = ProductIdParam.parse(req.params);
      const record = await findProductById(db, id);
      if (record === null) throw new NotFoundError(`Product ${id} was not found`);
      res.json({ data: view(record) });
    }),
  );

  router.get(
    '/lateral/:id',
    asyncHandler(async (req, res) => {
      const { id } = ProductIdParam.parse(req.params);
      const record = await findProductByIdComputed(db, id);
      if (record === null) throw new NotFoundError(`Product ${id} was not found`);
      res.json({ data: view(record) });
    }),
  );

  return router;
}

function view(record: ProductRecord): Record<string, unknown> {
  return {
    id: record.id,
    sku: record.sku,
    name: record.name,
    category: record.category,
    basePrice: formatCents(record.base_price_cents),
    effectivePrice: formatCents(record.effective_price_cents),
    discounted: record.effective_price_cents < record.base_price_cents,
    activePromotionId: record.active_promotion_id,
    stockQuantity: record.stock_quantity,
  };
}
