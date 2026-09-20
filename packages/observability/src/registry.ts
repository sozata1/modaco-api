import { Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Every service gets its own registry rather than sharing prom-client's global default.
 *
 * The global registry is process-wide mutable state: two modules registering the same
 * metric name throw, and tests that import a service twice fail for reasons that have
 * nothing to do with the code under test.
 */
export function createRegistry(serviceName: string): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ register: registry });
  return registry;
}
