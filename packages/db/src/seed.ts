import { sql } from 'kysely';
import type { Db } from './client.js';
import {
  projectPricesForCategoryBatch,
  projectPricesForIds,
} from './repositories/priceProjection.js';

/**
 * A small, deliberately-shaped dataset for looking at the system by hand.
 *
 * Not a fixture for tests — those build exactly what they assert on. This exists so that
 * `GET /products` returns something meaningful the moment the stack is up, and so the
 * states that are easy to forget are all present: a sale running now, one scheduled for
 * next week, one already cancelled, and a product carrying its own promotion inside a
 * category that is also on sale.
 *
 * Idempotent. Run it twice and you get the same catalogue, not two of it.
 */

interface SeedProduct {
  readonly sku: string;
  readonly name: string;
  readonly category: string;
  readonly priceCents: number;
  readonly stock: number;
}

const PRODUCTS: SeedProduct[] = [
  { sku: 'ACC-001', name: 'Leather Belt', category: 'Accessories', priceCents: 14_999, stock: 40 },
  { sku: 'ACC-002', name: 'Silk Scarf', category: 'Accessories', priceCents: 24_999, stock: 12 },
  { sku: 'ACC-003', name: 'Wool Beanie', category: 'Accessories', priceCents: 7_999, stock: 88 },
  { sku: 'ACC-004', name: 'Canvas Tote', category: 'Accessories', priceCents: 19_900, stock: 5 },
  { sku: 'SHO-001', name: 'Running Shoe', category: 'Shoes', priceCents: 89_900, stock: 23 },
  { sku: 'SHO-002', name: 'Chelsea Boot', category: 'Shoes', priceCents: 129_900, stock: 7 },
  { sku: 'SHO-003', name: 'Canvas Sneaker', category: 'Shoes', priceCents: 44_900, stock: 60 },
  { sku: 'OUT-001', name: 'Quilted Jacket', category: 'Outerwear', priceCents: 199_900, stock: 9 },
  { sku: 'OUT-002', name: 'Rain Parka', category: 'Outerwear', priceCents: 159_900, stock: 14 },
  { sku: 'BAS-001', name: 'Cotton Tee', category: 'Basics', priceCents: 9_900, stock: 250 },
  { sku: 'BAS-002', name: 'Oxford Shirt', category: 'Basics', priceCents: 34_900, stock: 31 },
  { sku: 'DEN-001', name: 'Straight Jean', category: 'Denim', priceCents: 74_900, stock: 42 },
  { sku: 'DEN-002', name: 'Denim Jacket', category: 'Denim', priceCents: 99_900, stock: 18 },
  { sku: 'KNI-001', name: 'Merino Crewneck', category: 'Knitwear', priceCents: 119_900, stock: 11 },
  { sku: 'KNI-002', name: 'Cable Cardigan', category: 'Knitwear', priceCents: 139_900, stock: 6 },
];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface SeedResult {
  readonly products: number;
  readonly promotions: number;
}

export async function seed(db: Db): Promise<SeedResult> {
  const now = Date.now();

  const inserted = await db
    .insertInto('products')
    .values(
      PRODUCTS.map((p) => ({
        sku: p.sku,
        name: p.name,
        category: p.category,
        base_price_cents: p.priceCents,
        stock_quantity: p.stock,
        effective_price_cents: p.priceCents,
      })),
    )
    // Re-running must not duplicate the catalogue, and must not quietly diverge from it
    // either: the row is brought back to what this file says.
    .onConflict((oc) =>
      oc.column('sku').doUpdateSet((eb) => ({
        name: eb.ref('excluded.name'),
        category: eb.ref('excluded.category'),
        base_price_cents: eb.ref('excluded.base_price_cents'),
        stock_quantity: eb.ref('excluded.stock_quantity'),
      })),
    )
    .returning(['id', 'sku'])
    .execute();

  const bySku = new Map(inserted.map((row) => [row.sku, row.id]));

  // Clear promotions from a previous seed so the EXCLUDE constraint does not reject the
  // ones below. Only seeded rows: anything created by hand is left alone.
  await db.deleteFrom('promotions').where('name', 'like', '[seed]%').execute();

  const promotions = [
    {
      // Running now. This is what makes GET /products interesting on a fresh stack.
      name: '[seed] Flash: 25% off Accessories',
      discount_type: 'percentage' as const,
      discount_value: 2_500,
      starts_at: new Date(now - 2 * HOUR),
      ends_at: new Date(now + 5 * DAY),
      target_type: 'category' as const,
      target_category: 'Accessories',
      target_product_id: null,
      status: 'published' as const,
    },
    {
      // Scheduled. Exercises the path where a promotion becomes active by the clock alone,
      // with no write to trigger it — the scheduler's reason to exist.
      name: '[seed] Winter Knitwear 30%',
      discount_type: 'percentage' as const,
      discount_value: 3_000,
      starts_at: new Date(now + 2 * DAY),
      ends_at: new Date(now + 20 * DAY),
      target_type: 'category' as const,
      target_category: 'Knitwear',
      target_product_id: null,
      status: 'published' as const,
    },
    {
      // Product-level, inside a category that is also on sale. Resolution must pick this
      // one: the narrower target wins, even though it is the shallower discount.
      name: '[seed] Clearance: Canvas Tote',
      discount_type: 'fixed' as const,
      discount_value: 5_000,
      starts_at: new Date(now - HOUR),
      ends_at: new Date(now + 3 * DAY),
      target_type: 'product' as const,
      target_category: null,
      target_product_id: bySku.get('ACC-004') ?? null,
      status: 'published' as const,
    },
    {
      // A draft, waiting for POST /promotions/:id/assign.
      name: '[seed] Draft: Denim promo',
      discount_type: 'percentage' as const,
      discount_value: 1_500,
      starts_at: new Date(now + 7 * DAY),
      ends_at: new Date(now + 14 * DAY),
      target_type: null,
      target_category: null,
      target_product_id: null,
      status: 'draft' as const,
    },
  ];

  await db.insertInto('promotions').values(promotions).execute();

  // Bring the catalogue in line immediately rather than waiting for the projector.
  //
  // Whole categories, not just the rows seeded above: a category promotion applies to
  // everything in that category, which on a database that also holds an ingested feed is
  // far more than these fifteen products. Projecting only the seeded ids leaves the rest
  // at full price until a reconciler sweep reaches them.
  const touchedCategories = new Set(
    promotions
      .map((promotion) => promotion.target_category)
      .filter((category): category is string => category !== null),
  );

  for (const category of touchedCategories) {
    let cursor: string | null = null;
    do {
      const batch = await projectPricesForCategoryBatch(db, category, cursor, 5_000);
      cursor = batch.nextCursor;
    } while (cursor !== null);
  }

  // Product-level targets sit outside those categories' sweeps when the product's own
  // category was not promoted, so resolve the seeded rows explicitly too.
  await projectPricesForIds(db, [...bySku.values()]);

  const counts = await sql<{ products: number; promotions: number }>`
    SELECT (SELECT count(*)::int FROM products)   AS products,
           (SELECT count(*)::int FROM promotions) AS promotions
  `.execute(db);

  return {
    products: counts.rows[0]?.products ?? 0,
    promotions: counts.rows[0]?.promotions ?? 0,
  };
}
