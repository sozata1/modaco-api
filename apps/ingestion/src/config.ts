import { z } from 'zod';

const EnvSchema = z.object({
  SERVICE_NAME: z.string().default('ingestion'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

  DATABASE_URL: z.string().min(1),
  /**
   * Deliberately 1-2. This is the setting that decides whether a 30-way fan-out takes
   * the API down with it: 30 workers times a 20-connection pool is 600 connections
   * against a max_connections of 100. PgBouncer absorbs the rest. See ADR-005.
   */
  DB_POOL_MAX: z.coerce.number().int().positive().default(2),

  AWS_REGION: z.string().default('eu-central-1'),
  AWS_ENDPOINT_URL: z.string().optional(),
  S3_BUCKET: z.string().default('modaco-vendor-feeds'),
  SQS_INGESTION_QUEUE: z.string().default('modaco-ingestion'),

  INGESTION_CHUNK_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),
  INGESTION_UPSERT_BATCH: z.coerce.number().int().positive().default(1_000),
  INGESTION_CONTINUATION_THRESHOLD_MS: z.coerce.number().int().positive().default(30_000),
  /**
   * How far past its range a worker may read to finish the line it owns. A row is
   * ~120 bytes, so 64 KB is thousands of times the worst case — cheap insurance
   * against a pathological row rather than a tuned value.
   */
  INGESTION_LINE_OVERLAP_BYTES: z.coerce.number().int().positive().default(64 * 1024),
});

export type IngestionConfig = Readonly<z.infer<typeof EnvSchema>>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IngestionConfig {
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
