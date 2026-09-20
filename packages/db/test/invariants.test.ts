import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PG_EXCLUSION_VIOLATION, asPgError, createDb, type Db } from '../src/client.js';
import {
  findStaleProductIds,
  measureProjectionLagSeconds,
} from '../src/repositories/priceProjection.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';

/**
 * One container for the whole file. Both suites below want the same migrated schema,
 * and a second PostgreSQL costs ~20s of startup to give them nothing the first cannot.
 */
let db: TestDatabase;
let kysely: Db;

beforeAll(async () => {
  db = await startTestDatabase();
  kysely = createDb(db.pool);
}, 180_000);

afterAll(async () => {
  // Ends the shared pool, which is the one `kysely` above is built on.
  await db.stop();
});

afterEach(async () => {
  await db.pool.query('DELETE FROM promotions');
  await db.pool.query('DELETE FROM products');
});

/**
 * "A product can have at most ONE active promotion at a time" is enforced by an
 * EXCLUDE constraint rather than an application-level check. These tests exist to
 * prove that claim rather than assert it in a comment — in particular the concurrent
 * case, which is the only one an application-level SELECT-then-INSERT actually fails.
 */
describe('promotion invariants (enforced by the database)', () => {
  let productId: string;

  async function seedProduct(): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO products (sku, name, category, base_price_cents, effective_price_cents)
       VALUES ('SKU-1', 'Leather Belt', 'Accessories', 10000, 10000) RETURNING id`,
    );
    return rows[0]!.id;
  }

  async function insertProductPromotion(
    target: string,
    startsAt: string,
    endsAt: string,
    status = 'published',
  ): Promise<void> {
    await db.pool.query(
      `INSERT INTO promotions
         (name, discount_type, discount_value, starts_at, ends_at, target_type, target_product_id, status)
       VALUES ('p', 'percentage', 2000, $1, $2, 'product', $3, $4)`,
      [startsAt, endsAt, target, status],
    );
  }

  it('rejects a second overlapping promotion on the same product', async () => {
    productId = await seedProduct();
    await insertProductPromotion(productId, '2026-06-01', '2026-07-01');

    await expect(
      insertProductPromotion(productId, '2026-06-15', '2026-08-01'),
    ).rejects.toSatisfy((error: unknown) => asPgError(error)?.code === PG_EXCLUSION_VIOLATION);
  });

  it('accepts a non-overlapping promotion on the same product', async () => {
    productId = await seedProduct();
    await insertProductPromotion(productId, '2026-06-01', '2026-07-01');
    await insertProductPromotion(productId, '2026-07-01', '2026-08-01'); // abutting, not overlapping

    const { rows } = await db.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM promotions',
    );
    expect(rows[0]!.count).toBe(2);
  });

  it('does not constrain drafts — only published promotions hold a slot', async () => {
    productId = await seedProduct();
    await db.pool.query(
      `INSERT INTO promotions (name, discount_type, discount_value, starts_at, ends_at, status)
       VALUES ('draft-a', 'percentage', 2000, '2026-06-01', '2026-07-01', 'draft'),
              ('draft-b', 'percentage', 3000, '2026-06-01', '2026-07-01', 'draft')`,
    );
    const { rows } = await db.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM promotions WHERE status = 'draft'",
    );
    expect(rows[0]!.count).toBe(2);
  });

  it('frees the slot once a promotion is cancelled', async () => {
    productId = await seedProduct();
    await insertProductPromotion(productId, '2026-06-01', '2026-07-01');
    await db.pool.query(
      "UPDATE promotions SET status = 'cancelled', cancelled_at = NOW()",
    );
    await expect(
      insertProductPromotion(productId, '2026-06-15', '2026-08-01'),
    ).resolves.toBeUndefined();
  });

  /**
   * The case an application-level check cannot win.
   *
   * Both transactions read a clear slot, both decide to write. With a SELECT-then-INSERT
   * guard both would commit and the invariant would be quietly broken. The EXCLUDE
   * constraint makes the second INSERT block on the first, then fail on commit.
   */
  it('survives two concurrent writers — exactly one wins', async () => {
    productId = await seedProduct();

    const a = await db.pool.connect();
    const b = await db.pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');

      const insert = (client: typeof a, start: string, end: string): Promise<unknown> =>
        client.query(
          `INSERT INTO promotions
             (name, discount_type, discount_value, starts_at, ends_at, target_type, target_product_id, status)
           VALUES ('concurrent', 'percentage', 2000, $1, $2, 'product', $3, 'published')`,
          [start, end, productId],
        );

      await insert(a, '2026-06-01', '2026-07-01');

      // Overlaps A's range. This blocks until A resolves, then must fail.
      const second = insert(b, '2026-06-10', '2026-06-20');
      await a.query('COMMIT');

      await expect(second).rejects.toSatisfy(
        (error: unknown) => asPgError(error)?.code === PG_EXCLUSION_VIOLATION,
      );
      await b.query('ROLLBACK');
    } finally {
      a.release();
      b.release();
    }

    const { rows } = await db.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM promotions',
    );
    expect(rows[0]!.count).toBe(1);
  });

  /**
   * An executable record of a real mistake.
   *
   * The first draft of this schema carried `WHERE is_cancelled = false AND ends_at > NOW()`
   * on a partial index. It reads plausibly and it does not work: an index predicate must be
   * immutable, because it describes rows already written to disk. This test pins the
   * behaviour so the "optimisation" cannot quietly come back.
   */
  it('refuses a partial index whose predicate calls NOW()', async () => {
    await expect(
      db.pool.query(
        `CREATE INDEX idx_should_not_exist ON promotions (target_product_id)
           WHERE status = 'published' AND ends_at > NOW()`,
      ),
    ).rejects.toThrow(/must be marked IMMUTABLE/i);
  });

  it('ships no index that depends on NOW()', async () => {
    const { rows } = await db.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pg_indexes WHERE indexdef ILIKE '%now()%'",
    );
    expect(rows[0]!.count).toBe(0);
  });
});

describe('the reconciler detects the drift it exists to catch', () => {
  /**
   * Regression test for a real defect, found in a running system.
   *
   * `products.active_promotion_id` has `ON DELETE SET NULL`. Hard-deleting a promotion
   * therefore clears the id while leaving the discounted price in place. A reconciler
   * that compares only the id sees NULL against NULL — indistinguishable from a correct
   * row — and skips it forever, while the lag gauge cheerfully reports 0.
   *
   * Products sat at 5.00 against a base price of 9.99, with no promotion anywhere.
   *
   * These two call the shipped repository functions rather than a copy of their SQL.
   * A test that restates the query it is checking cannot fail when that query regresses,
   * which is the one thing this test exists to do.
   */
  it('flags a row whose price is wrong even though its promotion id is not', async () => {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO products (sku, name, category, base_price_cents, effective_price_cents,
                             active_promotion_id, price_computed_at)
       VALUES ('DRIFT-1', 'Drifted', 'Accessories', 999, 500, NULL, NOW() - INTERVAL '10 minutes')
       RETURNING id`,
    );
    const id = rows[0]!.id;

    expect((await findStaleProductIds(kysely, 100)).ids).toContain(id);
    // The gauge reading 0 through the whole incident is half the defect, so it is
    // asserted here too: both queries share one definition of "stale" for this reason.
    expect(await measureProjectionLagSeconds(kysely)).toBeGreaterThan(300);
  });

  it('does not flag a row that already agrees with the promotion table', async () => {
    await db.pool.query(
      `INSERT INTO products (sku, name, category, base_price_cents, effective_price_cents,
                             price_computed_at)
       VALUES ('CLEAN-1', 'Clean', 'Accessories', 999, 999, NOW() - INTERVAL '10 minutes')`,
    );

    expect((await findStaleProductIds(kysely, 100)).ids).toHaveLength(0);
    expect(await measureProjectionLagSeconds(kysely)).toBe(0);
  });
});
