import { DeleteMessageBatchCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import type { Context, SQSEvent, SQSRecord } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { workerHandler } from '../handlers.js';
import { getRuntime } from '../runtime.js';

/**
 * The local stand-in for an SQS event source mapping.
 *
 * AWS runs a poller that receives messages, invokes the function, and deletes whatever
 * the function did not report as failed. This is that poller, and nothing more — the
 * handler it calls is the same code that deploys to Lambda, invoked through the same
 * SQSEvent and Context. No ingestion logic lives here.
 *
 * Running `docker compose up --scale ingestion-worker=N` is the local equivalent of
 * Lambda reserved concurrency, which is how the fan-out is exercised.
 */

const runtime = getRuntime();
const LAMBDA_TIMEOUT_MS = 300_000; // matches a typical Lambda configuration
const BATCH_SIZE = 1; // one chunk per invocation, as the event source mapping is configured

function makeContext(deadline: number): Context {
  return {
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'modaco-ingestion-worker',
    functionVersion: '$LATEST',
    invokedFunctionArn: 'arn:aws:lambda:local:000000000000:function:modaco-ingestion-worker',
    memoryLimitInMB: '512',
    awsRequestId: randomUUID(),
    logGroupName: '/aws/lambda/modaco-ingestion-worker',
    logStreamName: 'local',
    // The one part of Context the worker genuinely depends on: it is what drives the
    // continuation handoff when a chunk is too large to finish in one invocation.
    getRemainingTimeInMillis: () => Math.max(0, deadline - Date.now()),
    done: () => undefined,
    fail: () => undefined,
    succeed: () => undefined,
  };
}

function toSqsRecord(messageId: string, receiptHandle: string, body: string): SQSRecord {
  return {
    messageId,
    receiptHandle,
    body,
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: String(Date.now()),
      SenderId: 'local',
      ApproximateFirstReceiveTimestamp: String(Date.now()),
    },
    messageAttributes: {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:local:000000000000:modaco-ingestion',
    awsRegion: runtime.config.AWS_REGION,
  };
}

let running = true;

async function poll(): Promise<void> {
  const queueUrl = await runtime.queueUrl();
  runtime.logger.info({ queueUrl }, 'ingestion worker polling');

  while (running) {
    const received = await runtime.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: BATCH_SIZE,
        WaitTimeSeconds: 20, // long polling: no busy loop, no per-request cost
        VisibilityTimeout: 900,
      }),
    );

    const messages = received.Messages ?? [];
    if (messages.length === 0) continue;

    const records = messages.map((message) =>
      toSqsRecord(message.MessageId ?? '', message.ReceiptHandle ?? '', message.Body ?? ''),
    );
    const event: SQSEvent = { Records: records };

    const response = await workerHandler(event, makeContext(Date.now() + LAMBDA_TIMEOUT_MS));
    const failed = new Set(response.batchItemFailures.map((f) => f.itemIdentifier));

    // Delete exactly what succeeded. Failures stay invisible until the visibility timeout
    // lapses, then return for another attempt, then land in the DLQ after maxReceiveCount.
    const toDelete = messages.filter((message) => !failed.has(message.MessageId ?? ''));
    if (toDelete.length > 0) {
      await runtime.sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: toDelete.map((message, index) => ({
            Id: String(index),
            ReceiptHandle: message.ReceiptHandle ?? '',
          })),
        }),
      );
    }
  }
}

const shutdown = (signal: string): void => {
  runtime.logger.info({ signal }, 'ingestion worker stopping after current batch');
  running = false;
};
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});

poll().catch((error: unknown) => {
  runtime.logger.fatal({ err: error }, 'ingestion worker crashed');
  process.exit(1);
});
