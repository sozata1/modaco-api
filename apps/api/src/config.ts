import { z } from 'zod';

/**
 * Environment is parsed once, at startup, and fails loudly.
 *
 * A missing DATABASE_URL should stop the process immediately, not surface as a
 * confusing connection error under load an hour later. Everything downstream can
 * then treat config as a plain, fully-typed value.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().default('api'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // Log format is decoupled from NODE_ENV on purpose. Tying them means a container
  // running with NODE_ENV=development crashes on a transport that only exists in dev
  // dependencies — and it also denies you JSON logs while debugging locally.
  LOG_PRETTY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),

  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  REDIS_QUEUE_URL: z.string().min(1, 'REDIS_QUEUE_URL is required'),
  CACHE_PRODUCT_TTL: z.coerce.number().int().positive().default(60),
  CACHE_LIST_TTL: z.coerce.number().int().positive().default(30),
  CACHE_NEGATIVE_TTL: z.coerce.number().int().positive().default(10),

  AWS_REGION: z.string().default('eu-central-1'),
  AWS_ENDPOINT_URL: z.string().optional(),
  S3_BUCKET: z.string().default('modaco-vendor-feeds'),
  SQS_INGESTION_QUEUE: z.string().default('modaco-ingestion'),
  INGESTION_CHUNK_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),

  PROJECTION_BATCH_SIZE: z.coerce.number().int().positive().default(5_000),

  // Measurement routes. Off unless explicitly enabled; they bypass the cache by design
  // and have no place in a deployed service.
  ENABLE_BENCH_ROUTES: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

export type Config = Readonly<z.infer<typeof EnvSchema>>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return Object.freeze(result.data);
}
