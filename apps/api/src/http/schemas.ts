import { z } from 'zod';
import { BPS_SCALE, MAX_PRICE_CENTS, parseCents } from '@modaco/core';

/** Prices cross the API boundary as decimal strings and become integer cents immediately. */
const PriceString = z
  .string()
  .transform((value, ctx) => {
    try {
      return parseCents(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a price such as "149.99"' });
      return z.NEVER;
    }
  });

export const ListProductsQuery = z.object({
  category: z.string().min(1).max(200).optional(),
  minPrice: PriceString.optional(),
  maxPrice: PriceString.optional(),
  // The only sortable field is effective price — the one the case asks for, and the one
  // the composite index supports. Accepting arbitrary sort columns would silently invite
  // full scans, so the allowed set is closed rather than open.
  sort: z.enum(['effective_price', '-effective_price']).default('effective_price'),
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const ProductIdParam = z.object({ id: z.string().uuid() });

export const CreateProductBody = z.object({
  sku: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, 'Invalid SKU'),
  name: z.string().min(1).max(500),
  category: z.string().min(1).max(200),
  basePrice: PriceString.refine((cents) => cents <= MAX_PRICE_CENTS, 'Price exceeds upper bound'),
  stockQuantity: z.number().int().min(0).default(0),
});

const IsoDate = z.string().datetime({ offset: true }).transform((value) => new Date(value));

export const CreatePromotionBody = z
  .object({
    name: z.string().min(1).max(500),
    discountType: z.enum(['percentage', 'fixed']),
    /** Percentage as a whole percent ("50" means 50%), fixed as a decimal price string. */
    discountValue: z.union([z.number(), z.string()]),
    startsAt: IsoDate,
    endsAt: IsoDate,
  })
  .transform((body, ctx) => {
    let value: number;
    if (body.discountType === 'percentage') {
      const percent = Number(body.discountValue);
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['discountValue'],
          message: 'Percentage discount must be between 0 (exclusive) and 100',
        });
        return z.NEVER;
      }
      // Stored as basis points so the value is exact: 12.5% is 1250, not 0.125.
      value = Math.round(percent * (BPS_SCALE / 100));
    } else {
      try {
        value = parseCents(String(body.discountValue));
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['discountValue'],
          message: 'Fixed discount must be a price such as "15.50"',
        });
        return z.NEVER;
      }
      if (value <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['discountValue'],
          message: 'Fixed discount must be greater than zero',
        });
        return z.NEVER;
      }
    }
    return { ...body, discountValue: value };
  })
  .refine((body) => body.endsAt > body.startsAt, {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });

export const AssignPromotionBody = z.discriminatedUnion('targetType', [
  z.object({ targetType: z.literal('product'), productId: z.string().uuid() }),
  z.object({ targetType: z.literal('category'), category: z.string().min(1).max(200) }),
]);

export const PromotionIdParam = z.object({ id: z.string().uuid() });
