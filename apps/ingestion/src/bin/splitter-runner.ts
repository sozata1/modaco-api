import { DeleteMessageCommand, GetQueueUrlCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import type { S3Event } from 'aws-lambda';
import { splitterHandler } from '../handlers.js';
import { getRuntime } from '../runtime.js';

/**
 * Drives the splitter from S3 bucket notifications.
 *
 * In AWS this process does not exist: the bucket notification invokes the Lambda
 * directly. Locally, LocalStack delivers the same notification to SQS and this poller
 * hands it to the same handler. The message body S3 sends is already an S3Event, so
 * nothing is translated or faked — it is forwarded.
 */
const runtime = getRuntime();
const QUEUE_NAME = process.env['SQS_SPLITTER_QUEUE'] ?? 'modaco-splitter';

let running = true;

async function poll(): Promise<void> {
  const { QueueUrl } = await runtime.sqs.send(new GetQueueUrlCommand({ QueueName: QUEUE_NAME }));
  const queueUrl = QueueUrl ?? '';
  runtime.logger.info({ queueUrl }, 'splitter polling for bucket notifications');

  while (running) {
    const received = await runtime.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
      }),
    );

    for (const message of received.Messages ?? []) {
      try {
        const event = JSON.parse(message.Body ?? '{}') as S3Event;
        if (Array.isArray(event.Records) && event.Records.length > 0) {
          await splitterHandler(event);
        }
        await runtime.sqs.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
        );
      } catch (error) {
        // Left undeleted on purpose: the visibility timeout returns it for another
        // attempt rather than losing the notification.
        runtime.logger.error({ err: error }, 'failed to split object, message will be retried');
      }
    }
  }
}

const stop = (signal: string): void => {
  runtime.logger.info({ signal }, 'splitter stopping');
  running = false;
};
process.on('SIGTERM', () => {
  stop('SIGTERM');
});
process.on('SIGINT', () => {
  stop('SIGINT');
});

poll().catch((error: unknown) => {
  runtime.logger.fatal({ err: error }, 'splitter crashed');
  process.exit(1);
});
