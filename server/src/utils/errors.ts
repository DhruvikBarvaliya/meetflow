/**
 * Application error taxonomy.
 *
 * Every failure that reaches a client is an `AppError` with a stable machine
 * code. The HTTP layer never invents status codes and never forwards an
 * unexpected error's message — unknown errors become a generic 500 so internal
 * details (SQL, file paths, stack traces) cannot leak to a caller.
 */

/** Stable, client-facing error codes. Additive changes only. */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  TOKEN_REVOKED: 'TOKEN_REVOKED',
  FORBIDDEN: 'FORBIDDEN',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /**
   * The account is real and the session is valid; the address behind it has
   * simply never been confirmed. Its own code rather than PERMISSION_DENIED
   * because the two need opposite responses from a client: one is "you cannot
   * do this", the other is "do this one thing first", and a client that cannot
   * tell them apart shows a dead end where a link belongs.
   */
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  TENANT_MISMATCH: 'TENANT_MISMATCH',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  SLOT_UNAVAILABLE: 'SLOT_UNAVAILABLE',
  RESOURCE_UNAVAILABLE: 'RESOURCE_UNAVAILABLE',
  CAPACITY_EXCEEDED: 'CAPACITY_EXCEEDED',
  POLICY_VIOLATION: 'POLICY_VIOLATION',
  BOOKING_WINDOW_CLOSED: 'BOOKING_WINDOW_CLOSED',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  IDEMPOTENCY_IN_PROGRESS: 'IDEMPOTENCY_IN_PROGRESS',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Structured, non-sensitive detail attached to a client error. */
export interface ErrorDetail {
  field?: string;
  message: string;
  [key: string]: unknown;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCodeValue;
  public readonly details?: ErrorDetail[];
  /** False for genuinely unexpected faults, which are logged at error level. */
  public readonly isOperational: boolean;
  /** Optional non-sensitive metadata surfaced to the client (e.g. retryAfter). */
  public readonly meta?: Record<string, unknown>;

  constructor(
    message: string,
    statusCode: number,
    code: ErrorCodeValue,
    options: {
      details?: ErrorDetail[];
      isOperational?: boolean;
      meta?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.isOperational = options.isOperational ?? true;
    this.meta = options.meta;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'The request payload failed validation.', details?: ErrorDetail[]) {
    super(message, 422, ErrorCode.VALIDATION_FAILED, { details });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(
    message = 'Authentication is required.',
    code: ErrorCodeValue = ErrorCode.UNAUTHENTICATED,
  ) {
    super(message, 401, code);
  }
}

export class ForbiddenError extends AppError {
  constructor(
    message = 'You do not have permission to perform this action.',
    code: ErrorCodeValue = ErrorCode.FORBIDDEN,
    meta?: Record<string, unknown>,
  ) {
    super(message, 403, code, { meta });
  }
}

/**
 * Raised whenever an authenticated principal touches another tenant's data.
 *
 * Deliberately answers 404, not 403: a 403 confirms the record exists, which
 * turns any tenant-scoped endpoint into an existence oracle.
 */
export class TenantMismatchError extends AppError {
  constructor(message = 'Resource not found.') {
    super(message, 404, ErrorCode.NOT_FOUND, { meta: { reason: 'tenant_scope' } });
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found.`, 404, ErrorCode.NOT_FOUND);
  }
}

export class ConflictError extends AppError {
  constructor(
    message = 'The request conflicts with the current state of the resource.',
    code: ErrorCodeValue = ErrorCode.CONFLICT,
    meta?: Record<string, unknown>,
  ) {
    super(message, 409, code, { meta });
  }
}

/** The requested time is no longer bookable (raced, blocked, or out of policy). */
export class SlotUnavailableError extends ConflictError {
  constructor(message = 'That time is no longer available.', meta?: Record<string, unknown>) {
    super(message, ErrorCode.SLOT_UNAVAILABLE, meta);
  }
}

export class ResourceUnavailableError extends ConflictError {
  constructor(
    message = 'A required resource is not available for that time.',
    meta?: Record<string, unknown>,
  ) {
    super(message, ErrorCode.RESOURCE_UNAVAILABLE, meta);
  }
}

/** A configured business rule rejected the request (notice, horizon, limits). */
export class PolicyViolationError extends AppError {
  constructor(message: string, meta?: Record<string, unknown>) {
    super(message, 422, ErrorCode.POLICY_VIOLATION, { meta });
  }
}

export class InvalidStateTransitionError extends AppError {
  constructor(from: string, to: string) {
    super(
      `An appointment cannot move from ${from} to ${to}.`,
      409,
      ErrorCode.INVALID_STATE_TRANSITION,
      { meta: { from, to } },
    );
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(
      'Too many requests. Please slow down and try again shortly.',
      429,
      ErrorCode.RATE_LIMITED,
      {
        meta: { retryAfterSeconds },
      },
    );
  }
}

export class DependencyUnavailableError extends AppError {
  constructor(dependency: string, cause?: unknown) {
    super(
      `${dependency} is temporarily unavailable. Please try again.`,
      503,
      ErrorCode.DEPENDENCY_UNAVAILABLE,
      { cause, meta: { dependency } },
    );
  }
}

export class InternalError extends AppError {
  constructor(message = 'An unexpected error occurred.', cause?: unknown) {
    super(message, 500, ErrorCode.INTERNAL_ERROR, { isOperational: false, cause });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
