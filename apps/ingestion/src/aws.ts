import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { IngestionConfig } from './config.js';

/**
 * Clients are constructed once per container, outside any handler.
 *
 * Lambda reuses the execution environment between invocations, so anything built at
 * module scope is paid for on a cold start only. Building an S3 client per invocation
 * repeats TLS setup and credential resolution on every message.
 */
export function createS3(config: IngestionConfig): S3Client {
  return new S3Client({
    region: config.AWS_REGION,

    /**
     * Required because every read this service performs is a RANGED read.
     *
     * The SDK validates response checksums by default. S3 stores a checksum of the
     * WHOLE object, so on a partial read the SDK compares the whole-object checksum
     * against the bytes of one slice and fails:
     *
     *   Checksum mismatch: expected "wkL/cQ==" but received "xLGsng==" in
     *   response header "x-amz-checksum-crc32"
     *
     * There is nothing to fix in the data — a whole-object checksum simply cannot
     * validate a fragment. WHEN_REQUIRED keeps validation for the operations where it
     * is meaningful and skips it where it is arithmetically impossible.
     *
     * Found by running a real 500K-row file through the pipeline; no amount of reading
     * the code would have surfaced it.
     */
    responseChecksumValidation: 'WHEN_REQUIRED',

    ...(config.AWS_ENDPOINT_URL !== undefined
      ? // LocalStack needs path-style addressing; virtual-host style would resolve
        // bucket names as real DNS.
        { endpoint: config.AWS_ENDPOINT_URL, forcePathStyle: true }
      : {}),
  });
}

export function createSQS(config: IngestionConfig): SQSClient {
  return new SQSClient({
    region: config.AWS_REGION,
    ...(config.AWS_ENDPOINT_URL !== undefined ? { endpoint: config.AWS_ENDPOINT_URL } : {}),
  });
}
