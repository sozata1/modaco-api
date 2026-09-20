import express, { type Express } from 'express';
import type pg from 'pg';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Db } from '@modaco/db';
import type { Logger } from 'pino';
import type { Cache } from '../cache/cache.js';
import type { ProductService } from '../services/productService.js';
import type { PromotionService } from '../services/promotionService.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestContext } from './middleware/requestContext.js';
import { healthRoutes, metricsRoute } from './routes/health.js';
import { productRoutes } from './routes/products.js';
import { promotionRoutes } from './routes/promotions.js';
import { importRoutes } from './routes/imports.js';
import { benchRoutes } from './routes/bench.js';
import { NotFoundError } from '@modaco/core';

export interface AppDependencies {
  readonly db: Db;
  readonly pool: pg.Pool;
  readonly cache: Cache;
  readonly logger: Logger;
  readonly productService: ProductService;
  readonly promotionService: PromotionService;
  readonly s3: S3Client;
  readonly s3Bucket: string;
  readonly enableBenchRoutes: boolean;
}

export function createApp(deps: AppDependencies): Express {
  const app = express();

  // Trust the proxy so req.ip and protocol reflect the client rather than the load
  // balancer; rate limiting and logs are worthless otherwise.
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(express.json({ limit: '1mb' }));
  app.use(requestContext(deps.logger));

  app.use('/health', healthRoutes(deps.pool, deps.cache));
  app.use('/metrics', metricsRoute());
  app.use('/api/v1/products', productRoutes(deps.productService, deps.db, deps.cache));
  app.use('/api/v1/promotions', promotionRoutes(deps.promotionService));
  app.use('/api/v1/imports', importRoutes(deps.db, deps.s3, deps.s3Bucket));
  if (deps.enableBenchRoutes) app.use('/internal/bench', benchRoutes(deps.db));

  app.use((req, _res, next) => {
    next(new NotFoundError(`No route matches ${req.method} ${req.originalUrl}`));
  });
  app.use(errorHandler(deps.logger));

  return app;
}
