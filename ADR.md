# Architecture Decision Record — ModaCo Promotion Management API

Each record states the forces at play, the decision, what it costs us, and what we
rejected. Decisions were written as they were made rather than reconstructed afterwards,
and several of them changed because a measurement contradicted the plan — those changes
are recorded here rather than tidied away.

---

## In plain terms, before the detail

Three requirements drive everything here, and each has one idea behind it.

**Listings have to be sorted by the discounted price.** A discount can come from the
product itself or from its whole category, and it can start or stop without anyone
touching the product. You cannot sort by a number you work out while reading, because to
find the twenty cheapest items you would have to work out all of them first. So the
discounted price is stored on the product and kept up to date as promotions change.
Reading is then just an index lookup. Measured on 83,000 products: 4 milliseconds instead
of 3.4 seconds.

**A flash sale hits 50,000 products at once, during the busiest traffic of the day.** The
request that starts a sale writes a single row and answers in about a millisecond. The
50,000 price changes happen afterwards, in small batches, in a separate process. Shoppers
keep reading the whole time, and a product added mid-sale is already discounted when it is
created.

**Vendors send 500,000-row files, and the thing that loads them can be killed at any
moment.** So the part that decides how to split the file never opens it. It asks how large
the file is, divides that number into ranges, and posts one small job per range. It takes
about a fifth of a second whether the file has half a million rows or fifty million — a
file cannot be big enough to make it run out of time, because it never reads one. Each
worker then handles its own slice, and hands the rest over if it sees its own clock running
out.

One more rule sits underneath all three: a product can have at most one active promotion.
That is enforced by the database rather than checked in code, because two sales published
at the same moment would both pass a check and both be saved.

The records below give the reasoning, what each choice costs, and what was rejected.

---

## Context

Three requirements shape every decision below.

1. **Listings must sort by effective price.** Effective price is derived from a promotion
   that may target a product or its entire category, and it changes without the product
   row being touched.
2. **500K-row vendor feeds must be ingested on a serverless plan** with a hard timeout,
   constrained memory, and no state between invocations. Every row must pass the
   application-layer pricing rules before it is stored.
3. **A category-wide flash sale affects 50,000+ products instantly**, during the heaviest
   read traffic the system sees, and a product created while it runs must be discounted
   immediately.

A fourth is implicit but decisive: **a product may have at most one active promotion**.
That is an invariant, not a display rule, and where it is enforced determines whether it
actually holds.

---

## ADR-001 — PostgreSQL 16

**Decision.** PostgreSQL 16 as the single source of truth.

**Why.** The domain is relational and the hard requirements are relational: ordering by a
derived value, resolving overlapping promotion windows, and enforcing a uniqueness rule
that spans a target and a time range. Three PostgreSQL features do real work here and are
not incidental:

- `EXCLUDE USING gist` with `tstzrange` enforces the one-active-promotion invariant
  declaratively (ADR-004).
- Partial and composite indexes make the storefront's listing query an index scan.
- `INSERT … ON CONFLICT` over `unnest` makes ingestion batches idempotent and cheap.

**Consequences.** This is a deep commitment, not a default. Moving to another engine would
be a redesign of the core invariant rather than a port, and the repository layer does not
soften that. ADR-013 sets out exactly what it would cost and why we took the trade anyway.

**Rejected — MongoDB.** Would push conflict resolution and effective-price ordering into
application code, and leave the one-active-promotion rule unenforceable without a
distributed lock.

---

## ADR-002 — Kysely and hand-written SQL migrations, not Prisma

**Decision.** Kysely (a typed query builder) over `pg`, with migrations as plain `.sql`
files.

**Why.** Prisma was the AI's recommendation and appeared in the first plan unquestioned.
It was dropped because I pushed back on it — the concern that started this was mine, not
the model's: an ORM sitting between the application and queries this heavily tuned looked
like it would cost more than it returned. Examining it produced four concrete reasons:

| Problem | Consequence |
|---|---|
| Prisma cannot express `LEFT JOIN LATERAL` | Every important query becomes `$queryRaw`, which returns `unknown` — the type safety that justified Prisma disappears exactly where it matters |
| The Rust query engine ships a large binary | Cold-start weight in a Lambda, which is the one place this system is latency-sensitive about startup |
| The schema would be generated output | The case asks for the DDL as a deliverable. Here it is the source, reviewable as written |
| `Decimal` adds a third rounding contract | We need SQL and TypeScript to agree exactly (ADR-007) |

