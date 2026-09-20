import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { cacheErrors, cacheHits, cacheMisses } from '../metrics.js';

/**
 * Redis here is a cache and nothing else. It is never a source of truth, and every
 * operation fails open to PostgreSQL: a Redis outage must degrade latency, not
 * availability. The difference matters — if ordering or pricing lived in Redis, losing
 * it would be a correctness failure rather than a performance one.
 */
export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(keys: readonly string[]): Promise<void>;
  /** Current version for an invalidation scope (a category, or ALL_SCOPE). */
  version(scope: string): Promise<number>;
  /** Invalidate a scope in O(1). See the note on versioned keys below. */
  bumpVersion(scope: string): Promise<void>;
  getOrLoad<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T>;
  healthy(): Promise<boolean>;
}

export const ALL_SCOPE = '__all__';

const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 10_000;

export class RedisCache implements Cache {
  readonly #redis: Redis;
  readonly #logger: Logger;
  /** In-flight loads, keyed by cache key — see `getOrLoad`. */
  readonly #inFlight = new Map<string, Promise<unknown>>();
  #consecutiveFailures = 0;
  #circuitOpenUntil = 0;

  constructor(redis: Redis, logger: Logger) {
    this.#redis = redis;
    this.#logger = logger;
  }

  /**
   * A tripped circuit stops us paying the network round trip on every request while
   * Redis is down. Without it, a Redis outage turns into a latency outage: each call
   * waits for a connection timeout before falling through to the database.
   */
  #circuitOpen(): boolean {
    return Date.now() < this.#circuitOpenUntil;
  }

  #recordSuccess(): void {
    this.#consecutiveFailures = 0;
  }

  #recordFailure(operation: string, error: unknown): void {
    cacheErrors.inc({ operation });
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD && !this.#circuitOpen()) {
      this.#circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
      this.#logger.warn(
        { operation, cooldownMs: CIRCUIT_COOLDOWN_MS },
        'cache circuit opened; serving from the database',
      );
    }
    this.#logger.debug({ err: error, operation }, 'cache operation failed, falling through');
  }

  async get<T>(key: string): Promise<T | null> {
    if (this.#circuitOpen()) return null;
    try {
      const raw = await this.#redis.get(key);
      this.#recordSuccess();
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch (error) {
      this.#recordFailure('get', error);
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (this.#circuitOpen()) return;
    try {
      await this.#redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
      this.#recordSuccess();
    } catch (error) {
      this.#recordFailure('set', error);
    }
  }

  async del(keys: readonly string[]): Promise<void> {
    if (keys.length === 0 || this.#circuitOpen()) return;
    try {
      // Explicit keys only. There is no pattern delete anywhere in this codebase:
      // KEYS blocks Redis's single thread and SCAN is neither atomic nor cheap at
      // the exact moment a flash sale makes us want it. See ADR-006.
      await this.#redis.del(...keys);
      this.#recordSuccess();
    } catch (error) {
      this.#recordFailure('del', error);
    }
  }

  async version(scope: string): Promise<number> {
    if (this.#circuitOpen()) return 0;
    try {
      const raw = await this.#redis.get(versionKey(scope));
      this.#recordSuccess();
      return raw === null ? 0 : Number(raw);
    } catch (error) {
      this.#recordFailure('version', error);
      return 0;
    }
  }

  async bumpVersion(scope: string): Promise<void> {
    if (this.#circuitOpen()) return;
    try {
      await this.#redis.incr(versionKey(scope));
      this.#recordSuccess();
    } catch (error) {
      this.#recordFailure('bumpVersion', error);
    }
  }

  /**
   * Cache-aside with in-process request coalescing.
   *
   * When 60K keys expire at once, the naive version sends one database query per
   * concurrent request. Coalescing collapses them to one query per key per process,
   * so a deployment of N instances does at most N loads instead of thousands.
   *
   * A cross-instance Redis lock would push that to exactly one, at the cost of a
   * lock round trip on every miss plus a lease-expiry failure mode. At N instances
   * that is not a trade worth making; it becomes one at a much larger fleet size.
   */
  async getOrLoad<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      cacheHits.inc({ cache: cacheLabel(key) });
      return cached;
    }
    cacheMisses.inc({ cache: cacheLabel(key) });

    const existing = this.#inFlight.get(key);
    if (existing !== undefined) return existing as Promise<T>;

    const promise = load()
      .then(async (value) => {
        await this.set(key, value, ttlSeconds);
        return value;
      })
      .finally(() => {
        this.#inFlight.delete(key);
      });

    this.#inFlight.set(key, promise);
    return promise;
  }

  async healthy(): Promise<boolean> {
    try {
      await this.#redis.ping();
      return true;
    } catch {
      return false;
    }
  }
}

function versionKey(scope: string): string {
  return `ver:${scope}`;
}

/** Metric label: the key family, never the full key — cardinality would explode. */
function cacheLabel(key: string): string {
  return key.split(':')[0] ?? 'unknown';
}

/**
 * Versioned keys are how invalidation stays O(1).
 *
 * Instead of deleting the keys that a flash sale makes stale, we bump a counter that
 * is part of every key. The old entries become unreachable immediately and expire on
 * their own TTL. One INCR invalidates an entire category's listings, however many
 * cached permutations of filters and cursors exist.
 */
export function listCacheKey(scope: string, version: number, paramsHash: string): string {
  return `list:${scope}:v${String(version)}:${paramsHash}`;
}

/**
 * Product detail keys are NOT versioned. A detail lookup starts from an id alone, so
 * the category — and therefore the scope — is not known until after the read. These
 * are invalidated by explicit DEL from the projector, which is already walking the
 * affected rows in batches and can pipeline the deletes alongside them.
 */
export function productCacheKey(id: string): string {
  return `product:${id}`;
}
