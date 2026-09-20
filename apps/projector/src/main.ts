import { createServer } from 'node:http';
import { Redis } from 'ioredis';
import { createDb, createPool } from '@modaco/db';
import { createLogger } from '@modaco/observability';
import { loadConfig } from './config.js';
import { registry } from './metrics.js';
import { startProjectionWorker } from './worker.js';
import { startReconciler } from './reconciler.js';
import { startScheduler } from './scheduler.js';

const config = loadConfig();
const logger = createLogger({
  level: config.LOG_LEVEL,
  serviceName: config.SERVICE_NAME,
  pretty: config.LOG_PRETTY,
});

const pool = createPool({
  connectionString: config.DATABASE_URL,
  maxConnections: config.DB_POOL_MAX,
  applicationName: 'modaco-projector',
});
const db = createDb(pool);

const cacheRedis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
const queueRedis = new Redis(config.REDIS_QUEUE_URL, { maxRetriesPerRequest: null });
cacheRedis.on('error', (error: Error) => {
  logger.debug({ err: error }, 'cache redis error');
});
queueRedis.on('error', (error: Error) => {
  logger.warn({ err: error }, 'queue redis error');
});

const { worker, queue } = startProjectionWorker({
  db,
  cacheRedis,
  queueRedis,
  logger,
  batchSize: config.PROJECTION_BATCH_SIZE,
  concurrency: config.PROJECTION_CONCURRENCY,
});

const reconciler = startReconciler({
  db,
  cacheRedis,
  logger,
  intervalMs: config.PROJECTION_RECONCILE_INTERVAL_MS,
  batchSize: config.PROJECTION_BATCH_SIZE,
  scanWindow: config.PROJECTION_SCAN_WINDOW,
});

const scheduler = startScheduler({
  db,
  queue,
  logger,
  horizonMs: config.PROJECTION_SCHEDULE_HORIZON_MS,
});

// A worker still needs to be scrapeable and probeable; without this it is a black box
// that either is or is not keeping up, with no way to tell which from outside.
const metricsServer = createServer((req, res) => {
  if (req.url === '/metrics') {
    void registry.metrics().then((body) => {
      res.setHeader('Content-Type', registry.contentType);
      res.end(body);
    });
    return;
  }
  res.statusCode = req.url === '/health/live' ? 200 : 404;
  res.end(req.url === '/health/live' ? '{"status":"ok"}' : '{"error":"not found"}');
});
metricsServer.listen(3001, () => {
  logger.info({ port: 3001 }, 'projector started');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const force = setTimeout(() => process.exit(1), 30_000);
  force.unref();

  scheduler.stop();
  reconciler.stop();
  // close() waits for in-flight jobs; a half-applied projection batch would leave
  // products mid-flash-sale until the reconciler caught up.
  await worker.close();
  await queue.close();
  metricsServer.close();
  await pool.end();
  cacheRedis.disconnect();
  queueRedis.disconnect();

  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection');
});
