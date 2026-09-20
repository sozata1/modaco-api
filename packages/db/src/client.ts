import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

/**
 * node-postgres returns BIGINT (int8) as a STRING by default. That is a defensible
 * default — a 64-bit integer can exceed JavaScript's safe range — but for us it is a
 * silent type hazard: if `base_price_cents` arrives as a string, arithmetic becomes
 * concatenation ("100" + 50 === "10050") and nothing throws.
 *
 * Our cent values are bounded by MAX_PRICE_CENTS (1e11), so they convert safely.
 * Anything outside that range is a bug we want to hear about loudly, not round away.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`BIGINT value exceeds JavaScript's safe integer range: ${value}`);
  }
  return parsed;
});

export interface DbConfig {
  readonly connectionString: string;
  /**
   * Deliberately tiny in Lambda (1-2). Thirty concurrent workers with a generous pool
   * each will exhaust PostgreSQL's max_connections and take the API down with them,
   * which is why PgBouncer (RDS Proxy in production) also sits in front. See ADR-005.
   */
  readonly maxConnections?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
  readonly applicationName?: string;
}

export function createPool(config: DbConfig): pg.Pool {
  return new pg.Pool({
    connectionString: config.connectionString,
    max: config.maxConnections ?? 20,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5_000,
    application_name: config.applicationName ?? 'modaco',
  });
}

export function createDb(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export type Db = Kysely<Database>;

/** PostgreSQL exclusion_violation — an EXCLUDE constraint rejected the write. */
export const PG_EXCLUSION_VIOLATION = '23P01';
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_CHECK_VIOLATION = '23514';
export const PG_FOREIGN_KEY_VIOLATION = '23503';

interface PgErrorShape {
  code: string;
  constraint?: string;
  detail?: string;
}

export function asPgError(error: unknown): PgErrorShape | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as Partial<PgErrorShape>;
  return typeof candidate.code === 'string' ? (candidate as PgErrorShape) : null;
}
