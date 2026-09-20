import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { createPool } from '../../src/client.js';
import { runMigrations } from '../../src/migrate.js';

/**
 * Integration tests run against a real PostgreSQL, never a mock or an in-memory stand-in.
 *
 * Most of what this schema asserts — EXCLUDE constraints, partial-index predicate rules,
 * integer division semantics — has no meaningful behaviour outside a real engine. A mock
 * would agree with whatever we assumed, which is the exact failure mode these tests exist
 * to catch.
 *
 * The pool comes from `createPool` rather than `new pg.Pool` on purpose. That factory
 * installs the int8 type parser, so tests read BIGINT columns exactly the way production
 * does. An earlier version built its own pool here and the first parity run failed with
 * "27479821318" !== 27479821318 — the formulas agreed, the types did not.
 */
export interface TestDatabase {
  readonly pool: pg.Pool;
  readonly connectionString: string;
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:16-alpine',
  )
    .withDatabase('modaco_test')
    .start();

  const connectionString = container.getConnectionUri();
  await runMigrations(connectionString);

  const pool = createPool({ connectionString, maxConnections: 8, applicationName: 'modaco-test' });
  return {
    pool,
    connectionString,
    async stop() {
      await pool.end();
      await container.stop();
    },
  };
}
