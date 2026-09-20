import { Router } from 'express';
import type { Promotion } from '@modaco/db';
import { BPS_SCALE, formatCents } from '@modaco/core';
import type { PromotionService } from '../../services/promotionService.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AssignPromotionBody, CreatePromotionBody, PromotionIdParam } from '../schemas.js';

export function promotionRoutes(service: PromotionService): Router {
  const router = Router();

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const body = CreatePromotionBody.parse(req.body);
      const promotion = await service.createDraft(body);
      res.status(201).json({ data: toView(promotion) });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id } = PromotionIdParam.parse(req.params);
      res.json({ data: toView(await service.findById(id)) });
    }),
  );

  /**
   * Assign a target and publish.
   *
   * Returns 202, not 200: the promotion is durable and authoritative the instant this
   * responds, but the effective prices it implies are still rolling through. Claiming
   * 200 would promise a consistency this endpoint deliberately does not provide — the
   * whole point of Scenario B is that the 50K updates happen off the request path.
   */
  router.post(
    '/:id/assign',
    asyncHandler(async (req, res) => {
      const { id } = PromotionIdParam.parse(req.params);
      const body = AssignPromotionBody.parse(req.body);

      const promotion = await service.assignAndPublish(
        id,
        body.targetType === 'product'
          ? { type: 'product', productId: body.productId }
          : { type: 'category', category: body.category },
      );

      res.status(202).json({
        data: toView(promotion),
        projection: {
          status: 'pending',
          note: 'Effective prices are being reprojected asynchronously.',
        },
      });
    }),
  );

  router.patch(
    '/:id/cancel',
    asyncHandler(async (req, res) => {
      const { id } = PromotionIdParam.parse(req.params);
      const promotion = await service.cancel(id);
      res.status(202).json({
        data: toView(promotion),
        projection: { status: 'pending' },
      });
    }),
  );

  return router;
}

function toView(promotion: Promotion): Record<string, unknown> {
  return {
    id: promotion.id,
    name: promotion.name,
    discountType: promotion.discount_type,
    // Stored as basis points or cents; rendered back in the units a caller sent.
    discountValue:
      promotion.discount_type === 'percentage'
        ? promotion.discount_value / (BPS_SCALE / 100)
        : formatCents(promotion.discount_value),
    startsAt: promotion.starts_at,
    endsAt: promotion.ends_at,
    status: promotion.status,
    target:
      promotion.target_type === 'product'
        ? { type: 'product', productId: promotion.target_product_id }
        : promotion.target_type === 'category'
          ? { type: 'category', category: promotion.target_category }
          : null,
    cancelledAt: promotion.cancelled_at,
  };
}
