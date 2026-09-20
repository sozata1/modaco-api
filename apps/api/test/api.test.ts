import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startHarness, type Harness } from './support/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
}, 240_000);

afterAll(async () => {
  await h.stop();
});

afterEach(async () => {
  await h.reset();
});

async function createProduct(
  sku: string,
  category: string,
  basePrice: string,
): Promise<{ id: string; effectivePrice: string }> {
  const response = await request(h.app)
    .post('/api/v1/products')
    .send({ sku, name: `Product ${sku}`, category, basePrice, stockQuantity: 10 })
    .expect(201);
  return response.body.data as { id: string; effectivePrice: string };
}

async function publishCategoryPromotion(category: string, percent: number): Promise<string> {
  const draft = await request(h.app)
    .post('/api/v1/promotions')
    .send({
      name: `${String(percent)}% off ${category}`,
      discountType: 'percentage',
      discountValue: percent,
      startsAt: new Date(Date.now() - 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    })
    .expect(201);

  const id = (draft.body.data as { id: string }).id;
  await request(h.app)
    .post(`/api/v1/promotions/${id}/assign`)
    .send({ targetType: 'category', category })
    .expect(202);
  return id;
}

describe('GET /api/v1/products — listing', () => {
  /**
   * The requirement the case singles out. The fixture must make base-price ordering and
   * effective-price ordering DISAGREE, or the test passes against an implementation that
   * quietly sorts by base price.
   *
   * A category-wide percentage cannot produce that disagreement: it is a monotonic
   * transform, so within one category it preserves base ordering exactly. The
   * disagreement needs a product-level promotion — which is also the realistic case.
   */
  it('sorts by effective price, not base price', async () => {
    await createProduct('ACC-1', 'Accessories', '149.99'); // stays 149.99
    const expensive = await createProduct('ACC-2', 'Accessories', '249.99'); // -> 100.00

    const draft = await request(h.app)
      .post('/api/v1/promotions')
      .send({
        name: 'Clearance on ACC-2',
        discountType: 'percentage',
        discountValue: 60,
        startsAt: new Date(Date.now() - 3_600_000).toISOString(),
        endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .expect(201);
    await request(h.app)
      .post(`/api/v1/promotions/${(draft.body.data as { id: string }).id}/assign`)
      .send({ targetType: 'product', productId: expensive.id })
      .expect(202);

    const response = await request(h.app)
      .get('/api/v1/products?category=Accessories&sort=effective_price')
      .expect(200);

    const items = response.body.data as { sku: string; effectivePrice: string }[];
    // Base order is ACC-1 (149.99) then ACC-2 (249.99); effective order is the reverse.
    expect(items.map((i) => i.sku)).toEqual(['ACC-2', 'ACC-1']);
    expect(items[0]?.effectivePrice).toBe('100.00');
    expect(items[1]?.effectivePrice).toBe('149.99');
  });

  it('reverses cleanly on -effective_price', async () => {
    await createProduct('A', 'Shoes', '10.00');
    await createProduct('B', 'Shoes', '20.00');
    const response = await request(h.app)
      .get('/api/v1/products?category=Shoes&sort=-effective_price')
      .expect(200);
    expect((response.body.data as { sku: string }[]).map((i) => i.sku)).toEqual(['B', 'A']);
  });

  it('filters by category', async () => {
    await createProduct('S-1', 'Shoes', '10.00');
    await createProduct('A-1', 'Accessories', '20.00');
    const response = await request(h.app).get('/api/v1/products?category=Shoes').expect(200);
    expect(response.body.data).toHaveLength(1);
  });

  it('filters by price range', async () => {
    await createProduct('P-1', 'Basics', '10.00');
    await createProduct('P-2', 'Basics', '50.00');
    await createProduct('P-3', 'Basics', '90.00');
    const response = await request(h.app)
      .get('/api/v1/products?minPrice=20.00&maxPrice=60.00')
      .expect(200);
    expect((response.body.data as { sku: string }[]).map((i) => i.sku)).toEqual(['P-2']);
  });

  /**
   * Walks every page with limit=1. The assertion that matters is not that pagination
   * works but that it is EXHAUSTIVE and DISJOINT — an OFFSET-based implementation can
   * pass a naive "does page 2 differ from page 1" check and still skip or repeat rows.
   */
  it('paginates by keyset without skipping or repeating', async () => {
    for (let i = 0; i < 7; i += 1) {
      await createProduct(`K-${String(i)}`, 'Denim', `${String(10 + i)}.00`);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const url: string =
        `/api/v1/products?category=Denim&sort=effective_price&limit=1` +
        (cursor === null ? '' : `&cursor=${cursor}`);
      const response = await request(h.app).get(url).expect(200);
      seen.push(...(response.body.data as { sku: string }[]).map((i) => i.sku));
      cursor = (response.body.page as { nextCursor: string | null }).nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual(['K-0', 'K-1', 'K-2', 'K-3', 'K-4', 'K-5', 'K-6']);
  });

  it('rejects an unsupported sort field instead of silently scanning', async () => {
    await request(h.app).get('/api/v1/products?sort=name').expect(422);
  });
});

describe('GET /api/v1/products/:id', () => {
  it('returns the product and serves the second read from cache', async () => {
    const created = await createProduct('D-1', 'Knitwear', '99.99');

    const first = await request(h.app).get(`/api/v1/products/${created.id}`).expect(200);
    expect(first.body.data.effectivePrice).toBe('99.99');

    // Delete the row underneath; a cached response proves the second read never hit the DB.
    await h.db.deleteFrom('products').where('id', '=', created.id).execute();
    const second = await request(h.app).get(`/api/v1/products/${created.id}`).expect(200);
    expect(second.body.data.sku).toBe('D-1');
  });

  it('returns RFC 7807 problem details with a request id on 404', async () => {
    const response = await request(h.app)
      .get('/api/v1/products/00000000-0000-4000-8000-000000000000')
      .expect(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body.code).toBe('NOT_FOUND');
    expect(response.body.requestId).toBeTruthy();
    expect(response.body.stack).toBeUndefined();
  });

  it('honours an inbound x-request-id so a trace stays one trace', async () => {
    const response = await request(h.app)
      .get('/api/v1/products/00000000-0000-4000-8000-000000000000')
      .set('x-request-id', 'upstream-trace-1')
      .expect(404);
    expect(response.body.requestId).toBe('upstream-trace-1');
    expect(response.headers['x-request-id']).toBe('upstream-trace-1');
  });
});

describe('promotions', () => {
  /** The case's explicit requirement for Scenario B. */
  it('discounts a product created while a flash sale is already running', async () => {
    await publishCategoryPromotion('Accessories', 50);
    const created = await createProduct('NEW-1', 'Accessories', '249.99');
    expect(created.effectivePrice).toBe('125.00');
  });

  it('rejects an overlapping promotion on the same target with 409', async () => {
    await publishCategoryPromotion('Accessories', 50);

    const draft = await request(h.app)
      .post('/api/v1/promotions')
      .send({
        name: 'Overlapping',
        discountType: 'fixed',
        discountValue: '10.00',
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      })
      .expect(201);

    const response = await request(h.app)
      .post(`/api/v1/promotions/${(draft.body.data as { id: string }).id}/assign`)
      .send({ targetType: 'category', category: 'Accessories' })
      .expect(409);

    expect(response.body.code).toBe('PROMOTION_OVERLAP');
  });

  it('restores base prices when a promotion is cancelled', async () => {
    const product = await createProduct('C-1', 'Outerwear', '200.00');
    const promotionId = await publishCategoryPromotion('Outerwear', 25);

    let detail = await request(h.app).get(`/api/v1/products/${product.id}`).expect(200);
    expect(detail.body.data.effectivePrice).toBe('150.00');

    await request(h.app).patch(`/api/v1/promotions/${promotionId}/cancel`).expect(202);

    detail = await request(h.app).get(`/api/v1/products/${product.id}`).expect(200);
    expect(detail.body.data.effectivePrice).toBe('200.00');
    expect(detail.body.data.discounted).toBe(false);
  });

  /** Product-level beats category-level regardless of which is newer or deeper. */
  it('applies the product promotion when a category sale also covers it', async () => {
    const product = await createProduct('P-WIN', 'Basics', '100.00');
    await publishCategoryPromotion('Basics', 50); // category: 50% -> 50.00

    const draft = await request(h.app)
      .post('/api/v1/promotions')
      .send({
        name: 'Product only 10%',
        discountType: 'percentage',
        discountValue: 10, // shallower, and published second
        startsAt: new Date(Date.now() - 3_600_000).toISOString(),
        endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .expect(201);

    await request(h.app)
      .post(`/api/v1/promotions/${(draft.body.data as { id: string }).id}/assign`)
      .send({ targetType: 'product', productId: product.id })
      .expect(202);

    const detail = await request(h.app).get(`/api/v1/products/${product.id}`).expect(200);
    expect(detail.body.data.effectivePrice).toBe('90.00');
  });

  it('refuses to assign a promotion that is not a draft', async () => {
    const promotionId = await publishCategoryPromotion('Shoes', 30);
    const response = await request(h.app)
      .post(`/api/v1/promotions/${promotionId}/assign`)
      .send({ targetType: 'category', category: 'Shoes' })
      .expect(409);
    expect(response.body.code).toBe('INVALID_PROMOTION_STATE');
  });

  it('rejects a promotion whose window ends before it starts', async () => {
    await request(h.app)
      .post('/api/v1/promotions')
      .send({
        name: 'Backwards',
        discountType: 'percentage',
        discountValue: 10,
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        endsAt: new Date(Date.now()).toISOString(),
      })
      .expect(422);
  });
});

describe('validation and health', () => {
  it('reports every invalid field at once rather than the first', async () => {
    const response = await request(h.app)
      .post('/api/v1/products')
      .send({ sku: 'bad sku', name: '', category: 'X', basePrice: 'abc' })
      .expect(422);

    const paths = (response.body.errors as { path: string }[]).map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['sku', 'name', 'basePrice']));
  });

  it('rejects a duplicate SKU', async () => {
    await createProduct('DUP-1', 'Basics', '10.00');
    await request(h.app)
      .post('/api/v1/products')
      .send({ sku: 'DUP-1', name: 'Other', category: 'Basics', basePrice: '20.00' })
      .expect(422);
  });

  it('reports ready, and exposes metrics', async () => {
    await request(h.app).get('/health/live').expect(200);
    const ready = await request(h.app).get('/health/ready').expect(200);
    expect(ready.body.checks.database).toBe(true);

    const metrics = await request(h.app).get('/metrics').expect(200);
    expect(metrics.text).toContain('http_request_duration_seconds');
  });

  /**
   * The cache must fail open. A Redis outage is a latency problem, never an availability
   * one — so this disconnects Redis and asserts the API still answers correctly.
   */
  it('keeps serving correct data when Redis is unavailable', async () => {
    const product = await createProduct('R-1', 'Denim', '75.00');
    h.redis.disconnect();

    const response = await request(h.app).get(`/api/v1/products/${product.id}`).expect(200);
    expect(response.body.data.effectivePrice).toBe('75.00');

    const ready = await request(h.app).get('/health/ready').expect(200);
    expect(ready.body.checks.redis).toBe(false);

    h.redis.connect().catch(() => undefined);
  });
});