Kysely compiles to plain SQL with no runtime layer, keeps full type inference, and has an
`sql` escape hatch that stays typed.

**Consequences.** No relation loading, no nested writes, no automatic N+1 protection. In a
two-table domain with heavily tuned queries, writing the joins explicitly is what we want
anyway.

---

## ADR-003 — Effective price is materialized, not computed on read

**Decision.** `products.effective_price_cents` is a stored column, maintained
asynchronously, indexed by `(category, effective_price_cents, id)`.

**Why.** Sorting by a derived value has exactly two implementations: scan everything on
every read, or materialize once per change and index it. There is no third option, and the
first plan chose the first option without noticing.

Computing effective price at read time — a `LEFT JOIN LATERAL` per row — means every
`GET /products?sort=effective_price` is a full scan plus an in-memory sort, on the endpoint
that takes the most traffic, during the event that produces the most traffic. The read/write
ratio here is overwhelmingly read-heavy: storefront listings versus a handful of promotions
a day. The cost belongs on the write side.

The LATERAL join still exists — it moved to the write path, where it runs once per
promotion change instead of once per request.

**Promotion precedence.** A product-level promotion and a category-level flash sale can
both apply. Both are stored; exactly one is used:

```
1. Specificity:  product beats category
2. startsAt DESC
3. id ASC (stable)
```

`startsAt` rather than `createdAt`, because what matters commercially is when a promotion
took effect, not when someone saved the record. This ordering exists in two places — the
SQL projection and `resolveActivePromotion()` in `@modaco/core` — and they must stay
identical.

**Consequences: eventual consistency, with a budget.** The stored value can lag reality.
Four mechanisms bound it:

| Trigger | Mechanism | Lag |
|---|---|---|
| Promotion published/cancelled | Queued batch projection | seconds |
| Product created/updated | Synchronous, same transaction | none |
| A promotion's window opens or closes | Delayed job scheduled at that instant | ~1s |
| Anything above fails | Reconciler sweep | ≤ 60s |

`price_projection_lag_seconds` is exported so the budget is observable. An accepted
trade-off nobody measures is not a trade-off, it is a guess.

**The reconciler is a bounded, rotating scan.** The first implementation checked every
product on every sweep. Measured against 500K products that cost 3.2s and 519,000 buffers
per minute for `findStaleProductIds`, and 5.9s for the lag gauge, to return zero rows. The
wall-clock time was not the real damage: a million buffer touches a minute evicts the
storefront's hot pages from shared_buffers, so the safety net was degrading the cache it
exists to protect, and the cost grew linearly with the catalogue.

The sweep now examines a bounded window of products, paging through the primary key with
an explicit cursor that the projector carries from one sweep to the next and wraps at the
end of the table. Measured: **3,182 ms / 519,208 buffers → 36.9 ms / 5,129 buffers**.

The cursor is explicit because the obvious alternative does not work. Ordering the window
by `price_computed_at` — oldest projection first, on the theory that repairing a row sends
it to the back of the queue — reads well and fails: a row found *correct* is not
reprojected, so its timestamp never moves and the window never advances past it. It was
caught by running it: 100 deliberately corrupted rows sat unrepaired for 160 seconds while
the sweep re-examined the same oldest-but-healthy rows. Progress has to come from the scan,
not from the repair.

The trade-off, stated rather than buried: work per sweep is now constant, time to detection
is not. Full coverage takes `rowCount / scanWindow` sweeps — five minutes at the default
100,000-row window over 500K products, and measured at 263 s for drift spread across the id
space. That is the right way round. Everything ordinary is handled by
the targeted paths in seconds; this exists only for the rare case where one of them failed
silently, and an unbounded sweep buys faster detection of a rare event by permanently
taxing the common one.

**The reconciler must compare prices, not promotion ids.** This is subtle enough to have
been wrong in the running system. `products.active_promotion_id` carries
`ON DELETE SET NULL`, so hard-deleting a promotion clears the id while leaving the
discounted price in place. A reconciler that asks only "does the stored promotion id match
the resolved one?" then sees NULL against NULL — indistinguishable from a correct row —
and skips it permanently, while the lag gauge reports 0. Products were found sitting at
5.00 against a base price of 9.99 with no promotion anywhere in the database. The sweep now
compares the stored effective price against what it should be, which is the only question
that survives every way the targeted paths can fail.

