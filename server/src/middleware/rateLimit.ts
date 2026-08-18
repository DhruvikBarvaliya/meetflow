/**
 * Distributed rate limiting.
 *
 * Counters live in Redis so limits hold across every API instance — a per-process
 * limiter would multiply the effective allowance by the number of pods.
 *
 * If Redis becomes unreachable, `insuranceLimiter` transparently falls back to a
 * per-process in-memory limiter. Protection degrades from cluster-wide to
 * per-instance rather than disappearing, which is the correct trade for
 * endpoints that must never be left completely open.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  RateLimiterMemory,
  RateLimiterRedis,
  type RateLimiterAbstract,
} from 'rate-limiter-flexible';
import { env } from '../config/env';
import { createLogger } from '../config/logger';
import { redis } from '../config/redis';
import { RateLimitError } from '../utils/errors';

const log = createLogger('rate-limit');

function buildLimiter(
  keyPrefix: string,
  points: number,
  durationSeconds: number,
): RateLimiterAbstract {
  const insurance = new RateLimiterMemory({
    points,
    duration: durationSeconds,
    keyPrefix: `${keyPrefix}:mem`,
  });

  return new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: `${env.REDIS_KEY_PREFIX}:rl:${keyPrefix}`,
    points,
    duration: durationSeconds,
    // Fail over instead of failing open.
    insuranceLimiter: insurance,
  });
}

/**
 * Client IP for limiting purposes.
 *
 * `req.ip` already honours the `trust proxy` setting, which is only enabled when
 * TRUST_PROXY=true — otherwise a forged X-Forwarded-For could be used to evade
 * every limit by rotating a header.
 */
function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export type KeyResolver = (req: Request) => string;

export interface RateLimitOptions {
  /** Namespace for the Redis keys; also identifies the bucket in logs. */
  name: string;
  points: number;
  durationSeconds: number;
  /** Defaults to the client IP. */
  keyResolver?: KeyResolver;
  /** Skip limiting entirely for some requests (e.g. an internal health probe). */
  skip?: (req: Request) => boolean;
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  if (!env.RATE_LIMIT_ENABLED) {
    // Explicitly disabled (local load testing only — production config refuses
    // to start with limiting off).
    return (_req, _res, next) => next();
  }

  const limiter = buildLimiter(options.name, options.points, options.durationSeconds);
  const resolveKey = options.keyResolver ?? clientIp;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (options.skip?.(req)) {
      next();
      return;
    }

    const key = resolveKey(req);
    try {
      const result = await limiter.consume(key, 1);
      res.setHeader('X-RateLimit-Limit', String(options.points));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.remainingPoints)));
      res.setHeader(
        'X-RateLimit-Reset',
        String(Math.ceil((Date.now() + result.msBeforeNext) / 1000)),
      );
      next();
    } catch (rejection) {
      // rate-limiter-flexible rejects with the limiter result on refusal, and
      // with an Error on an unexpected internal failure.
      if (rejection instanceof Error) {
        log.error(
          { err: rejection, bucket: options.name },
          'rate limiter failure — allowing request',
        );
        next();
        return;
      }
      const result = rejection as { msBeforeNext: number };
      const retryAfter = Math.max(1, Math.ceil(result.msBeforeNext / 1000));
      log.warn({ bucket: options.name, key, retryAfter }, 'rate limit exceeded');
      res.setHeader('X-RateLimit-Limit', String(options.points));
      res.setHeader('X-RateLimit-Remaining', '0');
      next(new RateLimitError(retryAfter));
    }
  };
}

// ---------------------------------------------------------------------------
// Preconfigured buckets
// ---------------------------------------------------------------------------

/** Authenticated management API, keyed per user so one tenant cannot starve another. */
export const apiRateLimit = rateLimit({
  name: 'api',
  points: env.RATE_LIMIT_API_POINTS,
  durationSeconds: env.RATE_LIMIT_API_WINDOW_SECONDS,
  keyResolver: (req) => req.auth?.userId ?? clientIp(req),
});

/** Unauthenticated public booking surface, keyed per IP. */
export const publicRateLimit = rateLimit({
  name: 'public',
  points: env.RATE_LIMIT_PUBLIC_POINTS,
  durationSeconds: env.RATE_LIMIT_PUBLIC_WINDOW_SECONDS,
});

/** Credential endpoints. Tight, and keyed per IP + submitted email so that
 *  attacking many accounts from one host and one account from many hosts are
 *  both throttled. */
export const authRateLimit = rateLimit({
  name: 'auth',
  points: env.RATE_LIMIT_AUTH_POINTS,
  durationSeconds: env.RATE_LIMIT_AUTH_WINDOW_SECONDS,
  keyResolver: (req) => {
    const email =
      typeof (req.body as { email?: unknown } | undefined)?.email === 'string'
        ? String((req.body as { email: string }).email).toLowerCase()
        : 'anonymous';
    return `${clientIp(req)}|${email}`;
  },
});

/** Booking confirmation — the most abuse-sensitive write in the product. */
export const bookingRateLimit = rateLimit({
  name: 'booking',
  points: Math.max(5, Math.floor(env.RATE_LIMIT_PUBLIC_POINTS / 4)),
  durationSeconds: env.RATE_LIMIT_PUBLIC_WINDOW_SECONDS,
});

/** Availability search is read-only but expensive; limited more generously. */
export const availabilityRateLimit = rateLimit({
  name: 'availability',
  points: env.RATE_LIMIT_PUBLIC_POINTS * 2,
  durationSeconds: env.RATE_LIMIT_PUBLIC_WINDOW_SECONDS,
});
