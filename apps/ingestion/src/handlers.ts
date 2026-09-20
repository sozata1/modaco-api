import type {
  Context,
  S3Event,
  SQSBatchItemFailure,
  SQSBatchResponse,
  SQSEvent,
} from 'aws-lambda';
import { runWithRequestContext } from '@modaco/observability';
import { parseChunkMessage } from './messages.js';
import { getRuntime } from './runtime.js';
import { splitObjectIntoChunks } from './splitter.js';
import { processChunk } from './worker.js';

/**
 * Real AWS Lambda handler signatures.
 *
 * These deploy to `nodejs22.x` unchanged. Locally they are driven by a small SQS poller
 * (bin/worker-runner.ts) that builds a genuine SQSEvent and Context — the handler is the
 * unit under test, the invoker is swappable. That is why the local setup is a stand-in
 * for the event source mapping rather than a reimplementation of the ingestion logic.
 */

/** Triggered by an S3 ObjectCreated notification. */
export const splitterHandler = async (event: S3Event): Promise<void> => {
  const runtime = getRuntime();
  const queueUrl = await runtime.queueUrl();

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    // S3 percent-encodes object keys in event notifications and turns spaces into '+'.
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    await splitObjectIntoChunks(
      {
        db: runtime.db,
        s3: runtime.s3,
        sqs: runtime.sqs,
        queueUrl,
        logger: runtime.logger,
        chunkBytes: runtime.config.INGESTION_CHUNK_BYTES,
      },
      bucket,
      key,
    );
  }
};

/**
 * Triggered by the SQS event source mapping.
 *
 * Returns partial batch failures rather than throwing. Throwing makes SQS redeliver the
 * WHOLE batch, so one poisoned message drags successfully processed siblings back through
 * the queue — and eventually into the DLQ with them.
 */
export const workerHandler = async (
  event: SQSEvent,
  context: Context,
): Promise<SQSBatchResponse> => {
  const runtime = getRuntime();
  const queueUrl = await runtime.queueUrl();
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    const message = parseChunkMessage(record.body);
    if (message === null) {
      // Unparseable bodies are not retried: three more attempts will not make the JSON
      // valid. Straight to the DLQ where a human can look at it.
      runtime.logger.error({ messageId: record.messageId }, 'discarding unparseable message');
      continue;
    }

    const requestId = message.requestId ?? context.awsRequestId;
    try {
      await runWithRequestContext({ requestId }, async () =>
        processChunk(
          {
            db: runtime.db,
            s3: runtime.s3,
            sqs: runtime.sqs,
            queueUrl,
            logger: runtime.logger,
            upsertBatch: runtime.config.INGESTION_UPSERT_BATCH,
            lineOverlapBytes: runtime.config.INGESTION_LINE_OVERLAP_BYTES,
            continuationThresholdMs: runtime.config.INGESTION_CONTINUATION_THRESHOLD_MS,
            remainingTimeMs: () => context.getRemainingTimeInMillis(),
          },
          message,
        ),
      );
    } catch (error) {
      runtime.logger.error(
        { err: error, jobId: message.jobId, chunkIndex: message.chunkIndex },
        'chunk processing failed',
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
