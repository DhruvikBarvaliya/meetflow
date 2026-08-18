/**
 * Credential rate limiting over real HTTP — the password-spraying regression.
 *
 * `authRateLimit` keys its bucket on `${ip}|${email}`, and on its own that is
 * not a limit at all: every address an attacker submits opens a fresh bucket,
 * so one host could try one password against unlimited accounts and never spend
 * more than a single point anywhere, while the per-account lockout never saw
 * more than one failure per account either. The comment above the resolver
 * claimed both attacks were covered, which is how it survived review.
 *
 * The fix is a second, per-IP-only bucket consumed in front of the first. These
 * tests pin the property that matters — *many different accounts from one host
 * are eventually refused* — rather than the specific numbers, which are
 * configuration.
 *
 * Two things make this file self-contained:
 *  - Rate limiting is off for the rest of the suite, so it is switched on here
 *    (with tiny ceilings) before `src/config/env.ts` is ever imported. The
 *    limiters are built at module load from that frozen config, so the
 *    assignment has to happen in a hoisted block, above the imports.
 *  - `TRUST_PROXY` is on so each test can present its own source address.
 *    Without it every request in the file shares one bucket and the tests
 *    exhaust each other. The per-IP window is five minutes, far longer than the
 *    run, so buckets never refill mid-file; a run-unique Redis prefix keeps two
 *    runs a minute apart from colliding as well.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const limits = vi.hoisted(() => {
  const authPoints = 2;
  const ipMultiplier = 5; // Mirrors AUTH_IP_POINT_MULTIPLIER in rateLimit.ts.
  process.env.RATE_LIMIT_ENABLED = 'true';
  process.env.RATE_LIMIT_AUTH_POINTS = String(authPoints);
  process.env.RATE_LIMIT_AUTH_WINDOW_SECONDS = '300';
  process.env.TRUST_PROXY = 'true';
  process.env.REDIS_KEY_PREFIX = `meetflow:test:${process.pid}:${Date.now()}`;
  return { authPoints, ipPoints: authPoints * ipMultiplier };
});

import { createApp } from '../../src/app';
import { ErrorCode } from '../../src/utils/errors';
import {
  TEST_PASSWORD,
  closeDatabaseConnection,
  createUser,
  resetDatabase,
} from '../helpers/fixtures';

const app = createApp();

/** A distinct source address per test, so buckets cannot leak between them. */
const SPRAY_IP = '198.51.100.11';
const SAME_ACCOUNT_IP = '198.51.100.12';
const REGISTER_IP = '198.51.100.13';
const LOGOUT_IP = '198.51.100.14';

beforeAll(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeDatabaseConnection();
});

function attemptLogin(ip: string, email: string) {
  return request(app)
    .post('/api/v1/auth/login')
    .set('X-Forwarded-For', ip)
    .send({ email, password: 'Wr0ngPassword!2026' });
}

describe('credential rate limiting', () => {
  it('refuses password spraying across many different accounts from one host', async () => {
    // One attempt per address, so the per-IP+email bucket is only ever at 1 of
    // its 2 points and cannot be what refuses anything here. Under the old
    // single-bucket keying every one of these was a brand-new bucket and all of
    // them returned 401 — the request below would never have been refused.
    for (let attempt = 0; attempt < limits.ipPoints; attempt += 1) {
      const response = await attemptLogin(SPRAY_IP, `spray-${attempt}@meetflow.test`);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    }

    const refused = await attemptLogin(SPRAY_IP, 'spray-victim@meetflow.test');
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe(ErrorCode.RATE_LIMITED);
    // The ceiling reported is the per-IP bucket's, not the per-account one's —
    // proof of which of the two actually stopped the spray.
    expect(refused.headers['x-ratelimit-limit']).toBe(String(limits.ipPoints));
  }, 60_000);

  it('still throttles many passwords at ONE account, on the narrower bucket', async () => {
    // The original bucket is not replaced, only supplemented: guessing at a
    // single account must still be refused long before the per-IP ceiling.
    for (let attempt = 0; attempt < limits.authPoints; attempt += 1) {
      const response = await attemptLogin(SAME_ACCOUNT_IP, 'one-victim@meetflow.test');
      expect(response.status).toBe(401);
    }

    const refused = await attemptLogin(SAME_ACCOUNT_IP, 'one-victim@meetflow.test');
    expect(refused.status).toBe(429);
    expect(refused.headers['x-ratelimit-limit']).toBe(String(limits.authPoints));
  }, 60_000);

  it('caps mass account creation from one host', async () => {
    // /auth/register had the same per-email resolver and therefore the same
    // hole: a fresh bucket for every address, so one host could open accounts
    // without bound.
    for (let attempt = 0; attempt < limits.ipPoints; attempt += 1) {
      const response = await request(app)
        .post('/api/v1/auth/register')
        .set('X-Forwarded-For', REGISTER_IP)
        .send({
          email: `bulk-${attempt}@meetflow.test`,
          password: TEST_PASSWORD,
          firstName: 'Bulk',
          lastName: 'Signup',
        });
      expect(response.status).toBe(201);
    }

    const refused = await request(app)
      .post('/api/v1/auth/register')
      .set('X-Forwarded-For', REGISTER_IP)
      .send({
        email: 'bulk-overflow@meetflow.test',
        password: TEST_PASSWORD,
        firstName: 'Bulk',
        lastName: 'Signup',
      });
    expect(refused.status).toBe(429);
    expect(refused.headers['x-ratelimit-limit']).toBe(String(limits.ipPoints));
  }, 60_000);

  it('limits /auth/logout, which carried no limiter at all', async () => {
    // Logout answers 204 to an unknown token by design, but it reaches the
    // database to find that out — an unauthenticated lookup on an
    // attacker-supplied digest, previously unmetered.
    const token = 'a'.repeat(64);

    for (let attempt = 0; attempt < limits.ipPoints; attempt += 1) {
      const response = await request(app)
        .post('/api/v1/auth/logout')
        .set('X-Forwarded-For', LOGOUT_IP)
        .send({ refreshToken: token });
      expect(response.status).toBe(204);
    }

    const refused = await request(app)
      .post('/api/v1/auth/logout')
      .set('X-Forwarded-For', LOGOUT_IP)
      .send({ refreshToken: token });
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe(ErrorCode.RATE_LIMITED);
  }, 60_000);

  it('keeps the buckets independent per source address', async () => {
    // A neighbour behind a different address is unaffected by the spraying host
    // above — the point of keying on IP rather than throttling the endpoint.
    const victim = await createUser({ email: 'innocent@meetflow.test' });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '203.0.113.9')
      .send({ email: victim.email, password: TEST_PASSWORD });

    expect(response.status).toBe(200);
  }, 60_000);
});
