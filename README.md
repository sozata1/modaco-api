# ModaCo — Promotion Management API

Product catalogue and promotion management, built around three requirements that ordinary
CRUD does not satisfy: **listings sorted by effective price**, **500K-row vendor feeds
ingested under serverless constraints**, and **category-wide flash sales that reprice
50,000+ products without stalling the storefront**.

- [`ADR.md`](ADR.md) — architectural decisions, their costs, and the alternatives rejected
- [`AI_APPENDIX.md`](AI_APPENDIX.md) — Form 5: how AI was used, and what it got wrong
- [`schema.sql`](schema.sql) — the complete DDL
- [`AGENTS.md`](AGENTS.md) — working rules for this codebase
- [`docs/architecture.md`](docs/architecture.md) — diagrams: topology, both scenarios, the effective-price flow
- [`docs/ModaCo.postman_collection.json`](docs/ModaCo.postman_collection.json) — importable walkthrough of every endpoint
- [`.claude/agents/`](.claude/agents/) — the agent roles this repository is worked on with

---

## Running it

Requires Docker. Nothing else — no local Node, PostgreSQL or Redis.

```bash
cp .env.example .env
docker compose up -d --build
```

That starts PostgreSQL, PgBouncer, two Redis instances, LocalStack (S3 + SQS), runs the
migrations, and brings up the API, the projector and two ingestion workers. LocalStack's
healthcheck gates on the bootstrap having finished, so nothing starts before its queues
exist.

```bash
curl localhost:3000/health/ready
npm install && npm run build && npm run seed   # a small catalogue to look at
```

`npm run seed` is idempotent and deliberately shaped: a sale running now, one scheduled for
next week, a draft waiting to be assigned, and a product carrying its own promotion inside
a category that is also on sale — so promotion precedence is visible without setting it up
by hand.

If a host port is taken, change it in `.env` (`POSTGRES_HOST_PORT`, `REDIS_HOST_PORT`, …);
containers always talk to each other on the canonical ports.

---

## A three-minute tour

```bash
# 1. Create a product
curl -sX POST localhost:3000/api/v1/products -H 'content-type: application/json' \
  -d '{"sku":"ACC-100","name":"Leather Belt","category":"Accessories","basePrice":"149.99","stockQuantity":40}'

# 2. Create a promotion, then assign and publish it to a whole category
PROMO=$(curl -sX POST localhost:3000/api/v1/promotions -H 'content-type: application/json' \
  -d '{"name":"Flash: 50% off Accessories","discountType":"percentage","discountValue":50,
       "startsAt":"2026-01-01T00:00:00Z","endsAt":"2027-01-01T00:00:00Z"}' | jq -r .data.id)

curl -sX POST localhost:3000/api/v1/promotions/$PROMO/assign -H 'content-type: application/json' \
  -d '{"targetType":"category","category":"Accessories"}'
# 202 Accepted. One row is written; the 50K price updates are queued.

# 3. A product created DURING the sale is already discounted
curl -sX POST localhost:3000/api/v1/products -H 'content-type: application/json' \
  -d '{"sku":"ACC-200","name":"Silk Scarf","category":"Accessories","basePrice":"249.99","stockQuantity":10}'
# -> effectivePrice "125.00", resolved in the same transaction as the insert

# 4. Sorted by EFFECTIVE price — the scarf (base 249.99) now sorts ahead of the belt (149.99)
curl -s "localhost:3000/api/v1/products?category=Accessories&sort=effective_price"

# 5. An overlapping promotion on the same target is rejected by the database
curl -si -X POST localhost:3000/api/v1/promotions/$OTHER/assign -H 'content-type: application/json' \
  -d '{"targetType":"category","category":"Accessories"}'
# -> 409, code PROMOTION_OVERLAP
```

### Ingesting 500,000 rows

```bash
npm install && npm run build          # only needed for the generator script
npm run feed -- 500000                # generates ~24MB, uploads to S3 (LocalStack)
curl -s localhost:3000/api/v1/imports # poll: chunks completed, rows upserted/rejected
```

Uploading is the only trigger. The bucket notification starts everything; nothing in the
API kicks off ingestion. To exercise the fan-out:

```bash
docker compose up -d --scale ingestion-worker=6
```

---

## API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/v1/products` | `category`, `minPrice`, `maxPrice`, `sort=effective_price\|-effective_price`, `cursor`, `limit` (keyset, max 100) |
| `GET` | `/api/v1/products/:id` | Highest-traffic endpoint; cache-aside |
| `POST` | `/api/v1/products` | Effective price resolved in the same transaction |
| `POST` | `/api/v1/promotions` | Creates a draft |
| `GET` | `/api/v1/promotions/:id` | |
| `POST` | `/api/v1/promotions/:id/assign` | Assigns a target and publishes → `202`; `409` on overlap |
| `PATCH` | `/api/v1/promotions/:id/cancel` | → `202` |
| `POST` | `/api/v1/imports/upload-url` | Presigned S3 PUT; the API never handles the bytes |
| `GET` | `/api/v1/imports[/:jobId[/errors]]` | Progress, and the rows that were rejected |
| `GET` | `/health/live`, `/health/ready`, `/metrics` | Readiness does not fail when Redis is down — the cache fails open |

