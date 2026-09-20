import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { S3Client } from '@aws-sdk/client-s3';
import type { Express } from 'express';
import pino from 'pino';
import type { ProjectionJob } from '@modaco/core';
import type { Db } from '@modaco/db';
import {
  createDb,
  createPool,
  projectPricesForCategoryBatch,
  projectPricesForIds,
  runMigrations,
} from '@modaco/db';
import { RedisCache } from '../../src/cache/cache.js';
import { loadConfig } from '../../src/config.js';
import { createApp } from '../../src/http/app.js';
import { ProductService } from '../../src/services/productService.js';
import { PromotionService, type ProjectionQueue } from '../../src/services/promotionService.js';

/**
 * Real PostgreSQL and real Redis. What is under test here — EXCLUDE constraints, keyset
 * pagination over a composite index, cache invalidation by version bump — has no meaning
 * against a mock, which would simply agree with whatever we assumed.
 *
 * The one substitution is the queue: projection runs inline rather than through BullMQ.
 * That is not a way around the asynchrony, it is a way to assert its RESULT
 * deterministically. Whether a queue delivers is BullMQ's problem; whether the projection
 * computes the right prices is ours.
 */
class InlineProjectionQueue implements ProjectionQueue {
  readonly jobs: ProjectionJob[] = [];
  constructor(
    private readonly db: Db,
    private readonly redis: Redis,
  ) {}

  /**
   * Mirrors the projector exactly — including the detail-key deletion, which an earlier
   * version omitted. The tests caught it: a cancelled promotion kept serving its
   * discounted price from cache. The bug was in this harness rather than in the service,
   * but a stand-in that does less than the thing it stands in for tests the wrong system.
   */
  async enqueue(job: ProjectionJob): Promise<void> {
    this.jobs.push(job);

    if (job.kind === 'ids') {
      const rows = await projectPricesForIds(this.db, job.ids);
      await this.#invalidate(rows.map((r) => r.id));
      return;
    }

    let cursor: string | null = job.cursor;
    do {
      const batch = await projectPricesForCategoryBatch(this.db, job.category, cursor, 5_000);
      await this.#invalidate(batch.rows.map((r) => r.id));
      cursor = batch.nextCursor;
    } while (cursor !== null);
  }

  async #invalidate(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.del(`product:${id}`);
    await pipeline.exec();
  }
}

export interface Harness {
  readonly app: Express;
  readonly db: Db;
  readonly redis: Redis;
  readonly queue: InlineProjectionQueue;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const [postgres, redisContainer]: [StartedPostgreSqlContainer, StartedRedisContainer] =
    await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine').withDatabase('modaco_test').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);

  const connectionString = postgres.getConnectionUri();
  await runMigrations(connectionString);

  const pool = createPool({ connectionString, maxConnections: 8, applicationName: 'modaco-test' });
  const db = createDb(pool);
  const redis = new Redis(redisContainer.getConnectionUrl(), { maxRetriesPerRequest: 1 });

  const logger = pino({ level: 'silent' });
  const cache = new RedisCache(redis, logger);
  const queue = new InlineProjectionQueue(db, redis);

  const config = loadConfig({
    DATABASE_URL: connectionString,
    REDIS_URL: redisContainer.getConnectionUrl(),
    REDIS_QUEUE_URL: redisContainer.getConnectionUrl(),
    NODE_ENV: 'test',
  });

  const app = createApp({
    db,
    pool,
    cache,
    logger,
    productService: new ProductService(db, cache, config),
    promotionService: new PromotionService(db, cache, queue),
    s3: new S3Client({
      region: 'eu-central-1',
      credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
    }),
    s3Bucket: 'test-bucket',
    enableBenchRoutes: false,
  });

  return {
    app,
    db,
    redis,
    queue,
    async reset() {
      await db.deleteFrom('promotions').execute();
      await db.deleteFrom('products').execute();
      await redis.flushall();
      queue.jobs.length = 0;
    },
    async stop() {
      await pool.end();
      redis.disconnect();
      await Promise.all([postgres.stop(), redisContainer.stop()]);
    },
  };
}
