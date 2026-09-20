import { Router } from 'express';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';
import { NotFoundError } from '@modaco/core';
import type { Db } from '@modaco/db';
import { findIngestionJob, listIngestionErrors, listIngestionJobs } from '@modaco/db';
import { asyncHandler } from '../middleware/errorHandler.js';

const UploadUrlBody = z.object({
  fileName: z.string().min(1).max(200).regex(/^[\w.-]+$/, 'Invalid file name'),
});
const JobIdParam = z.object({ jobId: z.string().uuid() });

/**
 * The API never touches the file's bytes.
 *
 * A 500K-row feed is ~60MB. Streaming that through the API would tie up a request
 * worker, consume its memory, and put a size limit on vendor feeds for no benefit — the
 * API has nothing to do with the content. It issues a presigned URL, the vendor uploads
 * straight to S3, and the bucket notification starts the pipeline. The API's only role
 * afterwards is reporting progress.
 */
export function importRoutes(db: Db, s3: S3Client, bucket: string): Router {
  const router = Router();

  router.post(
    '/upload-url',
    asyncHandler(async (req, res) => {
      const { fileName } = UploadUrlBody.parse(req.body);
      const objectKey = `feeds/${new Date().toISOString().slice(0, 10)}/${Date.now().toString()}-${fileName}`;

      const url = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: bucket, Key: objectKey, ContentType: 'text/csv' }),
        { expiresIn: 900 },
      );

      res.status(201).json({
        data: {
          uploadUrl: url,
          objectKey,
          bucket,
          expiresInSeconds: 900,
          note: 'PUT the CSV to uploadUrl. Ingestion starts from the bucket notification; poll GET /api/v1/imports for the job.',
        },
      });
    }),
  );

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const jobs = await listIngestionJobs(db, 20);
      res.json({ data: jobs.map(summarise) });
    }),
  );

  router.get(
    '/:jobId',
    asyncHandler(async (req, res) => {
      const { jobId } = JobIdParam.parse(req.params);
      const progress = await findIngestionJob(db, jobId);
      if (progress === null) {
        throw new NotFoundError(`Ingestion job ${jobId} was not found`, { jobId });
      }
      res.json({
        data: { ...summarise(progress.job), percentComplete: progress.percentComplete },
      });
    }),
  );

  router.get(
    '/:jobId/errors',
    asyncHandler(async (req, res) => {
      const { jobId } = JobIdParam.parse(req.params);
      res.json({ data: await listIngestionErrors(db, jobId, 200) });
    }),
  );

  return router;
}

function summarise(job: {
  id: string;
  object_key: string;
  file_size_bytes: number;
  status: string;
  chunks_total: number;
  chunks_completed: number;
  rows_upserted: number;
  rows_rejected: number;
  started_at: unknown;
  completed_at: unknown;
}): Record<string, unknown> {
  return {
    id: job.id,
    objectKey: job.object_key,
    fileSizeBytes: job.file_size_bytes,
    status: job.status,
    chunks: { total: job.chunks_total, completed: job.chunks_completed },
    rows: { upserted: job.rows_upserted, rejected: job.rows_rejected },
    startedAt: job.started_at,
    completedAt: job.completed_at,
  };
}
