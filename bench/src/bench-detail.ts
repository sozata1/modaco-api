/**
 * Answers the question the case makes central: for the highest-traffic endpoint, is Redis
 * doing work a database index would not?
 *
 * Three arms, identical conditions — same process, same pool, same serialization:
 *
 *   A  materialized  primary-key lookup, effective price already on the row, no cache
 *   B  lateral       effective price resolved at read time (the first plan's design)
 *   C  cached        arm A plus cache-aside — the shipped endpoint
 *
 * Swept across concurrency levels, because the interesting difference is not average
 * latency. It is what happens when a fixed-size connection pool saturates.
 *
 *   npm run bench:detail
 */
import autocannon from 'autocannon';
import pg from 'pg';

/**
 * Defaults target service names, because this must run INSIDE the compose network.
 *
 * Measured from the host on Docker Desktop, the port-forwarding layer dominates
 * everything: a primary-key read showed 36ms p50 at 10 connections, roughly ten times
 * the query's actual cost. The benchmark was measuring the VM boundary, not the system.
 */
const API = process.env['BENCH_API'] ?? 'http://api:3000';
const DURATION = Number(process.env['BENCH_DURATION'] ?? 15);
const LEVELS = (process.env['BENCH_LEVELS'] ?? '10,50,200,500').split(',').map(Number);
const SAMPLE_SIZE = 500;

const pool = new pg.Pool({
  connectionString: process.env['BENCH_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '',
});

// A fixed random sample, reused by every arm: each arm must face the same key
// distribution or the cache hit rate becomes an uncontrolled variable.
const { rows } = await pool.query<{ id: string }>(
  `SELECT id FROM products TABLESAMPLE SYSTEM (1) LIMIT $1`,
  [SAMPLE_SIZE],
);
await pool.end();

if (rows.length === 0) throw new Error('No products found. Load a feed first: npm run feed -- 500000');
const ids = rows.map((r) => r.id);
console.log(`Sampled ${ids.length} product ids\n`);

interface Arm {
  readonly name: string;
  readonly path: (id: string) => string;
  readonly note: string;
}

const ARMS: Arm[] = [
  { name: 'A materialized', path: (id) => `/internal/bench/materialized/${id}`, note: 'PK lookup, no join, no cache' },
  { name: 'B lateral', path: (id) => `/internal/bench/lateral/${id}`, note: 'effective price computed per read' },
  { name: 'C cached', path: (id) => `/api/v1/products/${id}`, note: 'PK lookup + cache-aside (shipped)' },
];

interface Row {
  arm: string;
  connections: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  errors: number;
}

const results: Row[] = [];

for (const arm of ARMS) {
  for (const connections of LEVELS) {
    process.stdout.write(`${arm.name.padEnd(16)} c=${String(connections).padStart(3)} ... `);

    const result = await autocannon({
      url: API,
      connections,
      duration: DURATION,
      // A different id per request, so no arm accidentally benefits from one hot key.
      requests: ids.map((id) => ({ method: 'GET', path: arm.path(id) })),
    });

    results.push({
      arm: arm.name,
      connections,
      rps: Math.round(result.requests.average),
      p50: result.latency.p50,
      p95: result.latency.p97_5,
      p99: result.latency.p99,
      errors: result.non2xx + result.errors,
    });
    console.log(`${Math.round(result.requests.average)} rps, p99 ${result.latency.p99}ms`);
  }
}

console.log('\n| Arm | Conn | RPS | p50 (ms) | p97.5 (ms) | p99 (ms) | non-2xx |');
console.log('|---|---:|---:|---:|---:|---:|---:|');
for (const r of results) {
  console.log(
    `| ${r.arm} | ${r.connections} | ${r.rps} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.errors} |`,
  );
}

console.log('\nNotes on reading this:');
for (const arm of ARMS) console.log(`  ${arm.name}: ${arm.note}`);
