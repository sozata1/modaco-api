import { HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { Logger } from 'pino';
import type { Db } from '@modaco/db';
import type { ChunkMessage } from './messages.js';

/**
 * Scenario A, step one — and the step that makes the rest possible.
 *
 * This function NEVER OPENS THE FILE. It asks S3 for the object's size, divides that
 * number into byte ranges, and enqueues one small message per range. Its runtime is
 * independent of the file: 500K rows and 50M rows both take about 200ms.
 *
 * That is the difference between mitigating the serverless timeout and eliminating it.
 * An orchestrator that streams the file to split it is still reading 60MB inside one
 * invocation — it has moved the risk, not removed it. Here there is no amount of data
 * that can make this step time out, because the data is never touched.
 */
export interface SplitResult {
  readonly jobId: string;
  readonly chunksTotal: number;
  readonly fileSizeBytes: number;
  readonly alreadyExisted: boolean;
}

export interface SplitterDeps {
  readonly db: Db;
  readonly s3: S3Client;
  readonly sqs: SQSClient;
  readonly queueUrl: string;
  readonly logger: Logger;
  readonly chunkBytes: number;
}

export async function splitObjectIntoChunks(
  deps: SplitterDeps,
  bucket: string,
  key: string,
  requestId?: string,
): Promise<SplitResult> {
  const head = await deps.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const fileSizeBytes = head.ContentLength ?? 0;
  if (fileSizeBytes === 0) throw new Error(`Object s3://${bucket}/${key} is empty`);

  // ETag plus size identifies the exact bytes. Re-notification of the same upload — S3
  // event delivery is at-least-once too — must reuse the job, not start a second one.
  const idempotencyKey = `${bucket}/${key}:${head.ETag ?? 'no-etag'}:${String(fileSizeBytes)}`;

  const ranges = computeByteRanges(fileSizeBytes, deps.chunkBytes);

  const { jobId, alreadyExisted } = await deps.db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('ingestion_jobs')
      .select(['id'])
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (existing !== undefined) return { jobId: existing.id, alreadyExisted: true };

    const job = await trx
      .insertInto('ingestion_jobs')
      .values({
        idempotency_key: idempotencyKey,
        bucket,
        object_key: key,
        file_size_bytes: fileSizeBytes,
        chunks_total: ranges.length,
        status: 'processing',
        started_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('ingestion_chunks')
      .values(
        ranges.map((range, index) => ({
          job_id: job.id,
          chunk_index: index,
          start_byte: range.start,
          end_byte: range.end,
        })),
      )
      .execute();

    return { jobId: job.id, alreadyExisted: false };
  });

  if (alreadyExisted) {
    deps.logger.info({ jobId, idempotencyKey }, 'ingestion job already exists, skipping split');
    return { jobId, chunksTotal: ranges.length, fileSizeBytes, alreadyExisted: true };
  }

  const messages: ChunkMessage[] = ranges.map((range, index) => ({
    jobId,
    chunkIndex: index,
    bucket,
    key,
    startByte: range.start,
    endByte: range.end,
    ...(requestId !== undefined ? { requestId } : {}),
  }));

  // SQS caps a batch at 10 entries, so this is the API's limit rather than a tuning choice.
  for (let i = 0; i < messages.length; i += 10) {
    const slice = messages.slice(i, i + 10);
    await deps.sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: deps.queueUrl,
        Entries: slice.map((message) => ({
          Id: String(message.chunkIndex),
          MessageBody: JSON.stringify(message),
        })),
      }),
    );
  }

  deps.logger.info(
    { jobId, chunksTotal: ranges.length, fileSizeBytes, bucket, key },
    'split object into chunks',
  );
  return { jobId, chunksTotal: ranges.length, fileSizeBytes, alreadyExisted: false };
}

export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/** Pure arithmetic over the file size — the whole reason this step cannot time out. */
export function computeByteRanges(fileSizeBytes: number, chunkBytes: number): ByteRange[] {
  const ranges: ByteRange[] = [];
  for (let start = 0; start < fileSizeBytes; start += chunkBytes) {
    ranges.push({ start, end: Math.min(start + chunkBytes, fileSizeBytes) });
  }
  return ranges;
}
