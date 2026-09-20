-- ============================================================================
-- ModaCo — 0001_init
--
-- Verified against PostgreSQL 16. Two things in particular:
--   * No NOW() in a partial-index predicate. PostgreSQL rejects it outright with
--     "functions in index predicate must be marked IMMUTABLE", because a predicate
--     that changes with the clock cannot describe a stored index. The time filter
--     lives in the index COLUMNS instead and is served by a range scan.
--   * "At most one active promotion" is enforced by an EXCLUDE constraint, not by
--     a SELECT-then-INSERT check in the application, which is open to a TOCTOU race.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- '=' on uuid/varchar inside EXCLUDE

-- ── updated_at automation ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

-- ── Pricing function ────────────────────────────────────────────────────────
-- MUST stay bit-for-bit identical to applyDiscount() in packages/core/src/money.ts.
-- The equivalence is verified by a property-based test against a real database,
-- not by reading both and hoping.
--
-- Rounding: the EFFECTIVE PRICE is rounded half-up, not the discount amount.
--   effective = round(base * (1 - bps/10000))
-- base_cents >= 0 and dvalue <= 10000, so the numerator is never negative:
-- integer division is floor, and the +5000 offset turns it into half-up.
CREATE OR REPLACE FUNCTION apply_discount(base_cents BIGINT, dtype TEXT, dvalue INTEGER)
RETURNS BIGINT LANGUAGE SQL IMMUTABLE STRICT AS $$
  SELECT GREATEST(0, CASE dtype
    WHEN 'percentage' THEN (base_cents * (10000 - dvalue) + 5000) / 10000
    WHEN 'fixed'      THEN base_cents - dvalue
  END);
$$;

-- ── products ────────────────────────────────────────────────────────────────
CREATE TABLE products (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku                    VARCHAR(100)  NOT NULL UNIQUE,   -- UNIQUE already creates the index
    name                   VARCHAR(500)  NOT NULL,
    category               VARCHAR(200)  NOT NULL,
    base_price_cents       BIGINT        NOT NULL CHECK (base_price_cents >= 0),
    stock_quantity         INTEGER       NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
    is_active              BOOLEAN       NOT NULL DEFAULT TRUE,

    -- Materialized price projection. Sorting BY effective price is only an index
    -- scan because this column exists; computed at read time it would make every
    -- listing request a full scan plus an in-memory sort. See ADR-003.
    effective_price_cents  BIGINT        NOT NULL CHECK (effective_price_cents >= 0),
    active_promotion_id    UUID,                            -- FK aşağıda (dairesel bağımlılık)
    price_computed_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_products_updated_at BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── promotions ──────────────────────────────────────────────────────────────
-- "Active" is DERIVED, never stored:
--   status='published' AND cancelled_at IS NULL AND NOW() IN [starts_at, ends_at)
-- This avoids a status column that a cron job would have to flip as time passes,
-- which is a whole class of drift we simply do not have.
CREATE TABLE promotions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name               VARCHAR(500) NOT NULL,
    discount_type      VARCHAR(20)  NOT NULL CHECK (discount_type IN ('percentage','fixed')),
    discount_value     INTEGER      NOT NULL CHECK (discount_value > 0),  -- pct: bps, fixed: cents
    starts_at          TIMESTAMPTZ  NOT NULL,
    ends_at            TIMESTAMPTZ  NOT NULL,

    target_type        VARCHAR(20)  CHECK (target_type IN ('product','category')),
    target_product_id  UUID         REFERENCES products(id) ON DELETE CASCADE,
    target_category    VARCHAR(200),

    status             VARCHAR(20)  NOT NULL DEFAULT 'draft'
                                    CHECK (status IN ('draft','published','cancelled')),
    cancelled_at       TIMESTAMPTZ,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_dates     CHECK (ends_at > starts_at),
    CONSTRAINT chk_pct_range CHECK (discount_type <> 'percentage' OR discount_value <= 10000),
    CONSTRAINT chk_cancelled CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),

    -- A draft may have no target yet (the assign endpoint sets it); a published one may not.
    CONSTRAINT chk_target CHECK (
        (status = 'draft' AND target_type IS NULL
             AND target_product_id IS NULL AND target_category IS NULL)
     OR (target_type = 'product'  AND target_product_id IS NOT NULL AND target_category   IS NULL)
     OR (target_type = 'category' AND target_category   IS NOT NULL AND target_product_id IS NULL)
    )
);

CREATE TRIGGER trg_promotions_updated_at BEFORE UPDATE ON promotions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE products ADD CONSTRAINT fk_products_active_promotion
    FOREIGN KEY (active_promotion_id) REFERENCES promotions(id) ON DELETE SET NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- BUSINESS RULE: "A product can have at most ONE active promotion at a time."
--
-- "SELECT first, INSERT if clear" in the application is open to a TOCTOU race:
-- two concurrent requests both see a clear slot and both write. So the invariant
-- is enforced here instead — two published promotions on the same target with
-- OVERLAPPING date ranges are physically impossible.
--
-- Only IMMUTABLE conditions appear in the predicate; NOW() cannot go here.
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE promotions ADD CONSTRAINT excl_one_active_promo_per_product
    EXCLUDE USING gist (
        target_product_id                   WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
    ) WHERE (status = 'published' AND cancelled_at IS NULL AND target_type = 'product');

