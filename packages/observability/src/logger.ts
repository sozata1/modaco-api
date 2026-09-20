import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import pino, { type Logger } from 'pino';

export interface RequestContext {
  readonly requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * The request id is carried in AsyncLocalStorage rather than threaded through every
 * function signature. It also travels outward as an SQS message attribute, so a single
 * id follows one ingestion from the HTTP call through the queue into the Lambda and
 * down to the database — which is the only way a distributed failure is debuggable.
 */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function newRequestId(): string {
  return randomUUID();
}

export function createLogger(options: {
  level: string;
  serviceName: string;
  pretty: boolean;
}): Logger {
  return pino({
    level: options.level,
    base: { service: options.serviceName },
    // Injected on every line rather than per call site, so no log can forget it.
    mixin: () => {
      const requestId = currentRequestId();
      return requestId === undefined ? {} : { requestId };
    },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.secret'],
      remove: true,
    },
    ...(options.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });
}
