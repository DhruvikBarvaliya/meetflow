/**
 * The email-verification gate, walked the way a person walks it.
 *
 * Everywhere else in the suite, `markEmailVerified` stands in for the user
 * having clicked the link. This file is where the link is actually read out of
 * the outbox and used, because the flow has three failure modes that only show
 * up end to end:
 *
 *  - **The gate is applied but the way out is not reachable.** If
 *    `requireVerifiedEmail` were mounted on `/auth` too, the refusal would be
 *    permanent: the only remedy is a link, and asking for one would be refused
 *    by the thing the link fixes. Asserted directly below.
 *  - **The gate is mounted but nothing enforces it.** A middleware in the chain
 *    that never refuses looks identical from the outside to one that is absent,
 *    so each surface is exercised with an unverified account rather than
 *    assumed to inherit the guard.
 *  - **An invited colleague can never get in.** An invited account is created
 *    by the invitation, so no verification link is ever sent to it. Without
 *    `acceptInvitation` stamping `emailVerifiedAt`, accepting promotes somebody
 *    to ACTIVE and then refuses them every endpoint in the workspace they just
 *    joined.
 *
 * `REQUIRE_EMAIL_VERIFICATION` is forced on here. `tests/setup.ts` leaves it at
 * its default, but pinning it means this file cannot quietly stop testing
 * anything if that default ever moves.
 */
import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as EnvModule from '../../src/config/env';

vi.mock('../../src/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return { ...actual, env: { ...actual.env, REQUIRE_EMAIL_VERIFICATION: true } };
});

import { createApp } from '../../src/app';
import { AuditLog, Notification, User } from '../../src/database/models';
import { closeDatabaseConnection, markEmailVerified, resetDatabase } from '../helpers/fixtures';

const app = createApp();
const password = 'Str0ngPass!2026';

interface Registered {
  email: string;
  token: string;
  userId: string;
}

let counter = 0;

async function register(prefix: string): Promise<Registered> {
  counter += 1;
  const email = `${prefix}-${Date.now()}-${counter}@meetflow.test`;
  const response = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password, firstName: 'Test', lastName: 'Owner', timezone: 'Asia/Kolkata' })
    .expect(201);

  return {
    email,
    token: response.body.data.accessToken as string,
    userId: response.body.data.user.id as string,
  };
}

/**
 * The verification link, read from the outbox.
 *
 * This is the "open the email" step, and it is the closest thing to the real
 * one available without a mail server: the row here is the same row the worker
 * would hand to the provider, and its payload carries the same URL the customer
 * would click. Reading the token out of the database instead would not work —
 * only its SHA-256 is stored, which is the point.
 */
async function verificationTokenFor(email: string): Promise<string> {
  const row = await Notification.findOne({
    where: { type: 'EMAIL_VERIFICATION', recipientAddress: email },
    order: [['createdAt', 'DESC']],
  });
  expect(row, `no verification email was queued for ${email}`).not.toBeNull();

  const url = String((row!.payload as { verificationUrl?: string }).verificationUrl ?? '');
  const token = new URL(url).searchParams.get('token');
  expect(token, `no token in the verification URL for ${email}`).toBeTruthy();
  return token!;
}

function as(token: string) {
  return (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
}

beforeAll(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeDatabaseConnection();
});

describe('the whole journey', () => {
  it('registers, is refused, verifies through the emailed link, and gets in', async () => {
    const account = await register('journey');

    // Refused, and told which problem it is. A client that cannot distinguish
    // this from a permission failure renders a dead end where a link belongs,
    // which is the entire reason this code is not FORBIDDEN.
    const refused = await as(account.token)(
      request(app).post('/api/v1/workspaces').send({ name: 'Too Soon', timezone: 'Asia/Kolkata' }),
    ).expect(403);
    expect(refused.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const token = await verificationTokenFor(account.email);
    await request(app).post('/api/v1/auth/verify-email').send({ token }).expect(200);

    // And now the same call succeeds, with the same access token. Verification
    // must take effect immediately rather than at the next refresh — a user who
    // has just clicked the link is precisely the one watching the screen.
    await as(account.token)(
      request(app)
        .post('/api/v1/workspaces')
        .send({ name: 'Riverside Clinic', timezone: 'Asia/Kolkata' }),
    ).expect(201);
  });

  it('refuses a link that has already been used', async () => {
    const account = await register('replay');
    const token = await verificationTokenFor(account.email);

    await request(app).post('/api/v1/auth/verify-email').send({ token }).expect(200);
    // The token hash is cleared on use, so a replayed link is indistinguishable
    // from an invented one — which is what it should be.
    await request(app).post('/api/v1/auth/verify-email').send({ token }).expect(422);
  });

  it('records the verification', async () => {
    const account = await register('audited');
    await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ token: await verificationTokenFor(account.email) })
      .expect(200);

    const entry = await AuditLog.findOne({
      where: { action: 'user.email_verified', actorUserId: account.userId },
    });
    expect(entry).not.toBeNull();
  });
});

