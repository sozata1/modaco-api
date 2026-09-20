---
name: db-explain
description: Measure a query against ModaCo's PostgreSQL instead of reasoning about it. Use before claiming anything about an index, a plan or a cost, and before proposing a new index. Covers how to reach the database, what to read in the output, and the plans this schema has been wrong about before.
---

# Measuring a query

Load the `stack` skill first if the environment is not up.

```bash
set -a && . ./.env && set +a
q() { docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"; }

q "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT ..."
```

`ANALYZE` executes the query — never run it on a statement with side effects unless you
mean it. Wrap in a transaction and roll back if you need to measure a write.

## Read buffers, not only time

Wall-clock is the obvious number and the less important one. This database holds ~500K
products and the storefront depends on its hot pages staying in `shared_buffers`. A
background query touching a million buffers a minute evicts them, so it degrades
everything else while appearing merely slow itself.

That is exactly how the reconciler's cost was found: 3.2 seconds looked tolerable,
519,208 buffers per minute did not.

## Plans this schema has been wrong about

- **Assumed "index scan plus sort", was a primary-key walk with a filter.** A batch paging
  a category by id had no `(category, id)` index, so PostgreSQL walked `products_pkey` and
  discarded five sixths of what it read: 237 ms and 30,349 buffers for 5,000 rows. With
  the index: 11.7 ms and 578 buffers.
- **A `LATERAL` join is cheap for one row and ruinous for a listing.** On a single product
  the subquery runs once — under a millisecond. Sorting a category by a value it computes
  runs it per row: `loops=83331`, 3,353 ms, 185,885 buffers, because the twenty cheapest
  products cannot be known without computing all of them.
- **`ORDER BY` on a column that only moves when rows are written.** A sweep ordered by
  `price_computed_at` never advanced past rows it found correct, because correct rows are
  not rewritten. It re-examined the same oldest rows indefinitely.

## Checking whether an index is earning its place

```bash
q "SELECT indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid))
     FROM pg_stat_user_indexes WHERE schemaname='public' ORDER BY idx_scan;"
```

`idx_scan = 0` after real traffic means the index costs writes and returns nothing.

## Reporting

Give before and after, time and buffers, and the plan node that changed. An index
recommendation without its write cost is half an analysis.
