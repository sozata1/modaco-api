import { Counter, Gauge, Histogram } from 'prom-client';
import { createRegistry } from '@modaco/observability';

export const registry = createRegistry('api');

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  // Buckets are tightened at the low end on purpose: the interesting question for
  // GET /products/:id is whether we are at 2ms or 20ms, not 2s or 5s.
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const cacheHits = new Counter({
  name: 'cache_hits_total',
  help: 'Cache hits',
  labelNames: ['cache'] as const,
  registers: [registry],
});

export const cacheMisses = new Counter({
  name: 'cache_misses_total',
  help: 'Cache misses',
  labelNames: ['cache'] as const,
  registers: [registry],
});

/**
 * Cache errors are counted rather than raised: the cache fails open to the database.
 * Without this counter a degraded Redis is invisible — the API keeps returning 200s
 * while quietly serving every request from PostgreSQL.
 */
export const cacheErrors = new Counter({
  name: 'cache_errors_total',
  help: 'Cache operations that failed and fell through to the database',
  labelNames: ['operation'] as const,
  registers: [registry],
});

export const dbPoolWaiting = new Gauge({
  name: 'pg_pool_waiting_count',
  help: 'Requests queued waiting for a database connection',
  registers: [registry],
});

export const dbPoolTotal = new Gauge({
  name: 'pg_pool_total_count',
  help: 'Total connections held by the pool',
  registers: [registry],
});
