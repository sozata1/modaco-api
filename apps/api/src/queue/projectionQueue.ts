import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { ProjectionJob } from '@modaco/core';
import { PROJECTION_QUEUE } from '@modaco/core';
import type { ProjectionQueue } from '../services/promotionService.js';

/**
 * BullMQ carries internal projection work; SQS carries vendor ingestion.
 *
 * Two queues, because they answer to different constraints. Ingestion must be
 * serverless-native — SQS with an event source mapping is what Lambda consumes — while
 * projection work is ordinary in-cluster background work next to a Redis we already run
 * for caching. Forcing either through the other's transport would cost more than it saves.
 */
export class BullProjectionQueue implements ProjectionQueue {
  readonly #queue: Queue<ProjectionJob>;

  constructor(connection: Redis) {
    this.#queue = new Queue<ProjectionJob>(PROJECTION_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { count: 1_000 },
        // Failures are kept far longer than successes: a completed projection tells
        // nobody anything, a failed one is the only evidence of why a price is wrong.
        removeOnFail: { age: 7 * 24 * 3_600 },
      },
    });
  }

  async enqueue(job: ProjectionJob): Promise<void> {
    await this.#queue.add(job.kind, job);
  }

  /** Schedules work for the instant a promotion's window opens or closes. */
  async enqueueAt(job: ProjectionJob, when: Date): Promise<void> {
    const delay = Math.max(0, when.getTime() - Date.now());
    await this.#queue.add(job.kind, job, { delay });
  }

  async close(): Promise<void> {
    await this.#queue.close();
  }
}
