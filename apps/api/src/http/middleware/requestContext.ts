import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';
import { httpRequestDuration } from '../../metrics.js';
import { newRequestId, runWithRequestContext } from '@modaco/observability';

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
  }
}

/**
 * Establishes the request id and the async context every log line reads from.
 *
 * An inbound `x-request-id` is honoured so a trace started upstream (gateway, another
 * service, a load test) stays one trace rather than becoming two unrelated halves.
 */
export function requestContext(logger: Logger): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const inbound = req.header('x-request-id');
    const requestId = inbound !== undefined && inbound.length > 0 ? inbound : newRequestId();

    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);

    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      // The Express route pattern, never req.path: labelling by raw path would create
      // one time series per product id and melt the metrics store.
      const route = routeLabel(req);
      httpRequestDuration.observe(
        { method: req.method, route, status: String(res.statusCode) },
        seconds,
      );
      logger.info(
        {
          method: req.method,
          route,
          status: res.statusCode,
          durationMs: Math.round(seconds * 1000),
        },
        'request completed',
      );
    });

    runWithRequestContext({ requestId }, () => {
      next();
    });
  };
}

/**
 * Express types `req.route` as `any`, so it is narrowed explicitly rather than trusted.
 */
function routeLabel(req: Request): string {
  const route: unknown = req.route;
  if (typeof route === 'object' && route !== null && 'path' in route) {
    const { path } = route;
    if (typeof path === 'string') return req.baseUrl + path;
  }
  return normalisePath(req.baseUrl + req.path);
}

/** Fallback for unmatched routes: collapse anything id-shaped so cardinality stays bounded. */
function normalisePath(path: string): string {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:n');
}