**Rejected — a Redis sorted set as the ordering index.** Fast, but it makes Redis a source
of truth: an eviction or restart corrupts listings rather than merely slowing them. It also
multiplies keys per filter combination. See ADR-008.

**Considered and rejected — exploiting monotonicity.** A category-wide percentage discount
is a monotonic transform (`base × k`), so with exactly one category promotion in play,
ordering by base price equals ordering by effective price; no materialization needed. We
did not take it: product-level promotions and the `max(base − f, 0)` clamp break
monotonicity, and the optimisation would put a fragile "which index applies right now"
branch on the hottest read path.

---

## ADR-004 — The one-active-promotion invariant lives in the database

**Decision.**

```sql
ALTER TABLE promotions ADD CONSTRAINT excl_one_active_promo_per_product
  EXCLUDE USING gist (
    target_product_id                   WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'published' AND cancelled_at IS NULL AND target_type = 'product');
```

**Why.** The first plan resolved conflicts with `ORDER BY created_at DESC LIMIT 1` at read
time and returned a warning on create. That does not enforce the rule — it hides violations
behind a query. The database still holds N overlapping promotions, and any code path that
forgets the ORDER BY sees a different answer.

Checking in the application does not work either. `SELECT`, then `INSERT` if clear, is a
TOCTOU race: two concurrent publishes both observe a free slot and both commit. A flash
sale is precisely when concurrent writes happen.

The constraint makes the violation unrepresentable. The API translates `23P01` into
`409 Conflict`; that is a presentation concern layered on a guarantee, not the guarantee
itself.

**Verified.** `packages/db/test/invariants.test.ts` opens two concurrent transactions that
both insert overlapping promotions on the same product. One commits, one is rejected with
`23P01`, and the table holds exactly one row.

**Consequences.** Requires the `btree_gist` extension. Overlap errors surface as database
errors that the application must classify — which we prefer to an invariant that depends on
every future caller remembering to check.

---

## ADR-005 — Scenario A: split by byte range, never open the file

**Decision.**

```
S3 upload ──(bucket notification)──▶ splitter ──▶ SQS ──▶ worker ×N ──▶ PostgreSQL
                                     (never                (ranged GET)  (batch UPSERT)
                                      opens the file)
```

The splitter calls `HeadObject`, divides the byte count into 2MB ranges, and enqueues one
message per range. It does not read a single byte of content. Its runtime is **independent
of file size** — measured at roughly 200ms for a 24MB file, and the same for any other.

**Why this rather than a streaming orchestrator.** The first plan had an orchestrator
stream the file and write 100 chunk objects back to S3. That still reads the entire file
inside one invocation: it relocates the timeout risk instead of removing it. Here there is
no file size that can make the splitter time out, because the content is never touched.

**The boundary problem, and the byte that solves it.** Splitting by offset lands boundaries
mid-line. The rule is that **a worker owns every line that starts inside its range**, so it
skips the partial line at its start and reads slightly past its end to finish the last line
it owns.

That rule has a failure mode that our first implementation had: when a boundary lands
*exactly* on a line start, that line looks like a partial line to the next chunk (skipped)
and falls outside the previous chunk's range (never emitted). The row vanishes. From inside
the range the two cases are indistinguishable — so each worker reads **one byte before** its
range. A preceding `\n` means the boundary is clean and the line is owned.

A test that reconstructs a file from independently-parsed chunks at nine different chunk
sizes caught this. At 500K rows the corrected implementation accounts for every row exactly
once.

**Timeout handling, positively.** The worker checks
`context.getRemainingTimeInMillis()` after each batch. Below the threshold it allocates a
new chunk for the remainder, enqueues it, and exits cleanly. Work already committed is
durable; nothing is reprocessed. This is what makes "the process is not cut off midway" a
property rather than a hope.

**Idempotency in three layers**, because SQS redelivery is a guarantee, not a risk:

