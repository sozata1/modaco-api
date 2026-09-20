import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import { DEFAULT_PRICING_POLICY, applyDynamicPricing, parseCents } from '@modaco/core';
import type { Db } from '@modaco/db';
import { projectPricesForIds } from '@modaco/db';
import { iterateOwnedLines, parseVendorLine } from './csv.js';
import type { ChunkMessage } from './messages.js';
import { dedupeBySku, upsertProducts, type UpsertRow } from './upsert.js';

export interface WorkerDeps {
  readonly db: Db;
  readonly s3: S3Client;
  readonly sqs: SQSClient;
  readonly queueUrl: string;
  readonly logger: Logger;
  readonly upsertBatch: number;
  readonly lineOverlapBytes: number;
  readonly continuationThresholdMs: number;
  /** Mirrors Lambda's Context.getRemainingTimeInMillis. */
  readonly remainingTimeMs: () => number;
}

export interface ChunkResult {
  readonly skipped: boolean;
  readonly rowsUpserted: number;
  readonly rowsRejected: number;
  readonly continued: boolean;
}

export async function processChunk(
  deps: WorkerDeps,
  message: ChunkMessage,
): Promise<ChunkResult> {
  // LAYER 2 OF 3 for idempotency. SQS redelivery is a guarantee, not a hazard to hedge
  // against: a visibility timeout can lapse, a batch can be retried, a worker can die
  // after committing but before deleting. A chunk already marked complete is a no-op, so
  // the counters cannot be double-incremented.
  // (Layer 1 is ON CONFLICT in the upsert; layer 3 is the job's idempotency key.)
  const claimed = await deps.db
    .updateTable('ingestion_chunks')
    .set({ status: 'processing', attempts: sql`attempts + 1` })
    .where('job_id', '=', message.jobId)
    .where('chunk_index', '=', message.chunkIndex)
    .where('status', '!=', 'completed')
    .returning(['start_byte', 'end_byte'])
    .executeTakeFirst();

  if (claimed === undefined) {
    deps.logger.info(
      { jobId: message.jobId, chunkIndex: message.chunkIndex },
      'chunk already completed, ignoring redelivery',
    );
    return { skipped: true, rowsUpserted: 0, rowsRejected: 0, continued: false };
  }

  const { buffer, includesPrecedingByte } = await readRange(deps, message);
  const view = {
    buffer,
    includesPrecedingByte,
    ownedLength: message.endByte - message.startByte,
    isFirstChunk: message.startByte === 0,
  };

  const pending: UpsertRow[] = [];
  const rejections: { line: number; raw: string; reason: string }[] = [];
  let rowsUpserted = 0;
  let lineNumber = 0;
  let lastOwnedOffset = 0;
  let continued = false;

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const deduped = dedupeBySku(pending);
    const ids = await upsertProducts(deps.db, deduped);
    // Every ingested row gets its effective price resolved immediately: a product that
    // lands during an active flash sale must not sit at full price until a sweep notices.
    await projectPricesForIds(deps.db, ids);
    rowsUpserted += ids.length;
    pending.length = 0;
  };

  for (const line of iterateOwnedLines(view)) {
    lineNumber += 1;
    lastOwnedOffset = line.offset;

    const raw = parseVendorLine(line.text);
    if (raw === null) {
      rejections.push({ line: lineNumber, raw: line.text, reason: 'malformed CSV row' });
      continue;
    }

    let vendorPriceCents: number;
    try {
      vendorPriceCents = parseCents(raw.vendorPrice);
    } catch {
      rejections.push({ line: lineNumber, raw: line.text, reason: 'invalid vendor price' });
      continue;
    }

    // The case requires every record to pass the internal pricing rules before it is
    // saved. This is the identical function the API uses — one implementation, two
    // runtimes (see ADR-009).
    const priced = applyDynamicPricing(
      {
        sku: raw.sku,
        name: raw.name,
        category: raw.category,
        vendorPriceCents,
        stockQuantity: Number(raw.stock),
      },
      DEFAULT_PRICING_POLICY,
    );

    if (!priced.ok) {
      rejections.push({ line: lineNumber, raw: line.text, reason: priced.reason });
      continue;
    }

    pending.push({
      sku: raw.sku,
      name: raw.name,
      category: raw.category,
      basePriceCents: priced.basePriceCents,
      stockQuantity: Number(raw.stock),
    });

    if (pending.length >= deps.upsertBatch) {
      await flush();

      // THE ANSWER TO "without the process being cut off midway".
      // Rather than hoping a chunk fits the timeout, the worker watches its own clock and
      // hands the remainder to a fresh invocation while it still has time to commit
      // cleanly. Work already done is durable; nothing is reprocessed and nothing is lost.
      if (deps.remainingTimeMs() < deps.continuationThresholdMs) {
        await enqueueContinuation(deps, message, message.startByte + lastOwnedOffset + 1);
        continued = true;
        break;
      }
    }
  }

  if (!continued) await flush();
  if (rejections.length > 0) await recordRejections(deps, message, rejections);

  await completeChunk(deps, message, rowsUpserted, rejections.length);

  deps.logger.info(
    {
      jobId: message.jobId,
      chunkIndex: message.chunkIndex,
      rowsUpserted,
      rowsRejected: rejections.length,
      continued,
    },
    'chunk processed',
  );

  return { skipped: false, rowsUpserted, rowsRejected: rejections.length, continued };
}