describe('what the gate covers', () => {
  it('refuses the untenanted surfaces, and each is checked rather than assumed', async () => {
    const account = await register('surfaces');

    // Two separate mounts, two separate chances for one to be missed. Both sit
    // *above* the management router precisely so they are not covered by it,
    // which means neither inherits the guard from anywhere.
    for (const call of [
      request(app).get('/api/v1/me/bookings'), // customer portal
      request(app).post('/api/v1/workspaces').send({ name: 'X', timezone: 'UTC' }), // creation
    ]) {
      const response = await as(account.token)(call);
      expect(response.status, `${call.method} ${call.url} should be refused`).toBe(403);
      expect(response.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    }
  });

  it('refuses an operator whose own address is unconfirmed', async () => {
    // The platform surface checks `requirePlatformAdmin` first, so an ordinary
    // account gets told it is not an operator and learns nothing about its own
    // state on a URL it has no business on. Reaching the verification gate
    // therefore requires an actual operator — and an operator account is the
    // highest-value one there is, so it is the last place to make an exception.
    const operator = await register('operator');
    await User.update({ platformRole: 'ADMIN' }, { where: { id: operator.userId } });

    const refused = await as(operator.token)(request(app).get('/api/v1/admin/workspaces')).expect(
      403,
    );
    expect(refused.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('tells an ordinary account it is not an operator, rather than about itself', async () => {
    const account = await register('not-operator');
    const refused = await as(account.token)(request(app).get('/api/v1/admin/workspaces')).expect(
      403,
    );
    expect(refused.body.error.code).toBe('FORBIDDEN');
  });

  it('refuses a member of a workspace whose address is no longer confirmed', async () => {
    const account = await register('member');
    await markEmailVerified(account.email);
    const workspace = await as(account.token)(
      request(app).post('/api/v1/workspaces').send({ name: 'Unverified Co', timezone: 'UTC' }),
    ).expect(201);
    const businessId = workspace.body.data.business.id as string;

    // The state somebody lands in by changing the address on their account:
    // still a member, still holding a session, no longer confirmed.
    await User.update({ emailVerifiedAt: null }, { where: { id: account.userId } });

    const refused = await as(account.token)(
      request(app).get('/api/v1/appointments').set('X-Business-Id', businessId),
    ).expect(403);
    expect(refused.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('answers 404 rather than the gate when there is no membership to gate', async () => {
    // The ordering assertion. `requireVerifiedEmail` runs *after*
    // `requireTenant` on the management surface, so an invited colleague who has
    // signed in but not yet accepted is told the thing they can act on — that
    // they are not a member yet — instead of being sent to confirm an address
    // no link was ever sent to.
    const account = await register('untenanted');
    const response = await as(account.token)(
      request(app).get('/api/v1/appointments').set('X-Business-Id', crypto.randomUUID()),
    );
    expect(response.status).toBe(404);
  });

  it('leaves the auth surface open, because that is the way out', async () => {
    const account = await register('escape');

    // Every one of these is what an unverified user needs: see who they are,
    // see that they are unverified, ask for another link, and leave.
    const me = await as(account.token)(request(app).get('/api/v1/auth/me')).expect(200);
    expect(me.body.data.user.emailVerified).toBe(false);

    await as(account.token)(request(app).post('/api/v1/auth/verification/resend')).expect(200);
    await as(account.token)(request(app).post('/api/v1/auth/logout')).expect(204);
  });

  it('does not touch public booking', async () => {
    // Unauthenticated and unrelated: a customer booking an appointment has no
    // MeetFlow account to confirm. A 404 for an unknown slug is the right
    // answer; a 403 would mean the gate had leaked onto the wrong surface.
    await request(app).get('/api/v1/public/booking-links/nothing-here').expect(404);
  });
});

describe('asking for another link', () => {
  it('issues a new one and retires the old', async () => {
    const account = await register('resend');
    const first = await verificationTokenFor(account.email);

    // Past the cooldown, which is measured from registration.
    await User.update(
      { emailVerificationSentAt: new Date(Date.now() - 5 * 60_000) },
      { where: { id: account.userId } },
    );

    await as(account.token)(request(app).post('/api/v1/auth/verification/resend')).expect(200);
    const second = await verificationTokenFor(account.email);
    expect(second).not.toBe(first);

    // Only one live link. Two would mean whichever the user clicks second
    // fails, which reads to them as "the link is broken".
    await request(app).post('/api/v1/auth/verify-email').send({ token: first }).expect(422);
    await request(app).post('/api/v1/auth/verify-email').send({ token: second }).expect(200);
  });

  it('answers the same inside the cooldown, without sending anything', async () => {
    const account = await register('cooldown');
    const before = await Notification.count({
      where: { type: 'EMAIL_VERIFICATION', recipientAddress: account.email },
    });

    // Registration has just sent one, so this is inside the window.
    await as(account.token)(request(app).post('/api/v1/auth/verification/resend')).expect(200);

    const after = await Notification.count({
      where: { type: 'EMAIL_VERIFICATION', recipientAddress: account.email },
    });
    // The 200 is deliberate and the silence is the point: a caller holding a
    // valid session could otherwise mail-bomb the address on the account, which
    // for a mistyped registration is a stranger's inbox.
    expect(after).toBe(before);
  });

  it('answers the same for an account that is already verified', async () => {
    const account = await register('already');
    await markEmailVerified(account.email);

    await as(account.token)(request(app).post('/api/v1/auth/verification/resend')).expect(200);

    // Nothing new queued: there is nothing to confirm.
    const row = await User.findByPk(account.userId);
    expect(row!.emailVerifiedAt).not.toBeNull();
  });

  it('refuses an unauthenticated caller', async () => {
    // Not an open endpoint. Without a session it would take an address, which
    // makes it both an enumeration oracle and a way to mail anybody on demand.
    await request(app).post('/api/v1/auth/verification/resend').expect(401);
  });
});

describe('an invited colleague', () => {
  it('is verified by accepting, because no link is ever sent to them', async () => {
    // The deadlock this prevents: an invited account is created by the
    // invitation itself, so nothing ever mails it a verification link. Promoted
    // to ACTIVE and left unverified, the colleague would be refused every
    // endpoint in the workspace they just joined, with the remedy being a link
    // that does not exist.
    const owner = await register('inviter');
    await markEmailVerified(owner.email);

    const workspace = await as(owner.token)(
      request(app).post('/api/v1/workspaces').send({ name: 'Invite Co', timezone: 'UTC' }),
    ).expect(201);
    const businessId = workspace.body.data.business.id as string;

    const roles = await as(owner.token)(
      request(app).get('/api/v1/workspace/roles').set('X-Business-Id', businessId),
    ).expect(200);
    const staffRole = (roles.body.data as Array<{ id: string; key: string }>).find(
      (role) => role.key === 'STAFF',
    );

    // The colleague registers first, because an invitation mints a password
    // nobody holds.
    const colleague = await register('invitee');
    await as(owner.token)(
      request(app)
        .post('/api/v1/members/invite')
        .set('X-Business-Id', businessId)
        .send({ email: colleague.email, roleId: staffRole!.id }),
    ).expect(201);

    // Both of these must work for an unverified caller, which is why
    // `memberInvitesRouter` is the one authenticated surface without the gate.
    const invitations = await as(colleague.token)(
      request(app).get('/api/v1/members/invitations'),
    ).expect(200);
    const invitation = (invitations.body.data as Array<{ token: string }>)[0];
    expect(invitation).toBeDefined();

    // Unverified up to this point — the invitation is what proves the mailbox.
    expect((await User.findByPk(colleague.userId))!.emailVerifiedAt).toBeNull();

    await as(colleague.token)(
      request(app).post('/api/v1/members/accept').send({ token: invitation!.token }),
    ).expect(200);

    expect((await User.findByPk(colleague.userId))!.emailVerifiedAt).not.toBeNull();

    // And the workspace is actually usable, which is the assertion that would
    // fail if acceptance stamped the status but not the address.
    await as(colleague.token)(
      request(app).get('/api/v1/appointments').set('X-Business-Id', businessId),
    ).expect(200);
  });
});
