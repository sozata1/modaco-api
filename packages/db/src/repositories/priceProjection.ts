import { sql } from 'kysely';
import type { Db } from '../client.js';

/**
 * The write side of the effective-price design.
 *
 * Sorting by effective price is only an index scan because the value is materialized
 * on `products`. Something has to keep that column true, and this is it. Note where the
 * LATERAL join lives: here, in the write path, running once per promotion change — not
 * in the read path, where it would turn every listing request into a full scan.
 *
 * The ORDER BY below MUST mirror `resolveActivePromotion()` in @modaco/core:
 *   1. product beats category   2. later starts_at   3. id ASC
 * See ADR-003.
 */

const RESOLVE_WINNING_PROMOTION = sql`
  SELECT pm.id, pm.discount_type, pm.discount_value
  FROM promotions pm
  WHERE pm.status = 'published'
    AND pm.cancelled_at IS NULL
    AND pm.starts_at <= NOW()
    AND pm.ends_at   >  NOW()
    AND ( (pm.target_type = 'product'  AND pm.target_product_id = p.id)
       OR (pm.target_type = 'category' AND pm.target_category   = p.category) )
  ORDER BY (pm.target_type = 'product') DESC, pm.starts_at DESC, pm.id ASC
  LIMIT 1
`;

interface ProjectedRow {
  id: string;
  effective_price_cents: number;
  active_promotion_id: string | null;
}

/** Recomputes the projection for an explicit set of products. */
export async function projectPricesForIds(
  db: Db,
  ids: readonly string[],
): Promise<ProjectedRow[]> {
  if (ids.length === 0) return [];

  const result = await sql<ProjectedRow>`
    WITH resolved AS (
      SELECT p.id, p.base_price_cents, pr.id AS promo_id,
             pr.discount_type, pr.discount_value
      FROM products p
      LEFT JOIN LATERAL (${RESOLVE_WINNING_PROMOTION}) pr ON TRUE
      WHERE p.id = ANY(${sql.val(ids)}::uuid[])
    )
    UPDATE products p SET
      effective_price_cents = CASE
        WHEN r.promo_id IS NULL THEN r.base_price_cents
        ELSE apply_discount(r.base_price_cents, r.discount_type, r.discount_value)
      END,
      active_promotion_id = r.promo_id,
      price_computed_at   = NOW()
    FROM resolved r
    WHERE p.id = r.id
    RETURNING p.id, p.effective_price_cents, p.active_promotion_id
  `.execute(db);

  return result.rows;
}

export interface CategoryBatchResult {
  readonly rows: ProjectedRow[];
  /** Cursor for the next batch; `null` once the category is exhausted. */
  readonly nextCursor: string | null;
}

/**
 * Reprojects one batch of a category. A flash sale on 50K products is applied as a
 * sequence of these, asynchronously — never inside the HTTP request that created the
 * promotion.
 *
 * Bounded batches keep each statement's lock footprint and WAL burst small, so the
 * storefront keeps reading while the write rolls through.
 *
 * Plain `FOR UPDATE`, deliberately not `SKIP LOCKED`. Skipping looked like the obvious
 * way to let several workers share a category, but it loses rows: a skipped row still
 * sits below the batch's highest id, the cursor advances past it, and nothing revisits it
 * in that pass. The product keeps its old price until the reconciler happens upon it.
 * Every worker takes locks in `id` order, so waiting cannot deadlock — and the wait is
 * short, because these transactions are.
 */
export async function projectPricesForCategoryBatch(
  db: Db,
  category: string,
  afterId: string | null,
  batchSize: number,
): Promise<CategoryBatchResult> {
  const result = await sql<ProjectedRow>`
    WITH batch AS (
      SELECT p.id
      FROM products p
      WHERE p.category = ${category}
        AND (${afterId}::uuid IS NULL OR p.id > ${afterId}::uuid)
      ORDER BY p.id
      LIMIT ${batchSize}
      FOR UPDATE
    ),
    resolved AS (
      SELECT p.id, p.base_price_cents, pr.id AS promo_id,
             pr.discount_type, pr.discount_value
      FROM products p
      JOIN batch b ON b.id = p.id
      LEFT JOIN LATERAL (${RESOLVE_WINNING_PROMOTION}) pr ON TRUE
    )
    UPDATE products p SET
      effective_price_cents = CASE
        WHEN r.promo_id IS NULL THEN r.base_price_cents
        ELSE apply_discount(r.base_price_cents, r.discount_type, r.discount_value)
      END,
      active_promotion_id = r.promo_id,
      price_computed_at   = NOW()
    FROM resolved r
    WHERE p.id = r.id
    RETURNING p.id, p.effective_price_cents, p.active_promotion_id
  `.execute(db);

  const rows = result.rows;
  const lastId = rows.length === batchSize ? maxId(rows) : null;
  return { rows, nextCursor: lastId };
}

function maxId(rows: readonly ProjectedRow[]): string | null {
  let max: string | null = null;
  for (const row of rows) if (max === null || row.id > max) max = row.id;
  return max;
}

