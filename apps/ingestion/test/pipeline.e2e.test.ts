import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * End-to-end against the running Docker stack.
 *
 * The integration suites start their own containers and exercise the code directly. What
 * they cannot reach is everything between the processes: the S3 bucket notification, SQS
 * delivery and redelivery, the worker processes, the BullMQ queue and the projector. Every
 * defect that reached a running system in this project lived in exactly that gap — a
 * checksum failure on ranged reads, a healthcheck that passed before its bootstrap ran, a
 * container that was rebuilt but never recreated. None of them were reachable from a unit
 * or integration test.
 *
 *   docker compose up -d --build
 *   npm run test:e2e
 *
 * Skips itself when the stack is not reachable, so it never fails for someone who has not
 * started it.
 */

const API = process.env['E2E_API'] ?? 'http://localhost:3000';
const S3_ENDPOINT =
  process.env['E2E_S3'] ?? `http://localhost:${process.env['LOCALSTACK_HOST_PORT'] ?? '4566'}`;
const BUCKET = process.env['S3_BUCKET'] ?? 'modaco-vendor-feeds';

const stackUp = await fetch(`${API}/health/ready`)
  .then((r) => r.ok)
  .catch(() => false);

if (!stackUp) {
  console.warn(`\n  e2e skipped — no stack at ${API}. Start it with: docker compose up -d\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ImportJob {
  id: string;
  objectKey: string;
  status: string;
  rows: { upserted: number; rejected: number };
  chunks: { total: number; completed: number };
}

async function json<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`);
  return (await response.json()) as T;
}

