# Architecture

Four diagrams: what runs, how a flash sale propagates, how a 500K-row file is ingested,
and where an effective price comes from.

For *why* any of it is shaped this way, see [ADR.md](../ADR.md).

---

## What runs

```mermaid
flowchart TB
    subgraph edge[" "]
        client([Storefront]):::ext
        vendor([Vendor]):::ext
    end

    subgraph apps["Application — separate deployment units"]
        api["<b>api</b><br/>Express<br/><i>reads, promotions, job status</i>"]
        projector["<b>projector</b><br/>BullMQ consumer<br/><i>price projection, scheduler, reconciler</i>"]
        splitter["<b>ingestion · splitter</b><br/>Lambda handler<br/><i>byte ranges only</i>"]
        worker["<b>ingestion · worker</b><br/>Lambda handler ×N<br/><i>parse, price, upsert</i>"]
    end

    subgraph shared["packages — shared, no infrastructure"]
        core["<b>@modaco/core</b><br/>pricing · promotion resolution · money"]
    end

    subgraph data["Data"]
        pg[("PostgreSQL 16<br/><i>source of truth</i>")]
        bouncer["PgBouncer<br/><i>transaction pooling</i>"]
        cache[("Redis · cache<br/>allkeys-lru")]
        queue[("Redis · queue<br/>noeviction + AOF")]
        s3[("S3")]
        sqs[["SQS + DLQ"]]
    end

    client -->|"GET /products"| api
    vendor -->|"presigned PUT"| s3

    api <-->|"cache-aside"| cache
    api -->|"enqueue projection"| queue
    queue --> projector
    projector -->|"DEL product:id"| cache

    s3 -.->|"bucket notification"| splitter
    splitter -->|"one message per byte range"| sqs
    sqs --> worker
    worker -->|"ranged GET"| s3

    api --> bouncer
    projector --> bouncer
    worker --> bouncer
    bouncer --> pg

    core -.-> api
    core -.-> projector
    core -.-> worker

    classDef ext fill:#fff,stroke:#999,stroke-dasharray:3 3
    classDef default fill:#f6f8fa,stroke:#57606a
```

Three things this picture is making a point about:

**`@modaco/core` is reached by dotted lines** because it is a library, not a service. The
case requires every ingested record to pass the same pricing rules the API applies. One
implementation, three runtimes.

**Everything reaches PostgreSQL through PgBouncer.** Six ingestion workers with a generous
pool each would exhaust `max_connections` and take the API down with them. Measured with
six workers running: three backend connections.

**The two Redis instances are not redundancy.** A cache should evict its coldest entry
under memory pressure; a queue must not. The policy is per instance, so one instance means
choosing which of them is allowed to be wrong.

---

## Scenario B — a flash sale on 50,000 products

```mermaid
sequenceDiagram
    autonumber
    actor Admin
    participant API as api
    participant PG as PostgreSQL
    participant Q as Redis (queue)
    participant P as projector
    participant C as Redis (cache)
    actor Shopper

    Admin->>API: POST /promotions/:id/assign<br/>{category: "Accessories"}
    API->>PG: UPDATE promotions — one row
    Note over PG: EXCLUDE constraint rejects<br/>an overlapping promotion here (409)
    API->>C: INCR ver:Accessories
    API->>Q: enqueue {category, cursor: null}
    API-->>Admin: 202 Accepted (~1 ms)

    loop until the category is exhausted
        Q->>P: projection job
        P->>PG: UPDATE 5,000 rows<br/>FOR UPDATE, ordered by id
        P->>C: pipelined DEL product:id
        P->>Q: enqueue next cursor
    end

    Shopper->>API: GET /products?category=Accessories&sort=effective_price
    API->>C: list:Accessories:v{n}:{hash}
    alt cached
        C-->>API: page
    else miss
        API->>PG: index scan on (category, effective_price_cents, id)
        API->>C: store
    end
    API-->>Shopper: 200
```

