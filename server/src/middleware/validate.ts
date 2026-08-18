/**
 * Request validation.
 *
 * Handlers never see unvalidated input: this middleware replaces `body`,
 * `params` and `query` with the *parsed* values, so type coercion (a query
 * string "15" becoming the number 15) happens exactly once, at the boundary.
 *
 * Schemas are declared with `.strict()` on object bodies wherever a stray
 * property would be a client bug — that turns "you sent businessId in the body"
 * into a clear 422 rather than a silently ignored field.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';

export interface RequestSchemas {
  body?: ZodTypeAny;
  params?: ZodTypeAny;
  query?: ZodTypeAny;
}

/**
 * Express 4 exposes `query` as a lazily-parsed getter on some versions.
 * Assigning through defineProperty keeps this working regardless.
 */
function assignQuery(req: Request, value: unknown): void {
  try {
    (req as unknown as { query: unknown }).query = value;
  } catch {
    Object.defineProperty(req, 'query', { value, writable: true, configurable: true });
  }
}

export function validate(schemas: RequestSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schemas.params) {
        req.params = schemas.params.parse(req.params) as Request['params'];
      }
      if (schemas.query) {
        assignQuery(req, schemas.query.parse(req.query));
      }
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      next();
    } catch (error) {
      // ZodError is translated to a 422 with per-field detail by errorHandler.
      next(error);
    }
  };
}

/** Typed accessors so handlers get inference without a cast at every call. */
export function body<T extends ZodTypeAny>(req: Request, _schema: T): z.infer<T> {
  return req.body as z.infer<T>;
}

export function query<T extends ZodTypeAny>(req: Request, _schema: T): z.infer<T> {
  return req.query as unknown as z.infer<T>;
}

export function params<T extends ZodTypeAny>(req: Request, _schema: T): z.infer<T> {
  return req.params as unknown as z.infer<T>;
}
