import { Router } from 'express';
import type { Db } from '@modaco/db';
import { createProduct } from '@modaco/db';
import { PG_UNIQUE_VIOLATION, asPgError } from '@modaco/db';
import { ValidationError, formatCents } from '@modaco/core';
import type { ProductService } from '../../services/productService.js';
import type { Cache } from '../../cache/cache.js';
import { ALL_SCOPE } from '../../cache/cache.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { CreateProductBody, ListProductsQuery, ProductIdParam } from '../schemas.js';

export function productRoutes(
  service: ProductService,
  db: Db,
  cache: Cache,
): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const query = ListProductsQuery.parse(req.query);
      const result = await service.list({
        category: query.category,
        minPriceCents: query.minPrice,
        maxPriceCents: query.maxPrice,
        sort: query.sort === 'effective_price' ? 'asc' : 'desc',
        cursor: query.cursor,
        limit: query.limit,
      });

      res.json({
        data: result.items,
        page: { nextCursor: result.nextCursor, limit: query.limit },
      });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id } = ProductIdParam.parse(req.params);
      res.json({ data: await service.getById(id) });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const body = CreateProductBody.parse(req.body);

      let created;
      try {
        created = await createProduct(db, {
          sku: body.sku,
          name: body.name,
          category: body.category,
          basePriceCents: body.basePrice,
          stockQuantity: body.stockQuantity,
        });
      } catch (error) {
        if (asPgError(error)?.code === PG_UNIQUE_VIOLATION) {
          throw new ValidationError(`SKU ${body.sku} already exists`, { sku: body.sku });
        }
        throw error;
      }

      // A new product changes what any listing in its category should return, so those
      // cached pages must become unreachable. Its own detail key cannot be stale — the
      // row did not exist a moment ago — so there is nothing to delete.
      await cache.bumpVersion(created.category);
      await cache.bumpVersion(ALL_SCOPE);

      res.status(201).json({
        data: {
          id: created.id,
          sku: created.sku,
          name: created.name,
          category: created.category,
          basePrice: formatCents(created.base_price_cents),
          effectivePrice: formatCents(created.effective_price_cents),
          discounted: created.effective_price_cents < created.base_price_cents,
          activePromotionId: created.active_promotion_id,
          stockQuantity: created.stock_quantity,
        },
      });
    }),
  );

  return router;
}
