/**
 * Error taxonomy. One rule: every error that reaches a boundary derives from AppError.
 *
 * The `isOperational` flag matters — expected business failures (404, 409) and
 * programming faults are treated differently: the first are logged at info/warn and
 * explained to the client, the second are logged at error and returned to the client
 * as nothing more than a status and a requestId. A stack trace never enters an HTTP body.
 */
export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly isOperational: boolean = true;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.context = context;
    Error.captureStackTrace(this, new.target);
  }
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 422;
}

export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;
}

/**
 * The application-level reading of a `23P01` exclusion-constraint violation.
 *
 * Note the direction: the application never *decides* to raise this, it *translates*
 * it from the database. The invariant has exactly one owner, and it is not this layer.
 * See ADR-004.
 */
export class PromotionOverlapError extends AppError {
  readonly code = 'PROMOTION_OVERLAP';
  readonly httpStatus = 409;
}

export class InvalidPromotionStateError extends AppError {
  readonly code = 'INVALID_PROMOTION_STATE';
  readonly httpStatus = 409;
}

export class IdempotencyConflictError extends AppError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  readonly httpStatus = 409;
}

/** A dependency (S3/SQS) failed. Never raised for Redis — that path fails open to the DB. */
export class DependencyError extends AppError {
  readonly code = 'DEPENDENCY_UNAVAILABLE';
  readonly httpStatus = 503;
  override readonly isOperational = false;
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