async function post(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/** Polls until `predicate` holds, so a test never asserts on a race it started. */
async function until<T>(
  fetcher: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await fetcher();
  while (Date.now() < deadline) {
    if (predicate(last)) return last;
    await sleep(2_000);
    last = await fetcher();
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last).slice(0, 300)}`);
}

describe.skipIf(!stackUp)('Scenario A — the ingestion pipeline, end to end', () => {
  const rowCount = 4_000;
  const corruptEvery = 1_000; // rows 1000, 2000, 3000 -> 3 malformed
  const expectedBad = 3;
  const runId = String(Date.now()).slice(-6);
  // A category of its own, so the assertions below see only this run's rows. Against a
  // catalogue of 500K products a shared category makes "is my row there?" unanswerable
  // without paging through everything.
  const category = `E2EFeed${runId}`;
  const sku = (i: number): string => `E2E-${runId}-${String(i).padStart(5, '0')}`;
  let firstSku = '';
  let objectKey = '';
  let jobId = '';

  beforeAll(async () => {
    const lines = ['sku,name,category,vendor_price,stock'];
    for (let i = 0; i < rowCount; i += 1) {
      if (i > 0 && i % corruptEvery === 0) {
        lines.push(`BAD-${String(i)},missing fields`);
        continue;
      }
      const s = sku(i);
      if (i === 0) firstSku = s;
      lines.push(`${s},E2E Item ${String(i)},${category},${String(10 + (i % 90))}.00,${String(i % 50)}`);
    }

    const s3 = new S3Client({
      region: process.env['AWS_REGION'] ?? 'eu-central-1',
      endpoint: S3_ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });

    objectKey = `e2e/feed-${String(Date.now())}.csv`;
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: objectKey,
        Body: `${lines.join('\n')}\n`,
        ContentType: 'text/csv',
      }),
    );
  }, 120_000);

  it('ingests an uploaded file with no trigger other than the upload', async () => {
    // Nothing in the API was called. The bucket notification starts the pipeline, which is
    // how it behaves in AWS: S3 -> splitter -> SQS -> workers.
    //
    // Matched on objectKey, not "the newest job". Taking data[0] silently matched a
    // PREVIOUS run's job — identical row counts made its assertions pass while this run
    // was still processing, and the failure only surfaced two tests later.
    const job = await until<ImportJob | undefined>(
      async () => {
        const { data } = await json<{ data: ImportJob[] }>('/api/v1/imports');
        return data.find((j) => j.objectKey === objectKey);
      },
      (j) => j !== undefined && (j.status === 'completed' || j.status === 'partial'),
      180_000,
      'this run\'s ingestion job to finish',
    );

    expect(job).toBeDefined();
    jobId = job?.id ?? '';
    expect(job?.chunks.completed).toBe(job?.chunks.total);

    // Malformed rows are recorded and the job continues. 'partial', never 'failed' —
    // three bad rows are not a reason to discard the other 3,997.
    expect(job?.rows.rejected).toBe(expectedBad);
    expect(job?.rows.upserted).toBe(rowCount - expectedBad);
    expect(job?.status).toBe('partial');
  }, 200_000);

  it('records each rejected row with its raw line', async () => {
    expect(jobId).not.toBe('');
    const errors = await json<{ data: { reason: string; raw_line: string }[] }>(
      `/api/v1/imports/${jobId}/errors`,
    );

    expect(errors.data.length).toBe(expectedBad);
    // The count tells an operator something is wrong; the raw line tells them what to ask
    // the vendor to fix.
    expect(errors.data[0]?.raw_line).toContain('missing fields');
  }, 60_000);

  it('applies the dynamic pricing rules to every stored row', async () => {
    const { data } = await json<{ data: { sku: string; basePrice: string }[] }>(
      `/api/v1/products?category=${category}&limit=100&sort=effective_price`,
    );
    const ingested = data.find((p) => p.sku === firstSku);
    expect(ingested).toBeDefined();

    // Vendor price 10.00, default margin 4000 bps -> 14.00, charm rounding -> 14.99.
    // This is the same function the API applies when a product is created by hand: one
    // implementation of the pricing rules, running in two different runtimes.
    expect(ingested?.basePrice).toBe('14.99');
  }, 60_000);
});

describe.skipIf(!stackUp)('Scenario B — a flash sale through the real queue and projector', () => {
  const suffix = String(Date.now()).slice(-6);
  let productId = '';
  let promotionId = '';
  const category = `E2ESale${suffix}`;

  afterAll(async () => {
    if (promotionId) await fetch(`${API}/api/v1/promotions/${promotionId}/cancel`, { method: 'PATCH' });
  });

  it('creates a product at full price', async () => {
    const { status, body } = await post('/api/v1/products', {
      sku: `SALE-${suffix}`, name: 'Sale Item', category, basePrice: '200.00', stockQuantity: 5,
    });
    expect(status).toBe(201);
    const created = (body as { data: { id: string; effectivePrice: string } }).data;
    productId = created.id;
    expect(created.effectivePrice).toBe('200.00');
  }, 60_000);

  it('publishes a category sale and returns before the prices are applied', async () => {
    const draft = await post('/api/v1/promotions', {
      name: `E2E 25% off ${category}`,
      discountType: 'percentage',
      discountValue: 25,
      startsAt: new Date(Date.now() - 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    promotionId = (draft.body as { data: { id: string } }).data.id;

    const assigned = await post(`/api/v1/promotions/${promotionId}/assign`, {
      targetType: 'category', category,
    });

    // 202, not 200: the promotion is durable now, the prices it implies are not yet.
    expect(assigned.status).toBe(202);
    expect((assigned.body as { projection: { status: string } }).projection.status).toBe('pending');
  }, 60_000);

  it('propagates the discount through BullMQ and the projector', async () => {
    const product = await until<{ effectivePrice: string; discounted: boolean }>(
      async () => (await json<{ data: { effectivePrice: string; discounted: boolean } }>(
        `/api/v1/products/${productId}`,
      )).data,
      (p) => p.discounted,
      90_000,
      'the projector to apply the sale',
    );

    expect(product.effectivePrice).toBe('150.00');
  }, 100_000);

  it('restores the base price when the sale is cancelled', async () => {
    await fetch(`${API}/api/v1/promotions/${promotionId}/cancel`, { method: 'PATCH' });
    promotionId = '';

    const product = await until<{ effectivePrice: string; discounted: boolean }>(
      async () => (await json<{ data: { effectivePrice: string; discounted: boolean } }>(
        `/api/v1/products/${productId}`,
      )).data,
      (p) => !p.discounted,
      90_000,
      'the projector to undo the sale',
    );

    expect(product.effectivePrice).toBe('200.00');
  }, 100_000);
});
