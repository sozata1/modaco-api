import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Db } from '@modaco/db';
import {
  findStaleProductIds,
  measureProjectionLagSeconds,
  projectPricesForIds,
} from '@modaco/db';
import { priceProjectionLag } from './metrics.js';

/**
 * The safety net that makes the eventual-consistency promise a budget rather than a hope.
 *
 * Every targeted path can be missed: a worker dies mid-batch, a delayed job is lost when
 * the queue is flushed, a promotion's window closes while nothing is listening. Rather
 * than trying to make each of those paths infallible, this sweep asks the only question
 * that matters — which products disagree with what the promotion table says right now —
 * and fixes them. Staleness is therefore bounded by the sweep interval regardless of
 * which upstream mechanism failed.
 *
 * It also publishes the lag gauge. An accepted trade-off that nobody measures is not a
 * trade-off, it is a guess.
 */
export interface ReconcilerDeps {
  readonly db: Db;
  readonly cacheRedis: Redis;
  readonly logger: Logger;
  readonly intervalMs: number;
  readonly batchSize: number;
  /** Products examined per sweep. Bounds the cost; see findStaleProductIds. */
  readonly scanWindow: number;
}

export function startReconciler(deps: ReconcilerDeps): { stop: () => void } {
  let running = false;
  /**
   * Where the next sweep resumes. Held in memory: a restart simply begins the pass again,
   * which is the correct behaviour for a safety net — starting over costs one extra pass,
   * whereas persisting a cursor adds state that can itself go stale or wrong.
   */
  let cursor: string | null = null;

  const tick = async (): Promise<void> => {
    // Overlapping sweeps would fight over the same rows; skipping is correct because
    // the next tick re-derives the work from scratch anyway.
    if (running) return;
    running = true;
    try {
      const lag = await measureProjectionLagSeconds(deps.db, deps.scanWindow, cursor);
      priceProjectionLag.set(lag);

      const scan = await findStaleProductIds(deps.db, deps.batchSize, deps.scanWindow, cursor);
      // null means the window ran short, i.e. the table ended — wrap around.
      cursor = scan.nextCursor;

      if (scan.ids.length === 0) return;

      const rows = await projectPricesForIds(deps.db, scan.ids);
      const pipeline = deps.cacheRedis.pipeline();
      for (const row of rows) pipeline.del(`product:${row.id}`);
      await pipeline.exec();

      deps.logger.warn(
        { repaired: rows.length, lagSeconds: Math.round(lag) },
        'reconciler repaired stale price projections',
      );
    } catch (error) {
      deps.logger.error({ err: error }, 'reconciler sweep failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), deps.intervalMs);
  void tick();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