1. `INSERT … ON CONFLICT (sku) DO UPDATE` — the write itself is idempotent.
2. `ingestion_chunks (job_id, chunk_index)` primary key — a completed chunk short-circuits
   to a no-op, so counters cannot double-increment.
3. `ingestion_jobs.idempotency_key` (bucket/key/ETag/size) — a re-notified upload reuses
   the existing job.

**Batch-internal SKU deduplication.** A repeated SKU inside one batch makes PostgreSQL
raise `ON CONFLICT DO UPDATE command cannot affect row a second time` and roll back the
**entire batch** — a thousand good rows lost to one duplicate. Rows are deduplicated
(last wins) before the statement is built.

**Connection exhaustion.** Six workers with a generous pool each would exhaust
`max_connections` and take the API down with them. Two mitigations together: a pool of 2
per worker, and PgBouncer in transaction mode in front (RDS Proxy in production). Measured
during a six-worker run: **3 backend connections** against `max_connections = 100`.

**`UNNEST` rather than multi-row `VALUES`.** `VALUES` needs one placeholder per column per
row, so PostgreSQL's 65,535-parameter limit caps batch size. `UNNEST` passes five arrays —
five parameters regardless of batch size — so the batch is sized by what is efficient.

**Rejected — Step Functions.** Retries, backoff, DLQ, backpressure and concurrency control
all come free with SQS. Step Functions adds cost and orchestration for capabilities we
already have.

**Documented limitation.** Byte-range splitting cannot handle RFC 4180 fields containing
embedded newlines, because distinguishing a data newline from a record separator requires
parsing from the start of the file — exactly what we refuse to do. The vendor feed contract
forbids them and the splitter samples for them; a file that fails falls back to
single-worker streaming. Stating the limit is better than pretending the technique is
universal.

---

## ADR-006 — Scenario B: cheap write, asynchronous projection, versioned cache

**Decision.** Publishing a flash sale writes one row and returns `202` in about a
millisecond. The 50K price updates are queued and applied in bounded batches by a separate
worker.

**Why the first plan's reasoning was wrong.** It declared pre-computation an anti-pattern,
citing write amplification, an inconsistency window, and cascading failure. All three
describe doing 50K updates *synchronously inside the HTTP request*. Applied asynchronously,
in bounded batches, none of them apply. The scenario is literally titled *System
Load Distribution* — the goal is to distribute the work, not to avoid it.

Its fourth argument, that pre-computation cannot handle newly created products, was simply
incorrect: a product's effective price is resolved in the same transaction that inserts it.
Verified — a product created during an active 50%-off sale is returned at half price by the
call that creates it.

**Batches lock, they do not skip.** The batch that pages through a category was written
with `FOR UPDATE SKIP LOCKED`, which reads as the obvious way to let several workers share
the work. It loses rows. A skipped row still sits below the batch's highest id, the cursor
advances past it, and nothing revisits it in that pass — the product keeps its old price
until the reconciler eventually happens upon it, which is now up to a rotation away. Plain
`FOR UPDATE` cannot deadlock here because every worker takes locks in `id` order, and the
wait is short because these transactions are.

**Cache invalidation is a version bump, never a pattern delete.**

```
ver:{category}                     INCR to invalidate — O(1)
list:{scope}:v{version}:{hash}     becomes unreachable instantly, expires on its own TTL
product:{id}                       explicit DEL, pipelined by the projector
```

The first plan used `DEL products:list:*`, which means `KEYS` (blocks Redis's single
thread) or `SCAN` (not atomic, slow across thousands of keys) at the exact moment a flash
sale makes the cache hottest. One `INCR` invalidates an entire category's listings however
many cached filter and cursor permutations exist.

Detail keys cannot be versioned — a lookup starts from an id, so the category, and
therefore the scope, is unknown until after the read. The projector deletes them
explicitly; it is already walking those rows and can pipeline the deletes with them.

**Invalidate before projecting.** Readers may then briefly miss cache and recompute from a
database still catching up — a slightly stale price. The reverse order would serve a
*cached* stale price for a full TTL after the data was already correct: worse, and longer.

**Keyset pagination, no `OFFSET`.** `OFFSET` reads and discards N rows, and when prices
shift between requests it silently skips and repeats items — during a flash sale, which is
when prices shift most. A `(effective_price_cents, id)` row-value cursor is stable under
concurrent writes and costs the same on page 500 as on page 1. `id` is in the key because
effective prices collide constantly once a category-wide percentage maps many base prices
onto the same cent.

