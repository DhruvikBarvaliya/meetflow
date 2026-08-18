/**
 * Mount order in `src/routes/index.ts`, exercised over real HTTP.
 *
 * This file exists because the management router is mounted at *no path
 * prefix*, so it matches every path under `/api/v1`. Anything registered after
 * it disappears behind `requireTenant`, which resolves an ACTIVE membership and
 * answers 404 when there is none. Three surfaces are deliberately mounted above
 * that line — `/me`, workspace creation and invitation acceptance — and all
 * three break in the same silent way if somebody moves a line: the route keeps
 * existing, the handler is never reached, and every caller gets a 404 that
 * reads like a missing record rather than a wiring mistake.
 *
 * Nothing in the modules' own test files can catch that. Each of them assembles
 * an app in the shape its module needs, which is the right thing for testing a
 * module and the wrong thing for testing the file that decides the order. These
 * tests go through `createApp()` — the real application, the real router, the
 * real middleware — and the caller is the case that matters: somebody holding a
 * valid session and no membership at all.
 *
 * The negative assertion is the load-bearing one. Proving `/api/v1/me` answers
 * is only half the story; the other half is that `/api/v1/members` still does
 * not, because the tenant-scoped half of that module must stay behind the guard
 * when the untenanted half is lifted over it.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { login } from '../../src/modules/auth/auth.service';
import { ErrorCode } from '../../src/utils/errors';
import {
  TEST_PASSWORD,
  closeDatabaseConnection,
  createUser,
  resetDatabase,
} from '../helpers/fixtures';

const app = createApp();

/** A real identity that belongs to no workspace — a customer, or an invitee. */
const UNAFFILIATED_EMAIL = 'route-wiring@meetflow.test';

let token: string;

beforeAll(async () => {
  await resetDatabase();
  await createUser({ email: UNAFFILIATED_EMAIL });

  const session = await login(UNAFFILIATED_EMAIL, TEST_PASSWORD, {
    ipAddress: null,
    userAgent: null,
    requestId: 'route-wiring',
  });
  token = session.accessToken;
});

afterAll(async () => {
  await closeDatabaseConnection();
});

function asUnaffiliatedUser(path: string): request.Test {
  return request(app).get(path).set('Authorization', `Bearer ${token}`);
}

describe('surfaces mounted above the management router', () => {
  it('serves /api/v1/me to somebody with no membership', async () => {
    const response = await asUnaffiliatedUser('/api/v1/me/profile').expect(200);

    // The empty array is the proof, not an incidental detail: reaching the
    // handler at all is what a mount below the management router would prevent.
    expect(response.body.data.workspaces).toEqual([]);
  });

  it('serves /api/v1/members/invitations to somebody with no membership', async () => {
    const response = await asUnaffiliatedUser('/api/v1/members/invitations').expect(200);
    expect(response.body.data).toEqual([]);
  });

  it('404s an unknown /api/v1/me path on that surface rather than letting it fall through', async () => {
    // The terminator. Without it this request would reach tenant resolution and
    // answer 404 for an entirely different reason — "you belong to no
    // workspace" — which makes a typo look like a permissions problem.
    const response = await asUnaffiliatedUser('/api/v1/me/no-such-thing').expect(404);
    expect(response.body.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});

describe('the management router still guards everything below it', () => {
  it('refuses /api/v1/members to the same caller', async () => {
    // Lifting `/members/invitations` over the guard must not lift `/members`
    // with it: this is the workspace's people list, and the caller has no
    // workspace. 404 rather than 403, as tenant resolution answers everywhere.
    await asUnaffiliatedUser('/api/v1/members').expect(404);
  });

  it('refuses /api/v1/audit-logs to the same caller', async () => {
    await asUnaffiliatedUser('/api/v1/audit-logs').expect(404);
  });

  it('refuses /api/v1/webhooks to the same caller', async () => {
    await asUnaffiliatedUser('/api/v1/webhooks').expect(404);
  });
});

describe('unauthenticated probes', () => {
  it('answers 401 on /api/v1/me, so the surface cannot be enumerated', async () => {
    await request(app).get('/api/v1/me/profile').expect(401);
  });

  it('answers 401 rather than 404 for an unknown /api/v1 path', async () => {
    await request(app).get('/api/v1/not-a-real-endpoint').expect(401);
  });
});