Errors are RFC 7807 `application/problem+json`, carrying a `requestId` that appears on
every related log line and travels through SQS into the ingestion workers.

---

## Architecture

Diagrams — topology, both scenarios as sequences, and the effective-price data flow —
are in [docs/architecture.md](docs/architecture.md).

```
                    ┌──────────┐   cache-aside    ┌──────────────┐
   storefront ─────▶│   api    │◀────────────────▶│ redis (cache)│
                    └────┬─────┘                  └──────────────┘
                         │ 1 row, ~1ms                     ▲ DEL
       publish a         │                                 │
       flash sale        ▼                                 │
                    ┌──────────┐    ┌───────────┐    ┌──────┴──────┐
                    │ postgres │◀───│ projector │◀───│ redis-queue │
                    └──────────┘    └───────────┘    └─────────────┘
                         ▲           batches of 5K
                         │           + reconciler
                    ┌────┴─────┐
                    │ pgbouncer│  transaction pooling
                    └────┬─────┘
                         │
   s3 ──notification──▶ splitter ──▶ sqs ──▶ worker ×N ──▶ (upsert + project)
         (never opens the file)      + DLQ    (ranged GET)
```

Three points carry most of the design:

**Effective price is stored, not computed on read.** Sorting by a derived value means
either scanning on every read or materializing once per change. `effective_price_cents`
with a `(category, effective_price_cents, id)` index makes listings an index scan. The
`LATERAL` join that resolves promotions still exists — it runs on the write path, once per
promotion change, instead of once per request.

**The one-promotion-per-product rule is a database constraint.** `EXCLUDE USING gist` over
`(target, tstzrange(starts_at, ends_at))`. An application-level check loses to two
concurrent publishes, which is exactly what a flash sale produces.

**The splitter never opens the file.** It reads the object's size, divides it into byte
ranges, and enqueues one message each. Runtime is independent of file size, so no file is
large enough to time it out. Workers read their own slice plus one byte of lookbehind —
that byte is what distinguishes a boundary landing mid-line from one landing exactly on a
line start, and without it every clean boundary silently loses a row.

---

## Tests

```bash
npm test          # unit + integration (Testcontainers; Docker required)
npm run test:e2e  # end-to-end against a running `docker compose` stack
npm run lint
```

The end-to-end suite is separate because it needs the stack up, and because running it
alongside the Testcontainers suites puts both under resource contention. It skips itself
when no stack is reachable. It covers what the others structurally cannot: the S3 bucket
notification, SQS delivery, the worker processes and the BullMQ queue — which is where
every defect that reached a running system in this project actually lived.

Worth looking at specifically:

- `packages/db/test/pricing-parity.test.ts` — the effective price is computed in SQL and in
  TypeScript, so the two are compared over 10,000 random inputs against a real database.
- `packages/db/test/invariants.test.ts` — two concurrent transactions publish overlapping
  promotions on the same product; one commits, one is rejected. Also asserts PostgreSQL
  refuses a partial index whose predicate calls `NOW()`.
- `apps/ingestion/test/csv.test.ts` — reconstructs a file from independently-parsed chunks
  at nine chunk sizes and asserts every line appears exactly once.

## Benchmark

```bash
npm run feed -- 500000        # load data first
npm run bench:detail          # arms: materialized / lateral / cached
```

Compares a primary-key read against the read-time `LATERAL` design and against cache-aside,
swept over concurrency.

The comparison arms are mounted only when `ENABLE_BENCH_ROUTES=true` — they bypass the
cache on purpose, so they are off by default. To reproduce the numbers in ADR-012:

```bash
sed -i '' 's/ENABLE_BENCH_ROUTES=false/ENABLE_BENCH_ROUTES=true/' .env
docker compose up -d api
docker compose run --rm bench bench/dist/bench-detail.js
```

It runs inside the compose network deliberately. Measured from the host, Docker Desktop's
port forwarding dominates the result — a primary-key read appeared to take 36ms at 10
connections, roughly ten times its real cost.

## Layout

```
packages/core           pure domain — pricing, promotion resolution, money. No infrastructure
packages/db             schema, migrations, repositories. All SQL lives here
packages/observability  logging, request context, metrics registry
apps/api                Express
apps/ingestion          Lambda handlers (splitter, worker) + local runners
apps/projector          queue consumer, scheduler, reconciler
bench/                  feed generator and benchmarks
infra/                  LocalStack bootstrap
```

`packages/core` may not import infrastructure — enforced by ESLint, not convention. It is
what lets the identical pricing code run in Express and in Lambda.
