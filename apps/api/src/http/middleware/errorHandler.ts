import type { ErrorRequestHandler, Request, Response } from 'express';
import type { Logger } from 'pino';
import { ValidationError, isAppError } from '@modaco/core';
import { ZodError } from 'zod';

/**
 * RFC 7807 problem details, with one rule that is not negotiable: a stack trace never
 * reaches the client. Operational failures explain themselves; anything unexpected
 * becomes a 500 carrying only a request id, which is enough to find the full context
 * in the logs and nothing more.
 */
interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  requestId: string;
  errors?: { path: string; message: string }[];
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req: Request, res: Response, next): void => {
    // Express hands a half-written response to its default handler; ours would only
    // corrupt it further by appending a second body.
    if (res.headersSent) {
      next(error);
      return;
    }

    const requestId = req.requestId;

    if (error instanceof ZodError) {
      const validation = new ValidationError('Request validation failed');
      respond(res, {
        type: 'https://modaco.dev/problems/validation-failed',
        title: 'Validation failed',
        status: validation.httpStatus,
        detail: 'One or more fields are invalid.',
        instance: req.originalUrl,
        code: validation.code,
        requestId,
        errors: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      logger.info({ issues: error.issues }, 'request rejected by validation');
      return;
    }

    if (isAppError(error)) {
      // Expected business outcomes are not incidents. Logging them at error level
      // trains everyone to ignore the error log, which is how real incidents get missed.
      const level = error.isOperational ? 'info' : 'error';
      logger[level]({ err: error, context: error.context }, error.message);

      respond(res, {
        type: `https://modaco.dev/problems/${error.code.toLowerCase().replace(/_/g, '-')}`,
        title: humanise(error.code),
        status: error.httpStatus,
        detail: error.message,
        instance: req.originalUrl,
        code: error.code,
        requestId,
      });
      return;
    }

    logger.error({ err: error }, 'unhandled error');
    respond(res, {
      type: 'https://modaco.dev/problems/internal-error',
      title: 'Internal server error',
      status: 500,
      detail: 'An unexpected error occurred. Quote the request id when reporting it.',
      instance: req.originalUrl,
      code: 'INTERNAL_ERROR',
      requestId,
    });
  };
}

function respond(res: Response, problem: ProblemDetails): void {
  res.status(problem.status).type('application/problem+json').json(problem);
}

function humanise(code: string): string {
  const lower = code.toLowerCase().replace(/_/g, ' ');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Express 4 does not forward rejections from async handlers; without this an await that
 * throws becomes a hung request rather than a 500.
 */
export function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: (err?: unknown) => void) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}