/**
 * What a correct projection for a row would be, right now. One definition of "stale",
 * shared by the sweep and the lag gauge so the two cannot disagree.
 *
 * It compares the PRICE, not just the promotion id. Comparing only the id looks
 * sufficient and is not: `products.active_promotion_id` carries `ON DELETE SET NULL`, so
 * hard-deleting a promotion clears the id while leaving the discounted price behind. The
 * row then reads NULL-vs-NULL — indistinguishable from correct — and the reconciler skips
 * forever exactly the drift it exists to catch.
 *
 * Found in a running system: products sitting at 5.00 against a base of 9.99 with no
 * promotion anywhere, while the lag gauge reported 0. Regression test:
 * `packages/db/test/invariants.test.ts`.
 */
const EXPECTED_PRICE = sql`
  CASE WHEN pr.id IS NULL THEN p.base_price_cents
       ELSE apply_discount(p.base_price_cents, pr.discount_type, pr.discount_value)
  END
`;

export interface StaleScanResult {
  readonly ids: string[];
  /** Where the next sweep resumes; `null` once the table has been fully traversed. */
  readonly nextCursor: string | null;
}

/**
 * The safety net under the whole eventual-consistency story.
 *
 * Every targeted path — promotion publish, promotion cancel, the delayed jobs at
 * starts_at and ends_at — can be missed: a worker dies, a job is lost, a clock drifts.
 * This asks the only question that survives all of those: which rows disagree with what
 * the promotion table says right now?
 *
 * BOUNDED WINDOW, EXPLICIT CURSOR. The obvious implementation — examine every product on
 * every sweep — was measured at 3.2s and 519,000 buffers per minute against 500K products,
 * returning zero rows. The wall-clock cost was not the real damage: a million buffer
 * touches a minute evicts the storefront's hot pages from shared_buffers, so the safety
 * net was degrading the cache it exists to protect, and the cost grew with the catalogue.
 *
 * So each sweep examines `scanWindow` products starting from `afterId`, and the caller
 * carries the cursor forward until the table is exhausted, then starts again.
 *
 * The cursor is explicit rather than implied by `price_computed_at`, which was the first
 * attempt and does not work: a row found CORRECT is not reprojected, so its timestamp
 * never advances and the window never moves past it. Verified the hard way — 100
 * deliberately corrupted rows went unrepaired for 160 seconds because the sweep kept
 * re-examining the same oldest-but-healthy rows. Progress must come from the scan, not
 * from the repair.
 *
 * The trade-off, stated rather than buried: work per sweep is constant, time to detection
 * is not. A full pass takes `rowCount / scanWindow` sweeps. That is the right way round —
 * the targeted paths handle everything ordinary within seconds, and this exists only for
 * the rare case where one of them failed silently.
 */
export async function findStaleProductIds(
  db: Db,
  limit: number,
  scanWindow = 5_000,
  afterId: string | null = null,
): Promise<StaleScanResult> {
  const scanned = await sql<{ id: string; stale: boolean }>`
    WITH candidates AS (
      SELECT p.id, p.category, p.base_price_cents, p.effective_price_cents,
             p.active_promotion_id
      FROM products p
      WHERE ${afterId}::uuid IS NULL OR p.id > ${afterId}::uuid
      ORDER BY p.id
      LIMIT ${scanWindow}
    )
    SELECT p.id,
           (p.active_promotion_id   IS DISTINCT FROM pr.id
         OR p.effective_price_cents IS DISTINCT FROM (${EXPECTED_PRICE})) AS stale
    FROM candidates p
    LEFT JOIN LATERAL (${RESOLVE_WINNING_PROMOTION}) pr ON TRUE
    ORDER BY p.id
  `.execute(db);

  const rows = scanned.rows;
  const ids = rows.filter((row) => row.stale).map((row) => row.id).slice(0, limit);
  // A short window means the table ended here; wrap around on the next sweep.
  const nextCursor = rows.length === scanWindow ? (rows[rows.length - 1]?.id ?? null) : null;

  return { ids, nextCursor };
}

/**
 * Age of the oldest projection known to be wrong; feeds `price_projection_lag_seconds`.
 *
 * Measured over one bounded window for the same reason as the sweep — a gauge that costs
 * six seconds a minute to compute is itself a production problem. It is therefore a lower
 * bound: drift outside the current window is not yet visible to it. That is the honest
 * shape of this metric, and it is the number the sweep can actually act on.
 */
export async function measureProjectionLagSeconds(
  db: Db,
  scanWindow = 5_000,
  afterId: string | null = null,
): Promise<number> {
  const result = await sql<{ lag: number | null }>`
    WITH candidates AS (
      SELECT p.id, p.category, p.base_price_cents, p.effective_price_cents,
             p.active_promotion_id, p.price_computed_at
      FROM products p
      WHERE ${afterId}::uuid IS NULL OR p.id > ${afterId}::uuid
      ORDER BY p.id
      LIMIT ${scanWindow}
    )
    SELECT EXTRACT(EPOCH FROM (NOW() - MIN(p.price_computed_at)))::float8 AS lag
    FROM candidates p
    LEFT JOIN LATERAL (${RESOLVE_WINNING_PROMOTION}) pr ON TRUE
    WHERE p.active_promotion_id   IS DISTINCT FROM pr.id
       OR p.effective_price_cents IS DISTINCT FROM (${EXPECTED_PRICE})
  `.execute(db);
  return result.rows[0]?.lag ?? 0;
}