---

## ADR-007 — Money is integer cents, everywhere

**Decision.** `BIGINT` cents in the database, `number` cents in TypeScript. Percentages are
basis points (50% = 5000). No floats, no `Decimal`.

**Why.** Effective price is computed in two places by design — SQL for the projection,
TypeScript for the ingestion Lambda — and the two must agree bit for bit. A `NUMERIC`
column plus a JavaScript decimal library plus a driver parser is three rounding contracts
pretending to be one.

**Rounding is specified, not assumed.** The effective price is rounded half-up, not the
discount amount:

```
effective = round(base × (1 − bps/10000))
```

The first implementation rounded the discount and returned 7499 for 14999 at 50%, where
7500 is correct. One cent, systematic across 500K rows, and invisible without a test.

TypeScript uses `BigInt` for the intermediate product. This is not fastidiousness: in
floating-point division a true quotient sitting just below an integer can round up and
`trunc` then overshoots. `BigInt` division truncates toward zero exactly, matching
PostgreSQL's integer division.

**Verified.** `pricing-parity.test.ts` compares both implementations over 10,000 random
inputs against a real PostgreSQL. Its first run failed — not because the formulas
disagreed, but because `node-postgres` returns `BIGINT` as a *string* by default, so SQL
returned `"27479821318"` where TypeScript returned `27479821318`. In production that is
string concatenation in a price calculation. The driver now parses `int8` to a checked
`number`, and all pool creation goes through the factory that installs it.

---

## ADR-008 — Redis is a cache; it is never a source of truth

**Decision.** Redis caches product details and listing pages. It holds no data that cannot
be rebuilt from PostgreSQL.

**Why.** It determines the failure mode. If ordering or pricing lived in Redis, losing it
would be a *correctness* failure — wrong listings. As a cache, losing it is a *performance*
failure: slower, still correct. Every cache operation fails open to the database, a circuit
breaker stops paying connection timeouts while Redis is down, and `cache_errors_total`
makes a silently degraded cache visible.

Readiness deliberately does **not** fail when Redis is down. Refusing traffic would turn a
degradation into an outage.

**Stampede protection.** Misses are coalesced per key per process, so when 60K keys expire
at once a deployment of N instances performs at most N loads rather than thousands. A
cross-instance Redis lock would reduce that to exactly one, at the cost of a lock round
trip on every miss and a lease-expiry failure mode — not worth it at this fleet size.

---

## ADR-009 — A monorepo, because one pricing rule must run in two runtimes

**Decision.**

```
packages/core           pure domain: pricing, promotion resolution, money. Zero infrastructure
packages/db             schema, migrations, repositories. All SQL
packages/observability  logging, request context, metric registry
apps/api                Express            ─┐
apps/ingestion          Lambda handlers    ─┼─ all import packages/core
apps/projector          queue worker       ─┘
```

**Why.** The case requires every ingested record to pass the internal pricing rules — the
same rules the API applies. If that code lived inside either application it would be
duplicated, and duplicated rules drift. It lives in `packages/core`, and both call the same
function guarded by the same tests.

`packages/core` importing infrastructure is an ESLint error, not a convention:

```js
'packages/core is the pure domain layer and cannot import infrastructure.'
```

The applications are separate deployment units because they are separate runtimes. A flat
`src/` would put Express in the Lambda bundle, inflating cold start in the one place this
system is sensitive to it.

---

## ADR-010 — Observability was designed in, not added afterwards

**Decision.** Structured JSON logging with a request id that survives process boundaries,
RFC 7807 error bodies, Prometheus metrics including one that measures an accepted
trade-off, and health endpoints that distinguish liveness from readiness.

**Why this is an ADR at all.** The original plan had none of it — no logging strategy, no
metrics, no error contract, nothing about shutdown. It listed two middleware filenames and
moved on. That gap was mine to notice, and the architecture changed because of it rather
than gaining a logging library at the end.

Two pieces exist specifically because of how this system fails:

**The request id crosses the queue.** It is created at the HTTP boundary, carried in
`AsyncLocalStorage` so no log line can forget it, and written into the SQS message
attributes so the ingestion Lambda continues the same trace. Without that, a failed import
is two unrelated halves of a story: an API request that returned 201, and a worker error
with no way back to it.

