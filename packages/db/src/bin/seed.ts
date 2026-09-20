/** Seeder CLI. Kept separate from the module so importing it has no side effects. */
import { createDb, createPool } from '../client.js';
import { seed } from '../seed.js';

const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const connectionString = process.env['DATABASE_URL'];
if (connectionString === undefined || connectionString === '') {
  log('DATABASE_URL is not set');
  process.exit(1);
}

const pool = createPool({ connectionString, maxConnections: 4, applicationName: 'modaco-seed' });
try {
  const result = await seed(createDb(pool));
  log(`Seeded. Catalogue now holds ${String(result.products)} products and ${String(result.promotions)} promotions.`);
} catch (error) {
  log(`Seed failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  await pool.end();
}
