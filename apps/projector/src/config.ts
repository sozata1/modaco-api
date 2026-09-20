import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().default('projector'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.string().min(1),
  REDIS_QUEUE_URL: z.string().min(1),

  PROJECTION_BATCH_SIZE: z.coerce.number().int().positive().default(5_000),
  PROJECTION_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * Products the reconciler examines per sweep. This is the dial between cost per sweep
   * and time to full coverage. Measured against 500K products, one sweep per minute:
   *
   *    20,000  ->   222 ms/sweep   25 min coverage   0.4% duty cycle
   *   100,000  -> 1,213 ms/sweep    5 min coverage   2.0%   <- default
   *   250,000  -> 3,707 ms/sweep    2 min coverage   6.2%
   *
   * For comparison, the original unbounded sweep cost ~9.1 s every minute — a 15% duty
   * cycle, and rising with the catalogue.
   */
  PROJECTION_SCAN_WINDOW: z.coerce.number().int().positive().default(100_000),
  /** How far ahead the scheduler looks for promotion windows opening or closing. */
  PROJECTION_SCHEDULE_HORIZON_MS: z.coerce.number().int().positive().default(120_000),
  PROJECTION_CONCURRENCY: z.coerce.number().int().positive().default(4),
});

export type ProjectorConfig = Readonly<z.infer<typeof EnvSchema>>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProjectorConfig {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration:\n${result.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  return Object.freeze(result.data);
}
