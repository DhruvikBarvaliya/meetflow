/**
 * Request identity and access logging.
 *
 * Every request gets an id that appears in the structured log line, in any
 * audit record it writes, and in the error envelope returned to the client —
 * so a user-reported "request abc123 failed" is directly greppable.
 */
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import pinoHttp from 'pino-http';
import { logger } from '../config/logger';

/** Header name accepted from (and echoed to) trusted callers and proxies. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Bounded, safe characters only — the value is echoed back in a header. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The request id as a string.
 *
 * pino-http types `req.id` as `string | number`; MeetFlow always assigns a
 * string, and this accessor keeps every call site from repeating the narrowing.
 */
export function requestIdOf(req: Request): string {
  return String(req.id);
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.header(REQUEST_ID_HEADER);
  // Reject an unsafe client value rather than reflecting arbitrary input.
  req.id = supplied && SAFE_REQUEST_ID.test(supplied) ? supplied : crypto.randomUUID();
  req.startedAt = Date.now();
  res.setHeader(REQUEST_ID_HEADER, req.id);
  next();
}

/**
 * HTTP access logging.
 *
 * Health probes are logged at trace so a 5-second Kubernetes liveness check
 * cannot drown the signal, and the serializers keep bodies and headers out of
 * the log entirely — redaction in logger.ts is the second line of defence.
 */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => (req as Request).id,
  customLogLevel: (req, res, error) => {
    if (error || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    if (req.url === '/health' || req.url === '/ready') return 'trace';
    return 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  customErrorMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      // Client IP only; never the full header set.
      remoteAddress: req.remoteAddress,
    }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});