/**
 * Reads this chunk's slice, one byte before it, and a small overlap after it.
 *
 * The trailing overlap lets the worker finish the last line it owns. The single leading
 * byte tells it whether its range begins on a line start or mid-line — without that byte
 * the two are indistinguishable and a clean boundary silently loses a row (see ChunkView).
 *
 * Peak memory is the chunk size, not the file size, which is what keeps a 500K-row file
 * inside a 512MB function.
 */
async function readRange(
  deps: WorkerDeps,
  message: ChunkMessage,
): Promise<{ buffer: Buffer; includesPrecedingByte: boolean }> {
  const includesPrecedingByte = message.startByte > 0;
  const rangeStart = includesPrecedingByte ? message.startByte - 1 : 0;
  const rangeEnd = message.endByte + deps.lineOverlapBytes - 1;

  const response = await deps.s3.send(
    new GetObjectCommand({
      Bucket: message.bucket,
      Key: message.key,
      Range: `bytes=${String(rangeStart)}-${String(rangeEnd)}`,
    }),
  );
  const bytes = await response.Body?.transformToByteArray();
  return {
    buffer: bytes === undefined ? Buffer.alloc(0) : Buffer.from(bytes),
    includesPrecedingByte,
  };
}

/**
 * Allocates a new chunk for the unprocessed remainder and enqueues it.
 *
 * The new chunk is a real row, so job accounting stays consistent: `chunks_total` grows
 * with it and the job only completes when the continuation completes too.
 */
async function enqueueContinuation(
  deps: WorkerDeps,
  message: ChunkMessage,
  resumeFromByte: number,
): Promise<void> {
  const nextIndex = await deps.db.transaction().execute(async (trx) => {
    const job = await trx
      .updateTable('ingestion_jobs')
      .set({ chunks_total: sql`chunks_total + 1` })
      .where('id', '=', message.jobId)
      .returning('chunks_total')
      .executeTakeFirstOrThrow();

    const index = job.chunks_total - 1;
    await trx
      .insertInto('ingestion_chunks')
      .values({
        job_id: message.jobId,
        chunk_index: index,
        start_byte: resumeFromByte,
        end_byte: message.endByte,
      })
      .execute();
    return index;
  });

  const continuation: ChunkMessage = {
    ...message,
    chunkIndex: nextIndex,
    startByte: resumeFromByte,
  };
  await deps.sqs.send(
    new SendMessageCommand({
      QueueUrl: deps.queueUrl,
      MessageBody: JSON.stringify(continuation),
    }),
  );

  deps.logger.warn(
    { jobId: message.jobId, from: message.chunkIndex, to: nextIndex, resumeFromByte },
    'approaching timeout, handed remainder to a new invocation',
  );
}

async function recordRejections(
  deps: WorkerDeps,
  message: ChunkMessage,
  rejections: readonly { line: number; raw: string; reason: string }[],
): Promise<void> {
  await deps.db
    .insertInto('ingestion_row_errors')
    .values(
      rejections.slice(0, 1_000).map((rejection) => ({
        job_id: message.jobId,
        chunk_index: message.chunkIndex,
        line_number: rejection.line,
        raw_line: rejection.raw.slice(0, 2_000),
        reason: rejection.reason,
      })),
    )
    .execute();
}

/**
 * Marks the chunk done and rolls its totals into the job.
 *
 * `chunks_completed + 1` rather than read-then-write: dozens of workers update this row
 * concurrently, and a read-modify-write would lose increments under exactly the load the
 * design is built for.
 */
async function completeChunk(
  deps: WorkerDeps,
  message: ChunkMessage,
  rowsUpserted: number,
  rowsRejected: number,
): Promise<void> {
  await deps.db.transaction().execute(async (trx) => {
    await trx
      .updateTable('ingestion_chunks')
      .set({
        status: 'completed',
        rows_upserted: rowsUpserted,
        rows_rejected: rowsRejected,
        completed_at: new Date(),
      })
      .where('job_id', '=', message.jobId)
      .where('chunk_index', '=', message.chunkIndex)
      .execute();

    await trx
      .updateTable('ingestion_jobs')
      .set({
        chunks_completed: sql`chunks_completed + 1`,
        rows_upserted: sql`rows_upserted + ${rowsUpserted}`,
        rows_rejected: sql`rows_rejected + ${rowsRejected}`,
      })
      .where('id', '=', message.jobId)
      .execute();

    // A file with some bad rows is 'partial', not 'failed'. Twelve malformed rows out of
    // 500K is an operator's to-do list, not a reason to discard the other 499,988.
    await sql`
      UPDATE ingestion_jobs
         SET status = CASE WHEN rows_rejected > 0 THEN 'partial' ELSE 'completed' END,
             completed_at = NOW()
       WHERE id = ${message.jobId}
         AND chunks_completed >= chunks_total
         AND status = 'processing'
    `.execute(trx);
  });
}
