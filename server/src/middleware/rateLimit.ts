/**
 * Distributed rate limiting.
 *
 * Counters live in Redis so limits hold across every API instance — a per-process
 * limiter would multiply the effective allowance by the number of pods.
 *
 * There are two distinct failure layers here and they must not be conflated:
 *
 *  - **Redis is unreachable.** `insuranceLimiter` transparently takes over with
 *    a per-process in-memory counter. Protection degrades from cluster-wide to
 *    per-instance rather than disappearing.
 *  - **The limiter itself throws.** Only reached once the insurance limiter has
 *    failed too — i.e. the bucket genuinely cannot count. What happens then is
 *    a per-bucket decision; see `failClosed` on `RateLimitOptions`.
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
import { DependencyUnavailableError, RateLimitError } from '../utils/errors';

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
  /**
   * What to do when the limiter itself cannot count (see the file header).
   *
   * `false` (the default) lets the request through. MeetFlow treats Redis as
   * non-essential infrastructure everywhere else — `/ready` reports a Redis
   * outage as `degraded` and the instance keeps taking traffic, and every cache
   * helper degrades to a miss — so a broken counter must not escalate a Redis
   * incident into a booking outage. Losing throttling on the public catalogue
   * for a few minutes costs latency; refusing every booking costs revenue.
   *
   * `true` refuses with 503 instead, and is correct only where an *unmetered*
   * endpoint is more dangerous than an *unavailable* one. Credential endpoints
   * are exactly that case: a few minutes of refused sign-ins is annoying and
   * recoverable, whereas an unthrottled window against the login endpoint is an
   * online password-guessing attack running at whatever rate the attacker can
   * open sockets — and the passwords it recovers stay recovered long after the
   * incident is closed. This is the one place where MeetFlow deliberately
   * departs from "Redis is optional", and the departure is scoped to the
   * credential buckets alone.
   */
  failClosed?: boolean;
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
        if (options.failClosed) {
          log.error(
            { err: rejection, bucket: options.name },
            'rate limiter failure — refusing request (bucket fails closed)',
          );
          next(new DependencyUnavailableError('Rate limiting'));
          return;
        }
        log.error(
          { err: rejection, bucket: options.name },
          'rate limiter failure — allowing request (bucket fails open)',
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

/**
 * How much wider the per-IP credential ceiling is than the per-IP+email one.
 *
 * The two credential buckets answer different attacks, so their ceilings must
 * not be equal. The narrow bucket has to be tight enough to stop guessing at a
 * single account; the wide one has to stay above what a shared office egress or
 * a CGNAT range legitimately produces, or the first busy customer is locked out
 * of their own product. Five accounts worth of budget per source address is the
 * compromise: comfortable for a group of humans sharing one address, useless to
 * anyone working through a leaked address list.
 */
const AUTH_IP_POINT_MULTIPLIER = 5;

/**
 * Credential endpoints, keyed per IP + submitted email.
 *
 * This bucket answers exactly one attack: many passwords at one account. It is
 * blind to the mirror image, because every new email address is a brand-new
 * bucket — a host spraying one password across ten thousand addresses spends a
 * single point in ten thousand separate buckets and is never refused, and the
 * per-account lockout in auth.service.ts never trips either because no account
 * sees more than one failure. That is why this is deliberately only half of the
 * protection; `authIpRateLimit` is the other half and credential routes mount
 * both, as `credentialRateLimit`.
 */
export const authRateLimit = rateLimit({
  name: 'auth',
  points: env.RATE_LIMIT_AUTH_POINTS,
  durationSeconds: env.RATE_LIMIT_AUTH_WINDOW_SECONDS,
  failClosed: true,
  keyResolver: (req) => {
    const email =
      typeof (req.body as { email?: unknown } | undefined)?.email === 'string'
        ? String((req.body as { email: string }).email).toLowerCase()
        : 'anonymous';
    return `${clientIp(req)}|${email}`;
  },
});

/**
 * Credential endpoints, keyed per IP only.
 *
 * Answers the attacks the per-email bucket cannot see: password spraying across
 * many accounts, mass account creation on `/auth/register`, and bulk probing of
 * `/auth/logout`, which performs an unauthenticated database lookup on an
 * attacker-supplied token digest. A higher ceiling than the per-account bucket,
 * but a real one.
 */
export const authIpRateLimit = rateLimit({
  name: 'auth-ip',
  points: env.RATE_LIMIT_AUTH_POINTS * AUTH_IP_POINT_MULTIPLIER,
  durationSeconds: env.RATE_LIMIT_AUTH_WINDOW_SECONDS,
  failClosed: true,
});

/**
 * The complete credential guard: both buckets, in the order they are consumed.
 *
 * Exported as one array so a credential route cannot mount half of the
 * protection. Mounting `authRateLimit` alone is precisely the defect this pair
 * exists to close, and a single list is harder to get wrong than a comment
 * asking the next author to remember two names. The per-IP bucket runs first so
 * a spraying host is refused before it can spend a point in the per-account
 * bucket of whichever victim it has just picked.
 */
export const credentialRateLimit: RequestHandler[] = [authIpRateLimit, authRateLimit];

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