**`price_projection_lag_seconds` exists because ADR-003 accepts staleness.** Deciding that
the effective price may lag, and then not measuring the lag, is not a trade-off — it is a
guess that sounds like one. The gauge is what makes the budget a commitment, and building
it changed the reconciler: the metric had to be cheap, which is how the unbounded sweep was
found.

**Readiness does not fail when Redis is down.** The cache fails open, so the service is
still correct, only slower. Refusing traffic there would convert a degradation into an
outage.

**Consequences.** More moving parts than a case study strictly needs, and a metric endpoint
on a worker that would otherwise need no HTTP server at all. Both were worth it: three of
the defects in `AI_APPENDIX.md` were found by reading logs or a metric, not code.

---

## ADR-011 — Separate Redis instances for cache and queue

**Decision.** Two Redis containers: `redis` (cache, `allkeys-lru`, no persistence) and
`redis-queue` (BullMQ, `noeviction`, AOF on, persistent volume).

**Why.** Discovered at runtime, from a BullMQ warning:

```
IMPORTANT! Eviction policy is allkeys-lru. It should be "noeviction"
```

The two workloads want opposite policies, and the policy is per **instance**, not per
database. A cache should drop its coldest entry under memory pressure — it rebuilds from
PostgreSQL. A queue must not: a silently evicted projection job leaves a product at the
wrong price indefinitely, with nothing anywhere recording that it happened.

Sharing one instance means choosing which of those two is allowed to be wrong. We declined
to choose.

---

## ADR-012 — Redis on the hot endpoint: what the measurement actually said

The case singles out `GET /products/:id` as the highest-traffic endpoint, so the question
was whether Redis earns its place there or whether a primary-key index already suffices.
We measured rather than assumed, and the answer came in two parts — one of which
contradicted the framing of the question.

### The detail endpoint

Three arms, same process, same pool (`bench/src/bench-detail.ts`), 499,991 products,
20s per level:

| Arm | conn | RPS | p50 | p97.5 | p99 |
|---|---:|---:|---:|---:|---:|
| **A** materialized (PK, no cache) | 5 | 265 | 10 ms | 82 ms | 136 ms |
| **C** cached (shipped) | 5 | 351 | **7 ms** | 68 ms | **112 ms** |
| **A** materialized | 10 | 308 | 20 ms | 134 ms | 223 ms |
| **C** cached | 10 | 483 | **12 ms** | 92 ms | **151 ms** |
| **A** materialized | 25 | 239 | 64 ms | 430 ms | 1292 ms |
| **C** cached | 25 | 483 | **33 ms** | 211 ms | **361 ms** |

The ratio is the interesting part, not the absolute numbers. At 5 connections the cache
improves p99 by 1.2×; at 25 connections, by 3.6×. The advantage **grows with
concurrency**, which is the shape predicted in ADR-008: Redis is not making a fast query
faster, it is keeping work off a fixed-size connection pool. At low traffic a plain index
would do; the cache earns its place precisely during a flash sale.

**Measured cache hit ratio during the run: 69%** (32,645 hits / 14,670 misses).

### The part that contradicted the question

Arm **B** — effective price resolved at read time with a `LATERAL` join — performed
roughly the same as arm A on this endpoint (p50 18 ms vs 10 ms at 5 connections). That is
not a reprieve for the read-time design. The query plan explains it: for a single product
the lateral subquery executes **once**.

The cost appears where the case actually requires it — sorting a listing by effective
price. Same database, one category of 83,331 products, first page of 20:

| | Execution time | Buffers |
|---|---:|---:|
| Materialized column, `ORDER BY effective_price_cents` | **4.3 ms** | 23 |
| Read-time `LATERAL`, same result | **3,353 ms** | 185,885 |

**775× slower, 8,000× more buffers**, for one page. The plan shows why:
`Nested Loop Left Join … loops=83331`, then a top-N heapsort. To know which twenty
products are cheapest, the database must compute all 83,331 effective prices first. A
value computed at read time cannot be indexed, so there is no way to stop early.

This measurement is what turned ADR-003 from a preference into a requirement. It is also
the clearest evidence that the original plan's read-path design did not solve the problem
it was written for.

