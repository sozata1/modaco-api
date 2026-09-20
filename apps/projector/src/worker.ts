import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { ProjectionJob } from '@modaco/core';
import { PROJECTION_QUEUE } from '@modaco/core';
import type { Db } from '@modaco/db';
import { projectPricesForCategoryBatch, projectPricesForIds } from '@modaco/db';

/**
 * The consumer side of Scenario B.
 *
 * Publishing a category-wide flash sale writes one row and returns. Everything that
 * makes that promotion visible in listings — recomputing the materialized effective
 * price on tens of thousands of products, and invalidating their detail cache entries —
 * happens here, off the request path, in bounded batches.
 */
export interface ProjectionDeps {
  readonly db: Db;
  readonly cacheRedis: Redis;
  readonly queueRedis: Redis;
  readonly logger: Logger;
  readonly batchSize: number;
  readonly concurrency: number;
}

export function startProjectionWorker(deps: ProjectionDeps): {
  worker: Worker<ProjectionJob>;
  queue: Queue<ProjectionJob>;
} {
  const queue = new Queue<ProjectionJob>(PROJECTION_QUEUE, { connection: deps.queueRedis });

  const worker = new Worker<ProjectionJob>(
    PROJECTION_QUEUE,
    async (job: Job<ProjectionJob>) => {
      const data = job.data;
      if (data.kind === 'ids') {
        const rows = await projectPricesForIds(deps.db, data.ids);
        await invalidateDetailKeys(deps.cacheRedis, rows.map((r) => r.id));
        deps.logger.info({ count: rows.length, reason: data.reason }, 'projected products by id');
        return;
      }

      const batch = await projectPricesForCategoryBatch(
        deps.db,
        data.category,
        data.cursor,
        deps.batchSize,
      );
      await invalidateDetailKeys(deps.cacheRedis, batch.rows.map((r) => r.id));

      // Re-enqueue rather than loop. A self-continuing chain of small jobs keeps every
      // transaction short, lets BullMQ retry a single failed batch instead of the whole
      // category, and leaves the queue drainable during a deploy.
      if (batch.nextCursor !== null) {
        await queue.add('category', {
          kind: 'category',
          category: data.category,
          cursor: batch.nextCursor,
          reason: data.reason,
        });
      }

      deps.logger.info(
        {
          category: data.category,
          count: batch.rows.length,
          reason: data.reason,
          continues: batch.nextCursor !== null,
        },
        'projected category batch',
      );
    },
    { connection: deps.queueRedis, concurrency: deps.concurrency },
  );

  worker.on('failed', (job, error) => {
    deps.logger.error({ err: error, jobId: job?.id, data: job?.data }, 'projection job failed');
  });

  return { worker, queue };
}

/**
 * Detail cache keys are deleted explicitly, one per affected product.
 *
 * They cannot be versioned like listings: a detail lookup starts from an id alone, so
 * the category — and therefore the version scope — is unknown until after the read. The
 * projector is already walking these exact rows, so it can pipeline the deletes with
 * them. Still no pattern delete anywhere: DEL on known keys, never KEYS or SCAN.
 */
async function invalidateDetailKeys(redis: Redis, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.del(`product:${id}`);
  await pipeline.exec();
}
