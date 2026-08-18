/**
 * HTTP response envelope and async route plumbing.
 *
 * Every MeetFlow endpoint answers in one of two shapes so clients (and the
 * generated OpenAPI contract) never have to special-case a route:
 *
 *   success -> { "data": <payload>, "meta"?: { ... } }
 *   failure -> { "error": { "code", "message", "details"?, "requestId" } }
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface PageMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
}

export interface SuccessBody<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export function sendSuccess<T>(
  res: Response,
  data: T,
  statusCode = 200,
  meta?: Record<string, unknown>,
): void {
  const body: SuccessBody<T> = meta ? { data, meta } : { data };
  res.status(statusCode).json(body);
}

export function sendCreated<T>(res: Response, data: T, meta?: Record<string, unknown>): void {
  sendSuccess(res, data, 201, meta);
}

export function sendNoContent(res: Response): void {
  res.status(204).send();
}

export function sendPage<T>(
  res: Response,
  items: T[],
  pagination: { page: number; pageSize: number; totalItems: number },
  extraMeta?: Record<string, unknown>,
): void {
  const totalPages =
    pagination.pageSize > 0 ? Math.ceil(pagination.totalItems / pagination.pageSize) : 0;
  const meta: PageMeta & Record<string, unknown> = {
    page: pagination.page,
    pageSize: pagination.pageSize,
    totalItems: pagination.totalItems,
    totalPages,
    hasNextPage: pagination.page < totalPages,
    ...extraMeta,
  };
  sendSuccess(res, items, 200, meta);
}

/**
 * Express 4 does not catch rejections from async handlers — an unhandled
 * rejection would hang the request instead of reaching the error middleware.
 * Every async route must be wrapped in this.
 */
export function asyncHandler<
  P = Record<string, string>,
  ResBody = unknown,
  ReqBody = unknown,
  ReqQuery = Record<string, unknown>,
>(
  handler: (
    req: Request<P, ResBody, ReqBody, ReqQuery>,
    res: Response<ResBody>,
    next: NextFunction,
  ) => Promise<unknown>,
): RequestHandler<P, ResBody, ReqBody, ReqQuery> {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
