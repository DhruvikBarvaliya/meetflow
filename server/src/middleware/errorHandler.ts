/**
 * Central error translation.
 *
 * This is the only place that turns a thrown value into an HTTP response. Two
 * rules hold without exception:
 *
 *  1. An unrecognised error becomes a generic 500 — never a database message,
 *     a constraint name, a file path or a stack trace. Those go to the log,
 *     correlated by request id.
 *  2. Database integrity violations are translated into the domain errors that
 *     caused them, so a lost booking race reads as `409 SLOT_UNAVAILABLE`
 *     rather than a raw `23P01`.
 */
import type { NextFunction, Request, Response } from 'express';
import {
  BaseError,
  DatabaseError,
  ForeignKeyConstraintError,
  UniqueConstraintError,
  ValidationError as SequelizeValidationError,
} from 'sequelize';
import { ZodError } from 'zod';
import { logger } from '../config/logger';
import { isProduction } from '../config/env';
import { requestIdOf } from './requestContext';
import {
  AppError,
  ConflictError,
  ErrorCode,
  type ErrorCodeValue,
  type ErrorDetail,
  NotFoundError,
  ResourceUnavailableError,
  SlotUnavailableError,
  ValidationError,
} from '../utils/errors';

interface ErrorBody {
  error: {
    code: ErrorCodeValue;
    message: string;
    details?: ErrorDetail[];
    requestId: string;
    meta?: Record<string, unknown>;
  };
}

/** PostgreSQL SQLSTATE codes MeetFlow maps deliberately. */
const PG_EXCLUSION_VIOLATION = '23P01';
const PG_CHECK_VIOLATION = '23514';

/** Constraint names carry the domain meaning of a violated invariant. */
function translateExclusionViolation(constraint: string | undefined): AppError {
  if (constraint === 'appointment_staff_no_overlap') {
    return new SlotUnavailableError('That time was just taken. Please pick another slot.', {
      conflict: 'staff',
    });
  }
  if (constraint === 'appointment_resources_no_overlap') {
    return new ResourceUnavailableError(
      'A room or piece of equipment required for this booking was just reserved.',
      { conflict: 'resource' },
    );
  }
  return new ConflictError('That change conflicts with an existing booking.');
}

function zodToDetails(error: ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || undefined,
    message: issue.message,
    code: issue.code,
  }));
}

function normalise(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof ZodError) {
    return new ValidationError('The request payload failed validation.', zodToDetails(error));
  }

  if (error instanceof UniqueConstraintError) {
    const fields = Object.keys(error.fields ?? {});
    return new ConflictError(
      'A record with these details already exists.',
      ErrorCode.ALREADY_EXISTS,
      fields.length > 0 ? { fields } : undefined,
    );
  }

  if (error instanceof ForeignKeyConstraintError) {
    // Either the referenced row does not exist, or it is still referenced.
    return new ConflictError(
      'This action references a record that does not exist, or is still in use.',
      ErrorCode.CONFLICT,
    );
  }

  if (error instanceof SequelizeValidationError) {
    return new ValidationError(
      'The request payload failed validation.',
      error.errors.map((item) => ({ field: item.path ?? undefined, message: item.message })),
    );
  }

  if (error instanceof DatabaseError) {
    const original = (
      error as DatabaseError & { original?: { code?: string; constraint?: string } }
    ).original;
    if (original?.code === PG_EXCLUSION_VIOLATION) {
      return translateExclusionViolation(original.constraint);
    }
    if (original?.code === PG_CHECK_VIOLATION) {
      // A check violation that reaches here means validation missed a case;
      // surface it as a client error but without naming the constraint.
      return new ValidationError('The request violates a business rule for this record.');
    }
  }

  if (error instanceof BaseError) {
    return new AppError('A database error occurred.', 500, ErrorCode.INTERNAL_ERROR, {
      isOperational: false,
      cause: error,
    });
  }

  return new AppError('An unexpected error occurred.', 500, ErrorCode.INTERNAL_ERROR, {
    isOperational: false,
    cause: error,
  });
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Route ${req.method} ${req.path}`));
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Express requires the 4-arity signature; if headers are already sent the
  // only correct action is to let the default handler destroy the socket.
  if (res.headersSent) {
    next(error);
    return;
  }

  const appError = normalise(error);

  const logPayload = {
    err: error,
    requestId: requestIdOf(req),
    statusCode: appError.statusCode,
    code: appError.code,
    method: req.method,
    path: req.path,
    userId: req.auth?.userId,
    businessId: req.tenant?.businessId,
  };

  if (!appError.isOperational || appError.statusCode >= 500) {
    logger.error(logPayload, 'unhandled request failure');
  } else if (appError.statusCode >= 400) {
    logger.warn(logPayload, 'request rejected');
  }

  if (appError.meta?.retryAfterSeconds) {
    res.setHeader('Retry-After', String(appError.meta.retryAfterSeconds));
  }

  const body: ErrorBody = {
    error: {
      code: appError.code,
      // Internal faults get a fixed message; the real one stays in the log.
      message:
        appError.statusCode >= 500 && isProduction
          ? 'An unexpected error occurred. Please try again.'
          : appError.message,
      requestId: requestIdOf(req),
    },
  };
  if (appError.details?.length) body.error.details = appError.details;
  if (appError.meta) body.error.meta = appError.meta;

  res.status(appError.statusCode).json(body);
}
