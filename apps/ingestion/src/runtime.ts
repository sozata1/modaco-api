import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import type { S3Client } from '@aws-sdk/client-s3';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { Logger } from 'pino';
import { createLogger } from '@modaco/observability';
import { createDb, createPool, type Db } from '@modaco/db';
import type pg from 'pg';
import { createS3, createSQS } from './aws.js';
import { loadConfig, type IngestionConfig } from './config.js';

/**
 * Built once at module scope and reused across invocations.
 *
 * Lambda freezes and thaws the execution environment rather than tearing it down, so a
 * connection pool created here survives between messages. Creating one per invocation
 * would open a fresh PostgreSQL connection for every chunk — exactly the connection
 * storm the design sets out to avoid.
 */
export interface Runtime {
  readonly config: IngestionConfig;
  readonly logger: Logger;
  readonly pool: pg.Pool;
  readonly db: Db;
  readonly s3: S3Client;
  readonly sqs: SQSClient;
  queueUrl(): Promise<string>;
}

let cached: Runtime | null = null;

export function getRuntime(): Runtime {
  if (cached !== null) return cached;

  const config = loadConfig();
  const logger = createLogger({
    level: config.LOG_LEVEL,
    serviceName: config.SERVICE_NAME,
    pretty: config.LOG_PRETTY,
  });
  const pool = createPool({
    connectionString: config.DATABASE_URL,
    maxConnections: config.DB_POOL_MAX,
    applicationName: 'modaco-ingestion',
  });
  const s3 = createS3(config);
  const sqs = createSQS(config);

  let resolvedQueueUrl: string | null = null;

  cached = {
    config,
    logger,
    pool,
    db: createDb(pool),
    s3,
    sqs,
    async queueUrl(): Promise<string> {
      if (resolvedQueueUrl !== null) return resolvedQueueUrl;
      const result = await sqs.send(
        new GetQueueUrlCommand({ QueueName: config.SQS_INGESTION_QUEUE }),
      );
      resolvedQueueUrl = result.QueueUrl ?? '';
      return resolvedQueueUrl;
    },
  };
  return cached;
}