ALTER TABLE promotions ADD CONSTRAINT excl_one_active_promo_per_category
    EXCLUDE USING gist (
        target_category                     WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
    ) WHERE (status = 'published' AND cancelled_at IS NULL AND target_type = 'category');

-- ── Read indexes (storefront) ───────────────────────────────────────────────
-- Listing: category filter + effective-price ordering + keyset pagination.
-- Its leftmost prefix also serves a plain category filter, so no separate
-- category index is needed — a second one would only cost writes.
CREATE INDEX idx_products_cat_eff_price ON products (category, effective_price_cents, id)
    WHERE is_active;
CREATE INDEX idx_products_eff_price     ON products (effective_price_cents, id)
    WHERE is_active;
-- Finding affected products when a promotion is cancelled, and the reconciler sweep
CREATE INDEX idx_products_active_promo  ON products (active_promotion_id)
    WHERE active_promotion_id IS NOT NULL;

-- ── Write indexes (projection / scheduler) ──────────────────────────────────
-- The time filter sits in the index COLUMNS, not the predicate -> range scan.
CREATE INDEX idx_promotions_by_category ON promotions (target_category, starts_at, ends_at)
    WHERE status = 'published' AND cancelled_at IS NULL AND target_type = 'category';
CREATE INDEX idx_promotions_by_product  ON promotions (target_product_id, starts_at, ends_at)
    WHERE status = 'published' AND cancelled_at IS NULL AND target_type = 'product';
CREATE INDEX idx_promotions_window      ON promotions (starts_at, ends_at)
    WHERE status = 'published' AND cancelled_at IS NULL;

-- ── Ingestion (Scenario A) ──────────────────────────────────────────────────
CREATE TABLE ingestion_jobs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key  VARCHAR(128) NOT NULL UNIQUE,   -- file SHA-256; a re-upload reuses the job
    bucket           VARCHAR(255) NOT NULL,
    object_key       VARCHAR(1024) NOT NULL,
    file_size_bytes  BIGINT NOT NULL,
    chunks_total     INTEGER NOT NULL DEFAULT 0,
    chunks_completed INTEGER NOT NULL DEFAULT 0,
    rows_upserted    BIGINT  NOT NULL DEFAULT 0,
    rows_rejected    BIGINT  NOT NULL DEFAULT 0,
    status           VARCHAR(20) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','processing','completed','partial','failed')),
    started_at       TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PK (job_id, chunk_index) is the idempotency anchor.
-- SQS is at-least-once: a message WILL be redelivered — that is a guarantee, not a
-- risk to hedge against. A chunk already marked 'completed' short-circuits to a
-- no-op, so the counters cannot be double-incremented.
CREATE TABLE ingestion_chunks (
    job_id        UUID    NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
    chunk_index   INTEGER NOT NULL,
    start_byte    BIGINT  NOT NULL,
    end_byte      BIGINT  NOT NULL,
    status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','completed','failed')),
    attempts      INTEGER NOT NULL DEFAULT 0,
    rows_upserted INTEGER NOT NULL DEFAULT 0,
    rows_rejected INTEGER NOT NULL DEFAULT 0,
    error         TEXT,
    completed_at  TIMESTAMPTZ,
    PRIMARY KEY (job_id, chunk_index)
);

-- Failing an entire 500K-row job because 12 rows are malformed is the wrong
-- trade: a 'partial' status plus per-row error records is what an operator can act on.
CREATE TABLE ingestion_row_errors (
    id          BIGSERIAL PRIMARY KEY,
    job_id      UUID NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    line_number BIGINT,
    raw_line    TEXT,
    reason      TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_row_errors_job ON ingestion_row_errors (job_id);
-- ============================================================================
-- 0002 — Bound the reconciler's scan, and give the projector's batch an index.
--
-- Both indexes exist because a measurement said so, not because they looked useful.
-- ============================================================================

-- The reconciler swept the whole table every 60 seconds:
--
--   findStaleProductIds          3,182 ms   519,208 buffers  (Seq Scan 499,991 + LATERAL/row)
--   measureProjectionLagSeconds  5,967 ms   519,197 buffers  (same, without even a LIMIT)
--
-- Nine seconds of full-table LATERAL every minute, to return zero rows. The wall-clock
-- cost is not the worst of it: a million buffer touches per minute evict the storefront's
-- hot pages from shared_buffers, so the safety net was quietly undoing the cache it was
-- meant to protect.
--
-- The sweep now pages through the primary key with a bounded window and an explicit
-- cursor, so no new index is needed for it — products_pkey already orders by id.
--
-- An earlier attempt ordered the window by `price_computed_at` instead, on the theory
-- that repairing a row would send it to the back of the queue. It does not rotate:
-- a row found CORRECT is not reprojected, so its timestamp never moves, and the sweep
-- re-examines the same oldest rows forever without ever reaching the rest of the table.
-- Progress has to come from the scan, not from the repair.

-- projectPricesForCategoryBatch pages through one category ordered by id. With only
-- (category, effective_price_cents, id) available, PostgreSQL chose to walk the PRIMARY
-- KEY in id order and filter on category — 237 ms and 30,349 buffers to collect 5,000
-- rows from a category holding a sixth of the table, because most pages it read were
-- other categories.
--
-- A flash sale over 83K products is ~17 such batches, so this is seconds of avoidable
-- page reads on the exact write path Scenario B is built around.
CREATE INDEX idx_products_category_id ON products (category, id) WHERE is_active;
