/**
 * Refresh-token rotation, reuse detection and revocation, over real HTTP.
 *
 * Nothing else in the suite exercises the branch every signed-in session rests
 * on. Delete this file and the following ship silently:
 *
 *  - a refresh that hands back the *same* token, or leaves the presented one
 *    live — rotation stops being rotation, and a stolen token keeps minting
 *    credentials for the whole refresh lifetime;
 *  - reuse detection that revokes only the replayed row instead of the family,
 *    which leaves the thief's freshly rotated token working and turns the whole
 *    theft-detection design into a log line;
 *  - `authenticate` no longer honouring family revocation, so a logout-all
 *    stops taking effect until the last live access token expires — up to
 *    fifteen minutes of continued access after an admin or a user cut a session
 *    off;
 *  - a revoked family that can be revived by any surviving token in it, which
 *    is the "logged out" state quietly not being one.
 *
 * These run over supertest rather than against the service, because two of the
 * guarantees only exist end to end: revocation is enforced by the
 * `authenticate` middleware, and the rotated token has to travel back through
 * the HTTP contract for the client to be able to use it at all.
 *
 * Rate limiting is off (the suite default) so the several refreshes each test
 * makes are refused by the session rules or by nothing — `authRateLimit.test.ts`
 * owns the ceiling, and mixing the two would make it ambiguous which mechanism
 * answered.
 */
import request from 'supertest';
import type { Response } from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Op } from 'sequelize';
import { createApp } from '../../src/app';
import { AuditLog, RefreshToken } from '../../src/database/models';
import { AuditActions } from '../../src/modules/audit/audit.service';
import { ErrorCode } from '../../src/utils/errors';
import { sha256 } from '../../src/utils/ids';
import {
  TEST_PASSWORD,
  closeDatabaseConnection,
  createUser,
  resetDatabase,
} from '../helpers/fixtures';

const app = createApp();

interface Session {
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

/** A real sign-in, so every token under test was minted the way a user's is. */
async function signIn(): Promise<Session> {
  const user = await createUser();
  const response = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: user.email, password: TEST_PASSWORD })
    .expect(200);

  return {
    userId: user.id,
    email: user.email,
    accessToken: response.body.data.accessToken as string,
    refreshToken: response.body.data.refreshToken as string,
  };
}

function postRefresh(refreshToken: string): request.Test {
  return request(app).post('/api/v1/auth/refresh').send({ refreshToken });
}

