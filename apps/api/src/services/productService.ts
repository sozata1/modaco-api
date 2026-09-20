import { NotFoundError, formatCents } from '@modaco/core';
import type { Db, ProductRecord, SortDirection } from '@modaco/db';
import { findProductById, listProducts } from '@modaco/db';
import type { Cache } from '../cache/cache.js';
import { ALL_SCOPE, listCacheKey, productCacheKey } from '../cache/cache.js';
import type { Config } from '../config.js';
import { createHash } from 'node:crypto';
import type { Cursor } from '@modaco/db';
import { decodeCursor, encodeCursor } from '@modaco/db';

export interface ProductView {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly category: string;
  readonly basePrice: string;
  readonly effectivePrice: string;
  readonly discounted: boolean;
  readonly activePromotionId: string | null;
  readonly stockQuantity: number;
}

export interface ListQueryInput {
  readonly category?: string | undefined;
  readonly minPriceCents?: number | undefined;
  readonly maxPriceCents?: number | undefined;
  readonly sort: SortDirection;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface ListResult {
  readonly items: ProductView[];
  readonly nextCursor: string | null;
}

/** A sentinel distinguishing "we cached a miss" from "nothing is cached". */
const NEGATIVE = { notFound: true } as const;
type CachedDetail = ProductView | typeof NEGATIVE;

export class ProductService {
  constructor(
    private readonly db: Db,
    private readonly cache: Cache,
    private readonly config: Config,
  ) {}

  /**
   * The highest-traffic endpoint in the system.
   *
   * Reads are a primary-key lookup with no join, because the effective price is already
   * materialized on the row. Redis in front of that is not a latency optimisation — a warm
   * PK lookup is already fast — it is connection-pool protection: under a flash sale the
   * pool saturates and tail latency collapses long before PostgreSQL itself is the
   * bottleneck. ADR-008 explains why it is only ever a cache; ADR-012 has the measurement.
   */
  async getById(id: string): Promise<ProductView> {
    const cached = await this.cache.getOrLoad<CachedDetail>(
      productCacheKey(id),
      this.config.CACHE_PRODUCT_TTL,
      async () => {
        const record = await findProductById(this.db, id);
        return record === null ? NEGATIVE : toView(record);
      },
    );

    if (isNegative(cached)) {
      throw new NotFoundError(`Product ${id} was not found`, { productId: id });
    }
    return cached;
  }

  async list(query: ListQueryInput): Promise<ListResult> {
    const scope = query.category ?? ALL_SCOPE;
    const version = await this.cache.version(scope);
    const key = listCacheKey(scope, version, hashQuery(query));

    return this.cache.getOrLoad<ListResult>(key, this.config.CACHE_LIST_TTL, async () => {
      const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      const result = await listProducts(this.db, {
        ...(query.category !== undefined ? { category: query.category } : {}),
        ...(query.minPriceCents !== undefined ? { minPriceCents: query.minPriceCents } : {}),
        ...(query.maxPriceCents !== undefined ? { maxPriceCents: query.maxPriceCents } : {}),
        ...(cursor !== null && cursor !== undefined ? { cursor } : {}),
        sort: query.sort,
        limit: query.limit,
      });

      return {
        items: result.items.map(toView),
        nextCursor: result.nextCursor === null ? null : encodeCursor(result.nextCursor),
      };
    });
  }
}

function isNegative(value: CachedDetail): value is typeof NEGATIVE {
  return 'notFound' in value;
}

function toView(record: ProductRecord): ProductView {
  return {
    id: record.id,
    sku: record.sku,
    name: record.name,
    category: record.category,
    basePrice: formatCents(record.base_price_cents),
    effectivePrice: formatCents(record.effective_price_cents),
    discounted: record.effective_price_cents < record.base_price_cents,
    activePromotionId: record.active_promotion_id,
    stockQuantity: record.stock_quantity,
  };
}

/**
 * Hashing the filter set keeps the key short and bounded regardless of how baroque the
 * query string gets. Correctness comes from the version prefix, not from this hash:
 * a stale entry is unreachable the moment its scope's version is bumped.
 */
function hashQuery(query: ListQueryInput): string {
  const canonical = JSON.stringify([
    query.category ?? null,
    query.minPriceCents ?? null,
    query.maxPriceCents ?? null,
    query.sort,
    query.cursor ?? null,
    query.limit,
  ]);
  return createHash('sha1').update(canonical).digest('base64url').slice(0, 16);
}

export type { Cursor };
