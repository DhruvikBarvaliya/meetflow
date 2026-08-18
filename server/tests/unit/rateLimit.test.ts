/**
 * What a rate limiter does when it cannot count.
 *
 * This is the one branch of `rateLimit()` that no integration test can reach:
 * it fires only when the Redis limiter *and* its in-memory insurance limiter
 * have both failed. It used to be unconditionally fail-open, with nothing
 * saying so, which quietly meant "a Redis incident removes the brute-force
 * protection from the login endpoint". The posture is now a per-bucket choice,
 * and this file pins both halves of it — including that credential buckets are
 * the ones that fail closed.
 *
 * Both dependencies are replaced: `rate-limiter-flexible` with a limiter that
 * always throws, and `config/redis` so importing the middleware does not open a
 * socket the unit suite would then have to close.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // The preconfigured buckets are built at import time and collapse to a no-op
  // pass-through when limiting is disabled, which is the suite default.
  process.env.RATE_LIMIT_ENABLED = 'true';
});

vi.mock('../../src/config/redis', () => ({ redis: {} }));

vi.mock('rate-limiter-flexible', () => {
  /** Stands in for both the Redis limiter and its insurance limiter. */
  class AlwaysBroken {
    constructor(_options: unknown) {}
    consume(): Promise<never> {
      return Promise.reject(new Error('redis unreachable and insurance limiter failed too'));
    }
  }
  return { RateLimiterRedis: AlwaysBroken, RateLimiterMemory: AlwaysBroken };
});

import { authIpRateLimit, credentialRateLimit, rateLimit } from '../../src/middleware/rateLimit';
import { ErrorCode } from '../../src/utils/errors';

/** Minimal request/response pair — the middleware only touches these fields. */
function fakeRequest(): Request {
  return {
    ip: '203.0.113.4',
    socket: { remoteAddress: '203.0.113.4' },
    body: { email: 'someone@meetflow.test' },
  } as unknown as Request;
}

function fakeResponse(): Response {
  return { setHeader: vi.fn() } as unknown as Response;
}

/** Runs a handler once and returns whatever it handed to `next`. */
async function invoke(handler: RequestHandler): Promise<unknown> {
  let passed: unknown = 'not-called';
  const next: NextFunction = (error?: unknown) => {
    passed = error;
  };
  await handler(fakeRequest(), fakeResponse(), next);
  return passed;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a limiter that cannot count', () => {
  it('lets the request through by default', async () => {
    // Matches how the rest of MeetFlow treats Redis: /ready reports an outage
    // as `degraded` and keeps serving, and every cache read degrades to a miss.
    // A broken counter must not turn a cache incident into a booking outage.
    const handler = rateLimit({ name: 'unit-open', points: 5, durationSeconds: 60 });

    expect(await invoke(handler)).toBeUndefined();
  });

  it('refuses with 503 when the bucket is declared fail-closed', async () => {
    const handler = rateLimit({
      name: 'unit-closed',
      points: 5,
      durationSeconds: 60,
      failClosed: true,
    });

    const error = (await invoke(handler)) as { statusCode: number; code: string };
    expect(error.statusCode).toBe(503);
    expect(error.code).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
  });

  it('fails closed on the credential buckets specifically', async () => {
    // The decision only earns its keep if the buckets that guard passwords are
    // the ones carrying it, so assert on the real exported handler rather than
    // on a locally constructed one.
    const error = (await invoke(authIpRateLimit)) as { statusCode: number };
    expect(error.statusCode).toBe(503);
  });
});

describe('the credential guard', () => {
  it('is a pair of buckets, not one', async () => {
    // Structural guard for the defect this pair closes: keying only on
    // IP+email gives every new address a fresh bucket, so spraying many
    // accounts from one host is never refused. Both handlers must ship
    // together, which is why routes mount this array rather than a name.
    expect(credentialRateLimit).toHaveLength(2);
    expect(credentialRateLimit[0]).toBe(authIpRateLimit);
  });
});
