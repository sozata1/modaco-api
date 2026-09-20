/**
 * Generates a vendor feed and uploads it to S3.
 *
 * Written as a stream rather than a string: a 500K-row file is ~60MB, and building that
 * in memory to then upload it would be the very mistake this system is designed to avoid.
 *
 *   npm run feed -- 500000
 */
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const CATEGORIES = ['Accessories', 'Shoes', 'Outerwear', 'Basics', 'Denim', 'Knitwear'];
const rowCount = Number(process.argv[2] ?? 500_000);
/** Deliberately malformed rows, to prove a bad row does not fail the job. */
const corruptEvery = Number(process.argv[3] ?? 50_000);

function* rows(): Generator<string> {
  yield 'sku,name,category,vendor_price,stock\n';
  for (let i = 0; i < rowCount; i += 1) {
    if (corruptEvery > 0 && i > 0 && i % corruptEvery === 0) {
      yield `BAD-${String(i)},missing fields\n`;
      continue;
    }
    const category = CATEGORIES[i % CATEGORIES.length] ?? 'Basics';
    const price = (500 + ((i * 37) % 250_000)) / 100;
    yield `VND-${String(i).padStart(7, '0')},Vendor Item ${String(i)},${category},${price.toFixed(2)},${String(i % 500)}\n`;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'modaco-feed-'));
const filePath = join(dir, `vendor-feed-${String(rowCount)}.csv`);

console.log(`Generating ${rowCount.toLocaleString()} rows -> ${filePath}`);
const startedAt = Date.now();
await pipeline(Readable.from(rows()), createWriteStream(filePath));

const { size } = statSync(filePath);
console.log(
  `Generated ${(size / 1024 ** 2).toFixed(1)} MB in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
);

const bucket = process.env['S3_BUCKET'] ?? 'modaco-vendor-feeds';
const endpoint = process.env['AWS_ENDPOINT_URL'] ?? 'http://localhost:4566';
const s3 = new S3Client({
  region: process.env['AWS_REGION'] ?? 'eu-central-1',
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

const key = `feeds/vendor-feed-${String(Date.now())}.csv`;
console.log(`Uploading to s3://${bucket}/${key} via ${endpoint}`);
await s3.send(
  new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: createReadStream(filePath),
    ContentLength: size,
    ContentType: 'text/csv',
  }),
);

console.log('Uploaded. The bucket notification starts ingestion; poll GET /api/v1/imports');
