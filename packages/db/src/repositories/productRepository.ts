import { sql } from 'kysely';
import type { Db } from '../client.js';
import { projectPricesForIds } from './priceProjection.js';

export interface ProductRecord {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly category: string;
  readonly base_price_cents: number;
  readonly stock_quantity: number;
  readonly effective_price_cents: number;
  readonly active_promotion_id: string | null;
}

export type SortDirection = 'asc' | 'desc';

export interface ListProductsQuery {
  readonly category?: string;
  readonly minPriceCents?: number;
  readonly maxPriceCents?: number;
  readonly sort: SortDirection;
  readonly cursor?: Cursor;
  readonly limit: number;
}

export interface Cursor {
  readonly effectivePriceCents: number;
  readonly id: string;
}

export interface ListProductsResult {
  readonly items: ProductRecord[];
  readonly nextCursor: Cursor | null;
}

const COLUMNS = [
  'id',
  'sku',
  'name',
  'category',
  'base_price_cents',
  'stock_quantity',
  'effective_price_cents',
  'active_promotion_id',
] as const;

export async function findProductById(db: Db, id: string): Promise<ProductRecord | null> {
  const row = await db
    .selectFrom('products')
    .select(COLUMNS)
    .where('id', '=', id)
    .where('is_active', '=', true)
    .executeTakeFirst();
  return row ?? null;
}

/**
 * Keyset pagination over `(effective_price_cents, id)`, matching the composite index.
 *
 * OFFSET is not used anywhere. It reads and discards N rows to reach page N, so deep
 * pages degrade linearly, and — worse for a storefront during a flash sale — when
 * prices shift between requests OFFSET silently skips and repeats items. A row-value
 * cursor is stable against concurrent writes and costs the same on page 500 as on page 1.
 *
 * `id` is in the key for a reason: effective prices collide constantly (a category-wide
 * percentage maps many base prices onto the same cent), and without a unique tiebreaker
 * the cursor cannot describe a single position.
 */
export async function listProducts(db: Db, query: ListProductsQuery): Promise<ListProductsResult> {
  let builder = db.selectFrom('products').select(COLUMNS).where('is_active', '=', true);

  if (query.category !== undefined) builder = builder.where('category', '=', query.category);
  if (query.minPriceCents !== undefined) {
    builder = builder.where('effective_price_cents', '>=', query.minPriceCents);
  }
  if (query.maxPriceCents !== undefined) {
    builder = builder.where('effective_price_cents', '<=', query.maxPriceCents);
  }

  if (query.cursor !== undefined) {
    const { effectivePriceCents, id } = query.cursor;
    // Row-value comparison, so PostgreSQL can satisfy it from the composite index
    // in a single range scan rather than as an OR of two predicates.
    builder = builder.where(
      query.sort === 'asc'
        ? sql<boolean>`(effective_price_cents, id) > (${effectivePriceCents}, ${id}::uuid)`
        : sql<boolean>`(effective_price_cents, id) < (${effectivePriceCents}, ${id}::uuid)`,
    );
  }

  // One extra row tells us whether another page exists without a second COUNT query.
  const rows = await builder
    .orderBy('effective_price_cents', query.sort)
    .orderBy('id', query.sort)
    .limit(query.limit + 1)
    .execute();

  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  const last = items.at(-1);

  return {
    items,
    nextCursor:
      hasMore && last !== undefined
        ? { effectivePriceCents: last.effective_price_cents, id: last.id }
        : null,
  };
}

export interface NewProductInput {
  readonly sku: string;
  readonly name: string;
  readonly category: string;
  readonly basePriceCents: number;
  readonly stockQuantity: number;
}

/**
 * Creates a product and resolves its effective price in the SAME transaction.
 *
 * This is what makes "a product added during an active flash sale is discounted
 * immediately" true by construction rather than by a background job racing the first
 * read. The row is never visible without a correct projection.
 */
export async function createProduct(db: Db, input: NewProductInput): Promise<ProductRecord> {
  return db.transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto('products')
      .values({
        sku: input.sku,
        name: input.name,
        category: input.category,
        base_price_cents: input.basePriceCents,
        stock_quantity: input.stockQuantity,
        // Provisional: the projection below overwrites it before the transaction commits.
        effective_price_cents: input.basePriceCents,
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();

    const [projected] = await projectPricesForIds(trx, [inserted.id]);
    return projected === undefined
      ? inserted
      : {
          ...inserted,
          effective_price_cents: projected.effective_price_cents,
          active_promotion_id: projected.active_promotion_id,
        };
  });
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${String(cursor.effectivePriceCents)}:${cursor.id}`).toString('base64url');
}

export function decodeCursor(encoded: string): Cursor | null {
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator <= 0) return null;
    const price = Number(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (!Number.isSafeInteger(price) || price < 0 || id.length === 0) return null;
    return { effectivePriceCents: price, id };
  } catch {
    return null;
  }
}

/**
 * Benchmark-only: resolves effective price at READ time with a LATERAL join.
 *
 * This is the design the first plan proposed for the listing and detail endpoints. It is
 * kept solely so the ADR's claim about it can be measured rather than asserted — it is not
 * reachable from any production route. See bench/src/bench-detail.ts.
 */
export async function findProductByIdComputed(
  db: Db,
  id: string,
): Promise<ProductRecord | null> {
  const result = await sql<ProductRecord>`
    SELECT p.id, p.sku, p.name, p.category, p.base_price_cents, p.stock_quantity,
           COALESCE(
             apply_discount(p.base_price_cents, pr.discount_type, pr.discount_value),
             p.base_price_cents
           ) AS effective_price_cents,
           pr.id AS active_promotion_id
    FROM products p
    LEFT JOIN LATERAL (
      SELECT pm.id, pm.discount_type, pm.discount_value
      FROM promotions pm
      WHERE pm.status = 'published' AND pm.cancelled_at IS NULL
        AND pm.starts_at <= NOW() AND pm.ends_at > NOW()
        AND ( (pm.target_type = 'product'  AND pm.target_product_id = p.id)
           OR (pm.target_type = 'category' AND pm.target_category   = p.category) )
      ORDER BY (pm.target_type = 'product') DESC, pm.starts_at DESC, pm.id ASC
      LIMIT 1
    ) pr ON TRUE
    WHERE p.id = ${id}::uuid AND p.is_active
  `.execute(db);
  return result.rows[0] ?? null;
}
