import { Counter, Gauge } from 'prom-client';
import { createRegistry } from '@modaco/observability';

// The projector owns this gauge, not the API: it is the only service that knows when a
// projection actually caught up, and a metric with two writers has no meaning.
export const registry = createRegistry('projector');

export const priceProjectionLag = new Gauge({
  name: 'price_projection_lag_seconds',
  help: 'Age of the oldest product price projection currently known to be stale',
  registers: [registry],
});

export const projectedProducts = new Counter({
  name: 'projected_products_total',
  help: 'Products whose effective price was recomputed',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const scheduledWindowJobs = new Counter({
  name: 'promotion_window_jobs_total',
  help: 'Reprojection jobs scheduled for promotion windows opening or closing',
  labelNames: ['edge'] as const,
  registers: [registry],
});
