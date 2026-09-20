#!/bin/bash
# Runs once LocalStack is ready: S3 bucket, both SQS queues, a DLQ, and the bucket
# notification that ties them together.
#
# The flow this builds is the real AWS one, not an approximation of it:
#
#   PUT s3://bucket/feed.csv
#        -> (bucket notification)  -> sqs:modaco-splitter  -> splitter   -> byte ranges
#        -> sqs:modaco-ingestion   -> worker (xN)          -> PostgreSQL
#
# Nothing in the application triggers the split. Uploading the object is the trigger,
# exactly as it would be in production.
set -euo pipefail

BUCKET="${S3_BUCKET:-modaco-vendor-feeds}"
QUEUE="${SQS_INGESTION_QUEUE:-modaco-ingestion}"
DLQ="${SQS_INGESTION_DLQ:-modaco-ingestion-dlq}"
SPLIT_QUEUE="${SQS_SPLITTER_QUEUE:-modaco-splitter}"

awslocal s3 mb "s3://${BUCKET}" 2>/dev/null || true

DLQ_URL=$(awslocal sqs create-queue --queue-name "${DLQ}" --output text --query QueueUrl)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "${DLQ_URL}" \
  --attribute-names QueueArn --output text --query 'Attributes.QueueArn')

# VisibilityTimeout (900s) must exceed the worker's maximum runtime (Lambda timeout is
# 300s). Otherwise a message is redelivered while it is still being processed and the
# work happens twice.
# maxReceiveCount=3 sends a permanently malformed message to the DLQ instead of letting
# it loop forever.
awslocal sqs create-queue --queue-name "${QUEUE}" --attributes "$(cat <<JSON
{
  "VisibilityTimeout": "900",
  "MessageRetentionPeriod": "1209600",
  "ReceiveMessageWaitTimeSeconds": "20",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${DLQ_ARN}\",\"maxReceiveCount\":\"3\"}"
}
JSON
)" >/dev/null

SPLIT_URL=$(awslocal sqs create-queue --queue-name "${SPLIT_QUEUE}" \
  --attributes '{"VisibilityTimeout":"300","ReceiveMessageWaitTimeSeconds":"20"}' \
  --output text --query QueueUrl)
SPLIT_ARN=$(awslocal sqs get-queue-attributes --queue-url "${SPLIT_URL}" \
  --attribute-names QueueArn --output text --query 'Attributes.QueueArn')

awslocal s3api put-bucket-notification-configuration --bucket "${BUCKET}" \
  --notification-configuration "$(cat <<JSON
{
  "QueueConfigurations": [
    { "QueueArn": "${SPLIT_ARN}", "Events": ["s3:ObjectCreated:*"] }
  ]
}
JSON
)"

echo "[bootstrap] s3://${BUCKET} -> sqs:${SPLIT_QUEUE} -> sqs:${QUEUE} (+DLQ) ready"
