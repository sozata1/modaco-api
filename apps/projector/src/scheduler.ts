import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import type { ProjectionJob } from '@modaco/core';
import type { Db, Promotion } from '@modaco/db';
import { findPromotionsCrossingWindow } from '@modaco/db';
import { scheduledWindowJobs } from './metrics.js';

/**
 * Time is the one input to pricing that arrives without a write.
 *
 * A promotion with `startsAt` at 14:00 becomes active at 14:00 whether or not anything
 * touches the system. Nothing fires an event; the projection simply becomes wrong. This
 * scheduler looks a short way ahead, finds the windows about to open or close, and
 * enqueues delayed jobs for those exact instants.
 *
 * Rescanning the same horizon repeatedly is deliberate. Duplicate jobs are harmless —
 * reprojection is idempotent, it recomputes from current state rather than applying a
 * delta — whereas a missed edge leaves a wrong price until the reconciler notices.
 * Cheap duplicates beat rare misses.
 */
export interface SchedulerDeps {
  readonly db: Db;
  readonly queue: Queue<ProjectionJob>;
  readonly logger: Logger;
  readonly horizonMs: number;
}

export function startScheduler(deps: SchedulerDeps): { stop: () => void } {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const until = new Date(now.getTime() + deps.horizonMs);
      const promotions = await findPromotionsCrossingWindow(deps.db, now, until);

      for (const promotion of promotions) {
        const startsAt = new Date(promotion.starts_at);
        const endsAt = new Date(promotion.ends_at);

        if (startsAt >= now && startsAt < until) {
          await enqueueAt(deps, promotion, startsAt, 'promotion.window.opened');
          scheduledWindowJobs.inc({ edge: 'open' });
        }
        if (endsAt >= now && endsAt < until) {
          await enqueueAt(deps, promotion, endsAt, 'promotion.window.closed');
          scheduledWindowJobs.inc({ edge: 'close' });
        }
      }
    } catch (error) {
      deps.logger.error({ err: error }, 'scheduler sweep failed');
    } finally {
      running = false;
    }
  };

  // Scan at half the horizon so every edge is seen at least twice before it arrives.
  const timer = setInterval(() => void tick(), Math.max(5_000, deps.horizonMs / 2));
  void tick();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}

async function enqueueAt(
  deps: SchedulerDeps,
  promotion: Promotion,
  when: Date,
  reason: ProjectionJob['reason'],
): Promise<void> {
  const delay = Math.max(0, when.getTime() - Date.now());

  const job: ProjectionJob | null =
    promotion.target_type === 'category' && promotion.target_category !== null
      ? { kind: 'category', category: promotion.target_category, cursor: null, reason }
      : promotion.target_type === 'product' && promotion.target_product_id !== null
        ? { kind: 'ids', ids: [promotion.target_product_id], reason }
        : null;

  if (job === null) return;

  await deps.queue.add(job.kind, job, {
    delay,
    // A deterministic id collapses the duplicates this scheduler intentionally creates:
    // rescanning the same horizon enqueues the same edge repeatedly, and BullMQ keeps one.
    jobId: `window:${promotion.id}:${reason}:${String(when.getTime())}`,
  });
}