/** The cheapest authenticated call there is — used purely to ask "am I still in?". */
function callAsUser(accessToken: string): request.Test {
  return request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`);
}

/** The stored row behind a raw token. Only the digest is ever persisted. */
async function rowFor(refreshToken: string): Promise<RefreshToken> {
  const row = await RefreshToken.findOne({ where: { tokenHash: sha256(refreshToken) } });
  if (!row) throw new Error('expected the presented token to have a stored row');
  return row;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeDatabaseConnection();
});

describe('rotation', () => {
  it('mints a different refresh token and retires the one presented', async () => {
    const session = await signIn();
    const before = await rowFor(session.refreshToken);

    const rotated = await postRefresh(session.refreshToken).expect(200);
    const next = rotated.body.data.refreshToken as string;

    expect(next).not.toBe(session.refreshToken);
    // The new access token is usable straight away: a client that cannot act on
    // the response has not been refreshed, whatever the status code said.
    await callAsUser(rotated.body.data.accessToken as string).expect(200);
    await postRefresh(next).expect(200);

    // And the retired row records what replaced it, which is the chain reuse
    // detection walks when it has to explain itself later.
    const retired = await before.reload();
    expect(retired.revokedAt).not.toBeNull();
    expect(retired.revokedReason).toBe('ROTATED');
    expect(retired.replacedByTokenId).toBe((await rowFor(next)).id);
  });

  it('leaves an audit trail for the refresh, not only for the failures', async () => {
    const session = await signIn();
    const rotated = await postRefresh(session.refreshToken).expect(200);
    const issued = await rowFor(rotated.body.data.refreshToken as string);

    // `USER_TOKEN_REFRESHED` was declared and emitted by nothing, so a session
    // that had been rotating for months looked identical to one that had never
    // been used — and a burnt family had an alarm with no history behind it.
    const audit = await AuditLog.findOne({
      where: { action: AuditActions.USER_TOKEN_REFRESHED, actorUserId: session.userId },
    });

    expect(audit).not.toBeNull();
    expect(audit!.entityType).toBe('refresh_token');
    expect(audit!.entityId).toBe(issued.id);
    expect(audit!.metadata).toMatchObject({ familyId: issued.familyId });
  });
});

describe('reuse detection', () => {
  it('burns the whole family when an already-rotated token is replayed', async () => {
    const session = await signIn();
    const rotated = await postRefresh(session.refreshToken).expect(200);
    const live = rotated.body.data.refreshToken as string;
    const liveAccessToken = rotated.body.data.accessToken as string;
    const { familyId } = await rowFor(live);

    // The replay: a token that was rotated away is still in someone's hands.
    const replayed = await postRefresh(session.refreshToken).expect(401);
    expect(replayed.body.error.code).toBe(ErrorCode.TOKEN_REVOKED);

    // The legitimate user is signed out too, and that is the intended price —
    // the server cannot tell the victim from the thief, so it refuses to serve
    // either rather than let a stolen token keep rotating. Both halves are
    // asserted because both are load-bearing: the refresh token is dead...
    await postRefresh(live).expect(401);
    // ...and so is the access token already in flight, which would otherwise
    // stay good for the rest of its fifteen minutes.
    await callAsUser(liveAccessToken).expect(401);

    const family = await RefreshToken.findAll({ where: { familyId } });
    expect(family.length).toBeGreaterThanOrEqual(2);
    expect(family.every((row) => row.revokedAt !== null)).toBe(true);
    expect(family.some((row) => row.revokedReason === 'REUSE_DETECTED')).toBe(true);
  });

  it('records the theft signal against the token that was replayed', async () => {
    const session = await signIn();
    const presented = await rowFor(session.refreshToken);
    await postRefresh(session.refreshToken).expect(200);
    await postRefresh(session.refreshToken).expect(401);

    const audit = await AuditLog.findOne({
      where: { action: AuditActions.USER_TOKEN_REUSE_DETECTED, actorUserId: session.userId },
    });

    expect(audit).not.toBeNull();
    expect(audit!.entityId).toBe(presented.id);
    expect(audit!.metadata).toMatchObject({ familyId: presented.familyId });
  });

  it('cannot be revived by any token in the burnt family', async () => {
    const session = await signIn();
    const first = (await postRefresh(session.refreshToken).expect(200)).body.data
      .refreshToken as string;
    const second = (await postRefresh(first).expect(200)).body.data.refreshToken as string;
    const { familyId } = await rowFor(second);

    await postRefresh(first).expect(401); // burns the family
    const sizeAfterBurn = await RefreshToken.count({ where: { familyId } });

    // Every token the family ever held, oldest to newest. None of them is a way
    // back in, and — the part worth pinning — none of them mints a new row: a
    // revoked family that can still issue tokens has not been revoked at all.
    for (const token of [session.refreshToken, first, second]) {
      await postRefresh(token).expect(401);
    }

    expect(await RefreshToken.count({ where: { familyId } })).toBe(sizeAfterBurn);
    expect(await RefreshToken.count({ where: { familyId, revokedAt: { [Op.is]: null } } })).toBe(0);
  });

  it('leaves the same user’s other sessions alone', async () => {
    // Two logins are two families. Revocation is keyed on the family precisely
    // so that a theft on the laptop does not sign the phone out as well.
    const user = await createUser();
    const signInOnce = async (): Promise<string> => {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200);
      return response.body.data.refreshToken as string;
    };

    const laptop = await signInOnce();
    const phone = await signInOnce();

    await postRefresh(laptop).expect(200);
    await postRefresh(laptop).expect(401);

    await postRefresh(phone).expect(200);
  });
});

describe('logout-all', () => {
  it('kills an access token minted before it on its very next request', async () => {
    const session = await signIn();
    await callAsUser(session.accessToken).expect(200);

    const result = await request(app)
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);
    expect(result.body.data.sessionsRevoked).toBeGreaterThanOrEqual(1);

    // The token is still signed, unexpired and structurally perfect. It stops
    // working because `authenticate` counts the live rows in its family, and a
    // global sign-out that only took effect at token expiry would leave a
    // fifteen-minute window in which a compromised session still had access.
    const refused = await callAsUser(session.accessToken).expect(401);
    expect(refused.body.error.code).toBe(ErrorCode.TOKEN_REVOKED);

    await postRefresh(session.refreshToken).expect(401);
  });

  it('lets the user sign in again immediately afterwards', async () => {
    // Revocation ends the sessions, not the account: a user who signs out
    // everywhere must not find themselves locked out.
    const session = await signIn();
    await request(app)
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);

    const again = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: session.email, password: TEST_PASSWORD })
      .expect(200);

    await callAsUser(again.body.data.accessToken as string).expect(200);
  });
});

describe('a client that races itself', () => {
  /**
   * Why this case is in the suite at all: before the client grew its
   * single-flight guard (the comment on `refreshAccessToken` in
   * client/src/lib/apiClient.ts), a dashboard firing six queries at once sent
   * six refreshes carrying the same token. Rotation plus reuse detection can
   * turn that into a signed-out user, so what the server does under exactly
   * this interleaving is a property worth pinning rather than discovering in
   * production.
   *
   * **Exactly one racer wins, and this used to be false.** `refresh()` read the
   * stored row, checked `revokedAt`, and only then rotated — a read-then-write
   * with no compare-and-set — so five requests that all read before any of them
   * committed *all* succeeded, and five live tokens came out of one. Nobody was
   * signed out, which is why the client's single-flight guard hid it, but reuse
   * detection was bypassable for as long as that window stayed open: a thief
   * racing the victim got a working token and no alarm fired.
   *
   * The presented token is now spent with `WHERE id = … AND revoked_at IS NULL`,
   * so PostgreSQL serialises the racers and the losers see zero rows updated.
   * They are refused *without* burning the family — a client with two tabs open
   * is not a thief, and signing them out for it would be the cure being worse
   * than the disease.
   */
  it('keeps the session alive when the same token is refreshed several times at once', async () => {
    const session = await signIn();
    const presented = await rowFor(session.refreshToken);
    const { familyId } = presented;

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => postRefresh(session.refreshToken)),
    );

    const accepted = responses.filter((response: Response) => response.status === 200);
    const refused = responses.filter((response: Response) => response.status !== 200);

    // The whole point: one token in, one token out. Five accepted responses
    // would mean five live tokens in one family and a reuse check that never
    // fires.
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(4);
    // A refusal must be one the client can act on: "sign in again", never a
    // 500 that a retry loop would hammer.
    for (const response of refused) {
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe(ErrorCode.TOKEN_REVOKED);
    }

    // The presented token is spent either way — rotated away or burnt.
    expect((await presented.reload()).revokedAt).not.toBeNull();

    // Every token the race produced stays inside the original family, and no
    // request minted more than one. A fork here would be the serious failure:
    // a session whose family `logout-all` and reuse detection never reach,
    // because both are keyed on the family the login started.
    for (const response of accepted) {
      expect((await rowFor(response.body.data.refreshToken as string)).familyId).toBe(familyId);
    }
    expect(await RefreshToken.count({ where: { familyId } })).toBe(1 + accepted.length);

    // And the user is still signed in. The client's own parallelism must never
    // be what ends their session: no row was burnt for reuse, a live token
    // remains, and the access token handed back with it is accepted.
    expect(await RefreshToken.count({ where: { familyId, revokedReason: 'REUSE_DETECTED' } })).toBe(
      0,
    );
    expect(
      await RefreshToken.count({ where: { familyId, revokedAt: { [Op.is]: null } } }),
    ).toBeGreaterThan(0);
    await callAsUser(accepted[0]!.body.data.accessToken as string).expect(200);
    await postRefresh(accepted[0]!.body.data.refreshToken as string).expect(200);
  });
});
