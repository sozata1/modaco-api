/** Migration CLI. Kept separate from the module so importing it has no side effects. */
import { runMigrations } from '../migrate.js';

const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const connectionString = process.env['DATABASE_URL'];
if (connectionString === undefined || connectionString === '') {
  log('DATABASE_URL is not set');
  process.exit(1);
}

log('Running migrations...');
try {
  const count = await runMigrations(connectionString);
  log(count === 0 ? 'Schema is up to date.' : `Applied ${count} migration(s).`);
} catch (error) {
  log(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
