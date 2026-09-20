/**
 * A minimal forward-only migration runner.
 *
 * Why not an off-the-shelf tool: in this project the migrations ARE the deliverable
 * DDL — the case asks for the database schema. Wrapping that in an ORM DSL would make
 * the schema a generated artifact of a tool rather than something a reviewer can read.
 * See ADR-002.
 *
 * Each file runs inside a single transaction, because a half-applied schema is worse
 * than an unapplied one.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

async function ensureMigrationsTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        VARCHAR(255) PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function appliedMigrations(client: pg.Client): Promise<Set<string>> {
  const result = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
  return new Set(result.rows.map((row) => row.name));
}

export async function runMigrations(connectionString: string): Promise<number> {
  const client = new pg.Client({ connectionString, application_name: 'modaco-migrate' });
  await client.connect();

  try {
    await ensureMigrationsTable(client);
    const already = await appliedMigrations(client);
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let applied = 0;
    for (const file of files) {
      if (already.has(file)) {
        log(`  skip  ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`  ok    ${file}`);
        applied += 1;
      } catch (error) {
        await client.query('ROLLBACK');
        log(`  FAIL  ${file} — rolled back`);
        throw error;
      }
    }
    return applied;
  } finally {
    await client.end();
  }
}
