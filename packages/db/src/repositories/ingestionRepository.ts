import type { Db, IngestionJob } from '../index.js';

export interface IngestionProgress {
  readonly job: IngestionJob;
  readonly percentComplete: number;
}

export async function findIngestionJob(db: Db, jobId: string): Promise<IngestionProgress | null> {
  const job = await db
    .selectFrom('ingestion_jobs')
    .selectAll()
    .where('id', '=', jobId)
    .executeTakeFirst();
  if (job === undefined) return null;

  const percentComplete =
    job.chunks_total === 0 ? 0 : Math.round((job.chunks_completed / job.chunks_total) * 100);
  return { job, percentComplete };
}

export async function listIngestionJobs(db: Db, limit: number): Promise<IngestionJob[]> {
  return db
    .selectFrom('ingestion_jobs')
    .selectAll()
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();
}

/**
 * Rejected rows, with the original line kept verbatim.
 *
 * A count of failures tells an operator that something is wrong; the raw line tells them
 * what to ask the vendor to fix. The second is the one that ends the incident.
 */
export async function listIngestionErrors(
  db: Db,
  jobId: string,
  limit: number,
): Promise<{ chunk_index: number; line_number: number | null; raw_line: string | null; reason: string }[]> {
  return db
    .selectFrom('ingestion_row_errors')
    .select(['chunk_index', 'line_number', 'raw_line', 'reason'])
    .where('job_id', '=', jobId)
    .orderBy('id')
    .limit(limit)
    .execute();
}