The write returns after one row. The fifty thousand updates that follow are queued,
applied in bounded batches, and never block a reader. Invalidation is one `INCR`: every
cached listing for that category becomes unreachable at once, whatever combination of
filters and cursors produced it.

Publishing answers `202`, not `200`. The promotion is durable and authoritative
immediately; the prices it implies are still rolling through. `200` would promise a
consistency this endpoint deliberately does not provide.

---

## Scenario A — 500,000 rows under a serverless timeout

```mermaid
sequenceDiagram
    autonumber
    actor Vendor
    participant S3
    participant SP as splitter (Lambda)
    participant SQS
    participant W as worker (Lambda ×N)
    participant PG as PostgreSQL

    Vendor->>S3: PUT feed.csv (24 MB, 500K rows)
    S3-->>SP: ObjectCreated

    Note over SP: HeadObject only —<br/>the file is never opened
    SP->>PG: INSERT job + 13 chunk rows
    SP->>SQS: 13 messages {startByte, endByte}
    Note over SP: ~200 ms, independent of file size

    par each chunk, in parallel
        SQS->>W: chunk message
        W->>PG: claim chunk<br/>(completed ⇒ no-op, redelivery is a given)
        W->>S3: ranged GET<br/>[startByte−1, endByte+overlap]
        Note over W: one byte of lookbehind tells a clean<br/>boundary from a mid-line one
        loop per 1,000 rows
            Note over W: dynamic pricing (@modaco/core)<br/>dedupe by SKU
            W->>PG: UPSERT via UNNEST + project prices
            alt running out of time
                W->>SQS: hand the remainder to a new chunk
            end
        end
        W->>PG: chunk completed, counters +1
    end

    Note over PG: 499,991 stored · 9 malformed rows recorded · status partial
```

The splitter is the whole trick. It asks S3 for the object's size, divides that number
into byte ranges, and enqueues one message each — so no file is large enough to make it
time out, because no file is ever read.

Splitting by offset lands boundaries mid-line. A worker owns every line that *starts*
inside its range, skips the partial line at the front, and reads slightly past its end to
finish the last line it owns. The single byte of lookbehind distinguishes a boundary that
landed cleanly on a line start from one that landed mid-line; without it, every clean
boundary silently loses a row.

---

## Where an effective price comes from

```mermaid
flowchart LR
    subgraph write["Write path — runs once per change"]
        trigger["promotion published<br/>· cancelled<br/>· window opens or closes<br/>· product created<br/>· reconciler sweep"]
        lateral["LEFT JOIN LATERAL<br/>resolve winning promotion"]
        rule["<b>product beats category</b><br/>then later starts_at<br/>then id"]
        store[("products.effective_price_cents<br/>+ active_promotion_id")]
        trigger --> lateral --> rule --> store
    end

    subgraph read["Read path — runs on every request"]
        q["WHERE category = ?<br/>ORDER BY effective_price_cents, id<br/>keyset cursor"]
        idx["idx_products_cat_eff_price"]
        q --> idx --> store
    end

    store -.->|"4.3 ms / 23 buffers"| fast(["index scan"]):::good
    lateral -.->|"3,353 ms / 185,885 buffers<br/>if this ran on reads instead"| slow(["full scan + sort"]):::bad

    classDef good fill:#e6ffed,stroke:#2da44e
    classDef bad fill:#ffebe9,stroke:#cf222e
    classDef default fill:#f6f8fa,stroke:#57606a
```

Sorting by a derived value has two implementations: scan everything on every read, or
materialize once per change and index it. The `LATERAL` join still exists — it moved to
the write path, where it runs once per promotion change instead of once per request.

The 775× difference is measured, on 83,331 products in one category, for a single page of
twenty. The reason it is that large: to know which twenty products are cheapest, the
database must compute all 83,331 effective prices first. `LIMIT 20` saves nothing.
