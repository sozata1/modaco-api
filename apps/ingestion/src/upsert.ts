import { sql } from 'kysely';
import type { Db } from '@modaco/db';

export interface UpsertRow {
  readonly sku: string;
  readonly name: string;
  readonly category: string;
  readonly basePriceCents: number;
  readonly stockQuantity: number;
}

/**
 * Deduplicate by SKU before the batch reaches PostgreSQL.
 *
 * Without this, a vendor file containing the same SKU twice inside one batch produces:
 *
 *   ERROR: ON CONFLICT DO UPDATE command cannot affect row a second time
 *
 * and — this is the part that matters — the ENTIRE batch rolls back, not just the
 * duplicate. A thousand good rows lost to one repeated SKU. Last write wins, matching
 * the semantics of processing the file top to bottom.
 */
export function dedupeBySku(rows: readonly UpsertRow[]): UpsertRow[] {
  const bySku = new Map<string, UpsertRow>();
  for (const row of rows) bySku.set(row.sku, row);
  return [...bySku.values()];
}

/**
 * Batch upsert via UNNEST rather than a multi-row VALUES list.
 *
 * VALUES needs one placeholder per column per row, so a 1,000-row batch is 5,000
 * parameters and PostgreSQL's limit of 65,535 caps the batch size. UNNEST passes five
 * arrays — five parameters regardless of batch size — so the batch is tuned by what is
 * efficient rather than by a protocol limit.
 *
 * The upsert is naturally idempotent, which is the first of the three layers that make
 * redelivery safe (see ingestion_chunks for the second and the job idempotency key for
 * the third).
 */
export async function upsertProducts(db: Db, rows: readonly UpsertRow[]): Promise<string[]> {
  if (rows.length === 0) return [];

  const result = await sql<{ id: string }>`
    INSERT INTO products (sku, name, category, base_price_cents, stock_quantity, effective_price_cents)
    SELECT t.sku, t.name, t.category, t.base_price_cents, t.stock_quantity, t.base_price_cents
    FROM unnest(
      ${sql.val(rows.map((r) => r.sku))}::text[],
      ${sql.val(rows.map((r) => r.name))}::text[],
      ${sql.val(rows.map((r) => r.category))}::text[],
      ${sql.val(rows.map((r) => r.basePriceCents))}::bigint[],
      ${sql.val(rows.map((r) => r.stockQuantity))}::int[]
    ) AS t(sku, name, category, base_price_cents, stock_quantity)
    ON CONFLICT (sku) DO UPDATE SET
      name             = EXCLUDED.name,
      category         = EXCLUDED.category,
      base_price_cents = EXCLUDED.base_price_cents,
      stock_quantity   = EXCLUDED.stock_quantity,
      updated_at       = NOW()
    RETURNING id
  `.execute(db);

  return result.rows.map((row) => row.id);
}