### On the reliability of these numbers

The query-level figures are trustworthy: `EXPLAIN (ANALYZE, BUFFERS)` measures inside
PostgreSQL, unaffected by container scheduling.

The HTTP figures are directionally reliable and absolutely not. They were produced on
Docker Desktop for macOS with ten containers sharing one constrained VM, and throughput
varied by 2× between runs of the same configuration. Two things were done to keep them
meaningful: the benchmark runs **inside** the compose network — measured from the host,
Docker Desktop's port forwarding alone made a primary-key read appear to take 36 ms at 10
connections, roughly ten times its real cost — and the figures above come from low
concurrency, before the VM itself saturates. The relative ordering held across every run;
the absolute numbers did not, and a defensible saturation curve would need dedicated
hardware.

---

## ADR-013 — Database portability, and the repository boundary

**Decision.** PostgreSQL is treated as a chosen component, not as an interchangeable one.
SQL is confined to `packages/db`, but no repository interface is placed in front of it and
no attempt is made to keep the queries engine-neutral.

This record exists because that is a real cost and it should be written down with numbers
rather than implied.

### What we would actually be giving up

Nine PostgreSQL-specific features carry the design. Seven of the schema's eight indexes
are partial, and the rest appear across roughly thirty call sites:

| Feature | Uses | What replaces it elsewhere |
|---|---|---|
| `EXCLUDE USING gist` + `tstzrange` + `btree_gist` | 8 | **Nothing.** No equivalent in MySQL, SQL Server, Oracle or SQLite |
| `LEFT JOIN LATERAL` | 5 | `CROSS/OUTER APPLY` (SQL Server), `LATERAL` (Oracle 12c+, MySQL 8.0.14+) |
| `INSERT … ON CONFLICT` | 4 | `ON DUPLICATE KEY UPDATE` (MySQL), `MERGE` (SQL Server, Oracle) — different semantics, rewritable |
| `unnest()` over arrays | 4 | No array type in MySQL. Falls back to multi-row `VALUES`, which reintroduces the parameter limit that `unnest` was chosen to avoid |
| `IS DISTINCT FROM` | 4 | `<=>` in MySQL, explicit null handling in SQL Server |
| `gen_random_uuid()` | 3 | Engine-specific or application-generated |
| Partial indexes (`WHERE is_active`, `WHERE status = 'published'`) | 7 of 8 | Filtered indexes in SQL Server; **absent in MySQL** — the storefront indexes would carry inactive rows |
| `IMMUTABLE` SQL function (`apply_discount`) | 1 | Rewritable, but its parity with the TypeScript implementation would have to be re-established on the new engine (ADR-007) |

**The first row is the one that matters.** "A product can have at most one active
promotion" is enforced by an exclusion constraint over a time range. On an engine without
one, that invariant has to be rebuilt: either serializable isolation with a read-check and
retry loop, or an application-held lock keyed by target. Both work. Both are slower, both
add failure modes, and both move a guarantee out of the database into code that every
future caller has to remember — which is precisely the situation ADR-004 was written to
escape.

So a migration is not a port. It is a redesign of the safety property the system is built
around, and it should be estimated as one.

### Why we took the trade

The features above are not conveniences we happened to reach for. Three of them are the
answers to the case's hardest requirements: the exclusion constraint *is* the
one-promotion rule, the partial composite index *is* what makes effective-price sorting an
index scan rather than a 3.4-second scan, and `unnest` *is* what lets an ingestion batch be
sized by what is efficient rather than by a protocol limit.

An abstraction that kept those portable would have to either expose them — in which case it
is PostgreSQL with extra indirection — or give them up, in which case we lose the thing
that made the design work. There is no version of this that is both portable and good.

Engine choice here is a load-bearing decision, like choosing an event loop or a type
system. It is reasonable to make it deliberately and to carry the consequence.

### The repository boundary, and what it is not

SQL is confined to `packages/db/src/repositories/`. Nothing in `apps/` writes a query.
That boundary is real and it is worth having: it keeps queries reviewable in one place, it
is what let the database analyst find the reconciler's full-table scan, and it is why
adding an index changed one file.

What it is **not** is dependency inversion. The repositories export functions rather than
implement an interface, and services take Kysely's `Db` type directly:

