import { Router } from 'express';
import type pg from 'pg';
import type { Cache } from '../../cache/cache.js';
import { registry } from '../../metrics.js';
import { asyncHandler } from '../middleware/errorHandler.js';

/**
 * Liveness and readiness are separate on purpose.
 *
 * Liveness answers "is this process wedged" — a failure means restart me. Readiness
 * answers "can I serve traffic right now" — a failure means take me out of the pool
 * and leave me alone. Collapsing them into one endpoint turns a brief database blip
 * into a restart storm across every instance at once.
 */
export function healthRoutes(pool: pg.Pool, cache: Cache): Router {
  const router = Router();

  router.get('/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get(
    '/ready',
    asyncHandler(async (_req, res) => {
      const [database, redis] = await Promise.all([
        pool
          .query('SELECT 1')
          .then(() => true)
          .catch(() => false),
        cache.healthy(),
      ]);

      // Redis being down is reported but does not fail readiness: the cache fails open,
      // so the service is still correct — just slower. Refusing traffic here would turn
      // a degradation into an outage.
      const ready = database;
      res.status(ready ? 200 : 503).json({
        status: ready ? 'ok' : 'unavailable',
        checks: { database, redis, redisRequired: false },
      });
    }),
  );

  return router;
}

export function metricsRoute(): Router {
  const router = Router();
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.set('Content-Type', registry.contentType).send(await registry.metrics());
    }),
  );
  return router;
}
