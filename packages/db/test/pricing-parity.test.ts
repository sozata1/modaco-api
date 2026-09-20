import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { BPS_SCALE, MAX_PRICE_CENTS, applyDiscount } from '@modaco/core';
import { startTestDatabase, type TestDatabase } from './support/database.js';

/**
 * The single most important test in this repository.
 *
 * The effective price is computed in two places by design — `apply_discount()` in SQL
 * for the projection write path, and `applyDiscount()` in TypeScript for the ingestion
 * Lambda. That duplication buys index-backed sorting and a pure, dependency-free domain
 * layer, but it can only be paid for by proving the two implementations agree.
 *
 * This is not hypothetical. While planning this schema the SQL function rounded the
 * discount amount rather than the effective price and returned 7499 for 14999 at 50%
 * where the correct answer is 7500. One cent, silent, and systematic across 500K rows.
 * This test is why that cannot recur.
 */
describe('apply_discount(): SQL and TypeScript must agree', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await db.stop();
  });

  /** One round trip for the whole batch; per-row queries would make 10K inputs untenable. */
  async function sqlBatch(
    rows: readonly { base: number; type: 'percentage' | 'fixed'; value: number }[],
  ): Promise<number[]> {
    const result = await db.pool.query<{ effective: number }>(
      `SELECT apply_discount(b, t, v) AS effective
         FROM unnest($1::bigint[], $2::text[], $3::int[]) WITH ORDINALITY AS x(b, t, v, ord)
        ORDER BY ord`,
      [rows.map((r) => r.base), rows.map((r) => r.type), rows.map((r) => r.value)],
    );
    return result.rows.map((r) => r.effective);
  }

  it('agrees on the boundary cases that caught the original bug', async () => {
    const cases = [
      { base: 14_999, type: 'percentage' as const, value: 5_000 },
      { base: 10_000, type: 'percentage' as const, value: 3_333 },
      { base: 1_000, type: 'percentage' as const, value: 10_000 },
      { base: 333, type: 'percentage' as const, value: 5_000 },
      { base: 1, type: 'percentage' as const, value: 5_000 },
      { base: 999_999_999, type: 'percentage' as const, value: 1 },
      { base: 0, type: 'percentage' as const, value: 5_000 },
      { base: 1_000, type: 'fixed' as const, value: 5_000 },
      { base: 10_000, type: 'fixed' as const, value: 1_550 },
    ];

    const fromSql = await sqlBatch(cases);
    const fromTs = cases.map((c) =>
      applyDiscount(
        c.base,
        c.type === 'percentage'
          ? { type: 'percentage', valueBps: c.value }
          : { type: 'fixed', valueCents: c.value },
      ),
    );

    expect(fromSql).toEqual(fromTs);
    expect(fromSql[0]).toBe(7_500); // the exact value the first implementation got wrong
  });

  it('agrees across 10,000 random inputs', async () => {
    const rows = fc.sample(
      fc.record({
        base: fc.integer({ min: 0, max: MAX_PRICE_CENTS }),
        type: fc.constantFrom('percentage' as const, 'fixed' as const),
        value: fc.integer({ min: 0, max: BPS_SCALE }),
      }),
      10_000,
    );

    const fromSql = await sqlBatch(rows);
    const fromTs = rows.map((r) =>
      applyDiscount(
        r.base,
        r.type === 'percentage'
          ? { type: 'percentage', valueBps: r.value }
          : { type: 'fixed', valueCents: r.value },
      ),
    );

    const mismatches = rows
      .map((row, i) => ({ row, sql: fromSql[i], ts: fromTs[i] }))
      .filter((m) => m.sql !== m.ts);

    expect(mismatches.slice(0, 5)).toEqual([]);
  }, 120_000);
});