```ts
constructor(
  private readonly db: Db,        // Kysely<Database> — a concrete type
  private readonly cache: Cache,  // an interface
  private readonly config: Config,
) {}
```

`Db` appears in 13 source files under `apps/`. Swapping the query builder — not even the engine —
would touch every one of those signatures.

Note that `Cache` on the next line *is* an interface. The inconsistency is deliberate. Redis
is genuinely substitutable: the port has five obvious methods, a second implementation is
plausible, and the interface is what lets the cache fail open without the caller knowing.
A repository port would have exactly one implementation, forever, and its method contracts
— a keyset cursor over a composite index, a conflict surfaced as `23P01` — do not survive
the engine change they would supposedly enable. It would be indirection bought on credit
against a migration that, per the section above, would be a redesign regardless.

**Consequences.** Cheap to change the query builder's *usage*, expensive to change the
builder's *type*, and a database migration is a project rather than a refactor. If
portability ever becomes a real requirement rather than a hypothetical one, the honest
first step is not an interface — it is deciding how the one-active-promotion invariant will
be enforced without an exclusion constraint. Everything else follows from that answer.

---

## What was measured

Run against the Docker Compose stack in this repository.

| Claim | Result |
|---|---|
| 500K-row ingestion completes without timeout, crash, or data loss | 13 chunks, **499,991 rows** stored = 500,000 generated − 9 deliberately malformed. Unique SKUs equal row count: no loss, no duplication |
| Chunk coverage is exact | Byte ranges span `0 → 25,226,381`, precisely the file size. Total attempts = 13, one per chunk. DLQ empty |
| Malformed rows do not fail the job | Job status `partial`, 9 rows recorded with raw line and reason |
| Connection exhaustion is contained | 6 concurrent workers → **3** PostgreSQL backend connections (`max_connections = 100`) |
| The invariant holds under concurrency | Two concurrent overlapping publishes → one commits, one `23P01`, one row in the table |
| SQL and TypeScript pricing agree | 10,000 random inputs, zero mismatches |
| A product created during a flash sale is discounted immediately | `249.99 → 125.00`, returned by the creating request |
| Sorting by effective price is index-backed, not a scan | **4.3 ms / 23 buffers** vs **3,353 ms / 185,885 buffers** for the read-time equivalent, over 83,331 products |
| Redis earns its place on the hot endpoint | p99 improves 1.2× at 5 connections and 3.6× at 25 — the gain grows with concurrency, as pool-protection should. ADR-012 states what these HTTP figures can and cannot support |
| The timeout handoff works under real pressure | Under deliberate contention a job grew from 13 to 19 chunks as workers handed off remainders, and still finished at exactly 499,991 rows |
| Listings sort by effective price, not base price | A product with base `249.99` (effective `125.00`) sorts ahead of one at `149.99` |
| The reconciler covers the table within its stated budget | 300 rows corrupted across the id space were fully repaired in **263 s**, against a claimed full-pass budget of 300 s at a 100,000-row window |
| The reconciler's cost is bounded | Sweep **3,182 ms / 519,208 buffers → 36.9 ms / 5,129 buffers** after switching to a rotating window on an indexed column |
| The projector's category batch is index-served | **237 ms / 30,349 buffers → 11.7 ms / 578 buffers** once `(category, id)` existed; PostgreSQL had been walking the primary key and filtering |
| No index depends on `NOW()` | `pg_indexes` matching `now()`: 0. Attempting to create one is rejected by PostgreSQL |

---

## Known limitations

- **CSV with embedded newlines** is unsupported by the byte-range splitter (ADR-005), with
  a documented fallback path.
- **Effective price is eventually consistent** within a stated budget (ADR-003). Strict
  read-your-writes on listings would require synchronous projection and the write-path cost
  that comes with it.
- **No authentication.** The case describes an internal API; an API-key or mTLS layer
  belongs at the edge and was not built.
- **PostgreSQL is a load-bearing choice, not a swappable one.** Migrating to another engine
  would be a redesign of the one-active-promotion invariant rather than a port, and the
  repository boundary does not soften that. ADR-013 sets out the cost and the reasoning.
- **Single-region, single-writer.** Multi-region would need conflict resolution for
  promotion windows that the EXCLUDE constraint cannot express across databases.
