import { createServer } from 'node:http';
import { Redis } from 'ioredis';
import { S3Client } from '@aws-sdk/client-s3';
import { createDb, createPool } from '@modaco/db';
import { RedisCache } from './cache/cache.js';
import { loadConfig } from './config.js';
import { createLogger } from '@modaco/observability';
import { dbPoolTotal, dbPoolWaiting } from './metrics.js';
import { BullProjectionQueue } from './queue/projectionQueue.js';
import { ProductService } from './services/productService.js';
import { PromotionService } from './services/promotionService.js';
import { createApp } from './http/app.js';

const config = loadConfig();
const logger = createLogger({
  level: config.LOG_LEVEL,
  serviceName: config.SERVICE_NAME,
  pretty: config.LOG_PRETTY,
});

const pool = createPool({
  connectionString: config.DATABASE_URL,
  maxConnections: config.DB_POOL_MAX,
  applicationName: 'modaco-api',
});
const db = createDb(pool);

// Cache connection: no offline queue and no retries, so a dead Redis fails fast and
// the request falls through to PostgreSQL instead of waiting out a retry loop.
// Fail-open only works if the failure is quick.
const cacheRedis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectTimeout: 1_000,
});
cacheRedis.on('error', (error: Error) => {
  logger.debug({ err: error }, 'cache redis error');
});

// Queue connection: the opposite posture. Losing a projection job is a silent
// correctness failure, so this one buffers and retries indefinitely.
const queueRedis = new Redis(config.REDIS_QUEUE_URL, { maxRetriesPerRequest: null });
queueRedis.on('error', (error: Error) => {
  logger.warn({ err: error }, 'queue redis error');
});

const cache = new RedisCache(cacheRedis, logger);
const projectionQueue = new BullProjectionQueue(queueRedis);

// Only used to issue presigned upload URLs; the API never reads or writes object bodies.
const s3 = new S3Client({
  region: config.AWS_REGION,
  ...(config.AWS_ENDPOINT_URL !== undefined
    ? { endpoint: config.AWS_ENDPOINT_URL, forcePathStyle: true }
    : {}),
});

const app = createApp({
  db,
  pool,
  cache,
  logger,
  s3,
  s3Bucket: config.S3_BUCKET,
  enableBenchRoutes: config.ENABLE_BENCH_ROUTES,
  productService: new ProductService(db, cache, config),
  promotionService: new PromotionService(db, cache, projectionQueue),
});

const server = createServer(app);

const poolMetricsTimer = setInterval(() => {
  dbPoolWaiting.set(pool.waitingCount);
  dbPoolTotal.set(pool.totalCount);
}, 5_000);
poolMetricsTimer.unref();

server.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'api listening');
});

/**
 * Graceful shutdown: stop accepting, let in-flight requests finish, then release
 * connections. Without this a deploy returns 502s to requests that were already
 * mid-flight — the most avoidable class of error there is.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const forceExit = setTimeout(() => {
    logger.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 15_000);
  forceExit.unref();

  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  clearInterval(poolMetricsTimer);
  await projectionQueue.close();
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
process.on('uncaughtException', (error) => {
  // An uncaught exception leaves the process in an unknown state; log it and let the
  // orchestrator restart us rather than limping on with corrupted invariants.
  logger.fatal({ err: error }, 'uncaught exception, exiting');
  process.exit(1);
});
