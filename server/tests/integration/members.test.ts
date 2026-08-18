/**
 * Workspace membership, over real HTTP.
 *
 * Until this module existed, `Membership.create` had exactly one call site —
 * workspace creation — so MANAGER, RECEPTIONIST and STAFF were fully specified,
 * fully enforced roles that no deployment could ever reach. These tests are the
 * evidence that the whole loop now closes without anyone editing the database
 * by hand: an address is invited, the invitee sets a password from the email
 * they were sent, signs in, accepts, and their role decides what the very next
 * request may do.
 *
 * Four things are asserted here that cannot be asserted anywhere else.
 *
 *  1. **The invitation chain is end to end.** The set-password link and the
 *     accept link are read out of the queued notification row rather than
 *     fabricated, so a broken template, a missing token or a wrong URL fails
 *     the test instead of passing it.
 *  2. **A role change lands on the next request.** `requireTenant` caches
 *     nothing; the proof is a member who is refused an action, is promoted, and
 *     is allowed it immediately afterwards on the same access token.
 *  3. **The lock-out guards hold.** Owner, self and last-`roles:manage`
 *     protections are the rules that stop a workspace destroying its own
 *     ability to administer itself, and none of them is observable from a unit
 *     test of the service alone.
 *  4. **Every route is guarded.** This module hands out authority, so a caller
 *     without the permission must be refused on all six paths, not on the five
 *     somebody remembered.
 *
 * Where the HTTP response cannot show the effect — a soft-deleted membership
 * row, an audit entry written in the same transaction — the assertion goes to
 * the models directly, the way admin.test.ts does.
 *
 * Wiring note: `server/src/routes/index.ts` is owned by another agent, so the
 * app is assembled here in the shape this module requires. The mount order is
 * the load-bearing part and is the same constraint `workspaceCreationRouter`
 * lives under — `memberInvitesRouter` must be registered *before* the
 * management router, which carries no path prefix and would otherwise apply
 * `requireTenant` to an acceptance request from someone who by definition has
 * no active membership yet.
 */
import express, { Router, type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuditLog,
  Membership,
  MembershipPermission,
  Notification,
  Permission,
  Role,
  User,
} from '../../src/database/models';
import { errorHandler, notFoundHandler } from '../../src/middleware/errorHandler';
import { requestId } from '../../src/middleware/requestContext';
import { AuditActions } from '../../src/modules/audit/audit.service';
import { PERMISSIONS } from '../../src/modules/auth/permissions';
import { memberInvitesRouter, membersRouter } from '../../src/modules/members/members.routes';
import { apiRouter, managementRouter } from '../../src/routes';
import { closeDatabaseConnection, resetDatabase } from '../helpers/fixtures';

managementRouter.use('/members', membersRouter);

function buildApp(): Express {
  const v1 = Router();
  // Before the management router — see the wiring note above.
  v1.use(memberInvitesRouter);
  v1.use(apiRouter);

  const app = express();
  app.use(requestId);
  app.use(express.json());
  app.use('/api/v1', v1);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const app = buildApp();
const PASSWORD = 'Str0ngPass!2026';
const NEW_PASSWORD = 'An0therStr0ng!2026';

let sequence = 0;
function uniqueEmail(tag: string): string {
  sequence += 1;
  return `${tag}-${process.pid}-${sequence}@meetflow.test`;
}

interface Account {
  userId: string;
  email: string;
  token: string;
}

async function registerAccount(tag: string): Promise<Account> {
  const email = uniqueEmail(tag);
  const response = await request(app)
    .post('/api/v1/auth/register')
    .send({
      email,
      password: PASSWORD,
      firstName: 'Test',
      lastName: 'User',
      timezone: 'Asia/Kolkata',
    })
    .expect(201);
  return {
    userId: response.body.data.user.id as string,
    email,
    token: response.body.data.accessToken as string,
  };
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password })
    .expect(200);
  return response.body.data.accessToken as string;
}

async function createWorkspace(account: Account, name: string): Promise<string> {
  const response = await request(app)
    .post('/api/v1/workspaces')
    .set('Authorization', `Bearer ${account.token}`)
    .send({ name, timezone: 'Asia/Kolkata' })
    .expect(201);
  return response.body.data.business.id as string;
}

async function roleId(businessId: string, key: string): Promise<string> {
  const role = await Role.findOne({ where: { businessId, key } });
  if (!role) throw new Error(`role ${key} missing from workspace ${businessId}`);
  return role.id;
}

/** The invitation email as it was actually queued — never a reconstruction. */
async function invitationBody(email: string): Promise<string> {
  const row = await Notification.findOne({
    where: { recipientAddress: email, type: 'MEMBERSHIP_INVITATION' },
    order: [['createdAt', 'DESC']],
  });
  if (!row) throw new Error(`no invitation was queued for ${email}`);
  return row.body ?? '';
}

/** The value of the `token` query parameter on the link that follows `marker`. */
function tokenAfter(body: string, marker: string): string {
  const at = body.indexOf(marker);
  if (at < 0) throw new Error(`no ${marker} link in the invitation email`);
  const raw = body.slice(at + marker.length).split(/\s/)[0] ?? '';
  if (!raw) throw new Error(`empty token after ${marker}`);
  return decodeURIComponent(raw);
}

const ACCEPT_MARKER = '/invitations/accept?token=';
const SET_PASSWORD_MARKER = '/reset-password?token=';

interface Workspace {
  businessId: string;
  owner: Account;
  ownerMembershipId: string;
}

async function createOwnedWorkspace(tag: string, name: string): Promise<Workspace> {
  const owner = await registerAccount(tag);
  const businessId = await createWorkspace(owner, name);
  const membership = await Membership.findOne({ where: { businessId, userId: owner.userId } });
  return { businessId, owner, ownerMembershipId: membership!.id };
}

/** Invites an address, then drives the whole accept flow for an existing account. */
async function inviteAndAccept(
  workspace: Workspace,
  invitee: Account,
  key: string,
): Promise<string> {
  const invited = await request(app)
    .post('/api/v1/members/invite')
    .set('Authorization', `Bearer ${workspace.owner.token}`)
    .set('X-Business-Id', workspace.businessId)
    .send({ email: invitee.email, roleId: await roleId(workspace.businessId, key) })
    .expect(201);

  const token = tokenAfter(await invitationBody(invitee.email), ACCEPT_MARKER);
  await request(app)
    .post('/api/v1/members/accept')
    .set('Authorization', `Bearer ${invitee.token}`)
    .send({ token })
    .expect(200);

  return invited.body.data.id as string;
}

let aurora: Workspace;
let rival: Workspace;

beforeAll(async () => {
  await resetDatabase();
  aurora = await createOwnedWorkspace('aurora-owner', 'Aurora Studio');
  rival = await createOwnedWorkspace('rival-owner', 'Rival Studio');
});

afterAll(async () => {
  await closeDatabaseConnection();
});

describe('inviting an address with no account', () => {
  it('creates the account, the membership and the email in one go', async () => {
    const email = uniqueEmail('fresh');

    const response = await request(app)
      .post('/api/v1/members/invite')
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ email, roleId: await roleId(aurora.businessId, 'STAFF'), firstName: 'Nadia' })
      .expect(201);

    expect(response.body.data.status).toBe('INVITED');
    expect(response.body.data.user.email).toBe(email);
    expect(response.body.data.role.key).toBe('STAFF');
    expect(response.body.data.joinedAt).toBeNull();

    // The account is created in INVITED status: registration refuses an address
    // that already has a row, so without the set-password token in the email
    // this person could never sign in at all.
    const user = await User.findOne({ where: { email } });
    expect(user?.status).toBe('INVITED');

    const audit = await AuditLog.findOne({
      where: { businessId: aurora.businessId, action: AuditActions.MEMBERSHIP_INVITED },
      order: [['createdAt', 'DESC']],
    });
    expect(audit?.entityId).toBe(response.body.data.id);
    expect((audit?.metadata as { accountCreated?: boolean }).accountCreated).toBe(true);
  });

  it('walks the whole chain: set a password, sign in, accept, then work', async () => {
    const email = uniqueEmail('chain');
    await request(app)
      .post('/api/v1/members/invite')
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ email, roleId: await roleId(aurora.businessId, 'MANAGER') })
      .expect(201);

    const body = await invitationBody(email);

    // The set-password step comes first, because a brand-new account has a
    // password nobody holds.
    await request(app)
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token: tokenAfter(body, SET_PASSWORD_MARKER), password: NEW_PASSWORD })
      .expect(200);

    const token = await signIn(email, NEW_PASSWORD);

    // Still only INVITED, so tenant resolution refuses them.
    await request(app)
      .get('/api/v1/workspace')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Business-Id', aurora.businessId)
      .expect(404);

    await request(app)
      .post('/api/v1/members/accept')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: tokenAfter(body, ACCEPT_MARKER) })
      .expect(200);

    await request(app)
      .get('/api/v1/workspace')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Business-Id', aurora.businessId)
      .expect(200);

    // Acceptance proves control of the mailbox, exactly as email verification
    // does, so the account leaves INVITED with it.
    const user = await User.findOne({ where: { email } });
    expect(user?.status).toBe('ACTIVE');
  });
});

describe('inviting an address that already has an account', () => {
  it('attaches a membership without touching the account', async () => {
    const invitee = await registerAccount('existing');

    const response = await request(app)
      .post('/api/v1/members/invite')
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ email: invitee.email, roleId: await roleId(aurora.businessId, 'RECEPTIONIST') })
      .expect(201);

    expect(response.body.data.user.id).toBe(invitee.userId);

    // Exactly one account for the address — an invitation must never fork a
    // second identity for someone who already has one.
    expect(await User.count({ where: { email: invitee.email } })).toBe(1);
    // And it is left completely alone.
    const user = await User.findByPk(invitee.userId);
    expect(user?.status).toBe('ACTIVE');
  });

  it('refuses a second invitation to a live membership', async () => {
    const invitee = await registerAccount('duplicate');
    const role = await roleId(aurora.businessId, 'STAFF');

    await request(app)
      .post('/api/v1/members/invite')
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ email: invitee.email, roleId: role })
      .expect(201);

    const conflict = await request(app)
      .post('/api/v1/members/invite')
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ email: invitee.email, roleId: role })
      .expect(409);

    expect(conflict.body.error.code).toBe('ALREADY_EXISTS');
    // One row, not two: the conflict is answered rather than left to the
    // partial unique index to surface as a 500.
    expect(
      await Membership.count({ where: { businessId: aurora.businessId, userId: invitee.userId } }),
    ).toBe(1);
  });

  it('refuses a role belonging to another workspace with 404, not 403', async () => {
    const invitee = await registerAccount('foreign-role');

    await request(app)
      .post('/api/v1/members/invite')
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      // A 403 here would confirm the role exists, turning the endpoint into an
      // existence oracle for another tenant's ids.
      .send({ email: invitee.email, roleId: await roleId(rival.businessId, 'MANAGER') })
      .expect(404);

    expect(await Membership.count({ where: { userId: invitee.userId } })).toBe(0);
  });
});

describe('acceptance', () => {
  it('lists the caller’s own pending invitations and accepts one', async () => {
    const invitee = await registerAccount('lister');
    await request(app)
      .post('/api/v1/members/invite')
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ email: invitee.email, roleId: await roleId(aurora.businessId, 'STAFF') })
      .expect(201);

    const pending = await request(app)
      .get('/api/v1/members/invitations')
      .set('Authorization', `Bearer ${invitee.token}`)
      .expect(200);

    expect(pending.body.data).toHaveLength(1);
    expect(pending.body.data[0].businessId).toBe(aurora.businessId);

    // The listing re-issues the token, so a lost or filtered email cannot
    // strand a member permanently.
    const accepted = await request(app)
      .post('/api/v1/members/accept')
      .set('Authorization', `Bearer ${invitee.token}`)
      .send({ token: pending.body.data[0].token })
      .expect(200);
    expect(accepted.body.data.status).toBe('ACTIVE');

    // Spent: the membership has left INVITED, so a replay finds nothing.
    await request(app)
      .post('/api/v1/members/accept')
      .set('Authorization', `Bearer ${invitee.token}`)
      .send({ token: pending.body.data[0].token })
      .expect(404);
  });

  it('refuses a forged token and another person’s token alike', async () => {
    const invitee = await registerAccount('victim');
    const bystander = await registerAccount('bystander');
    await request(app)
      .post('/api/v1/members/invite')
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ email: invitee.email, roleId: await roleId(aurora.businessId, 'STAFF') })
      .expect(201);

    const token = tokenAfter(await invitationBody(invitee.email), ACCEPT_MARKER);

    await request(app)
      .post('/api/v1/members/accept')
      .set('Authorization', `Bearer ${invitee.token}`)
      .send({ token: `${token}x` })
      .expect(404);

    // Holding the token is not enough: the session has to belong to the person
    // it was addressed to, and the refusal is indistinguishable from "no such
    // invitation".
    await request(app)
      .post('/api/v1/members/accept')
      .set('Authorization', `Bearer ${bystander.token}`)
      .send({ token })
      .expect(404);
  });
});

describe('role changes and removal', () => {
  it('applies a new role to the very next request', async () => {
    const member = await registerAccount('promoted');
    const membershipId = await inviteAndAccept(aurora, member, 'STAFF');

    // STAFF cannot manage locations.
    await request(app)
      .post('/api/v1/locations')
      .set('Authorization', `Bearer ${member.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ name: 'Should Fail', type: 'PHYSICAL', timezone: 'Asia/Kolkata' })
      .expect(403);

    await request(app)
      .patch(`/api/v1/members/${membershipId}`)
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ roleId: await roleId(aurora.businessId, 'MANAGER') })
      .expect(200);

    // Same access token, no re-login: permissions are re-read per request, so
    // the promotion lands immediately rather than at token expiry.
    await request(app)
      .post('/api/v1/locations')
      .set('Authorization', `Bearer ${member.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ name: 'Bandra', type: 'PHYSICAL', timezone: 'Asia/Kolkata' })
      .expect(201);
  });

  it('suspending a member ends their access without deleting the row', async () => {
    const member = await registerAccount('suspended');
    const membershipId = await inviteAndAccept(aurora, member, 'STAFF');

    await request(app)
      .patch(`/api/v1/members/${membershipId}`)
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ status: 'SUSPENDED' })
      .expect(200);

    await request(app)
      .get('/api/v1/workspace')
      .set('Authorization', `Bearer ${member.token}`)
      .set('X-Business-Id', aurora.businessId)
      .expect(404);

    const membership = await Membership.findByPk(membershipId);
    expect(membership?.status).toBe('SUSPENDED');
    expect(membership?.deletedAt).toBeNull();
  });

  it('removal revokes access, and the same person can be invited back', async () => {
    const member = await registerAccount('returning');
    const membershipId = await inviteAndAccept(aurora, member, 'STAFF');

    await request(app)
      .delete(`/api/v1/members/${membershipId}`)
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .expect(204);

    await request(app)
      .get('/api/v1/workspace')
      .set('Authorization', `Bearer ${member.token}`)
      .set('X-Business-Id', aurora.businessId)
      .expect(404);

    const removed = await Membership.findByPk(membershipId, { paranoid: false });
    expect(removed?.status).toBe('REMOVED');
    expect(removed?.deletedAt).not.toBeNull();

    // The unique index on (user_id, business_id) is partial on
    // `deleted_at IS NULL`, so the address is free again. This is the path that
    // would break if removal were a status change alone.
    const reinvited = await request(app)
      .post('/api/v1/members/invite')
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ email: member.email, roleId: await roleId(aurora.businessId, 'RECEPTIONIST') })
      .expect(201);

    expect(reinvited.body.data.id).not.toBe(membershipId);
    expect(reinvited.body.data.status).toBe('INVITED');
  });

  it('lists removed members only when asked', async () => {
    const visible = await request(app)
      .get('/api/v1/members')
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .query({ pageSize: 100 })
      .expect(200);

    const withRemoved = await request(app)
      .get('/api/v1/members')
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .query({ pageSize: 100, includeRemoved: 'true' })
      .expect(200);

    expect(withRemoved.body.meta.totalItems).toBeGreaterThan(visible.body.meta.totalItems);
    expect(visible.body.data.some((row: { status: string }) => row.status === 'REMOVED')).toBe(
      false,
    );
  });
});

describe('rules that stop a workspace locking itself out', () => {
  it('refuses to let anyone edit or remove their own membership', async () => {
    await request(app)
      .patch(`/api/v1/members/${aurora.ownerMembershipId}`)
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ roleId: await roleId(aurora.businessId, 'STAFF') })
      .expect(409);

    await request(app)
      .delete(`/api/v1/members/${aurora.ownerMembershipId}`)
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .expect(409);

    await request(app)
      .put(`/api/v1/members/${aurora.ownerMembershipId}/permissions`)
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ overrides: [] })
      .expect(409);
  });

  it('protects the owner from a second administrator', async () => {
    const deputy = await registerAccount('deputy');
    await inviteAndAccept(aurora, deputy, 'BUSINESS_OWNER');

    // The deputy holds members:update, members:remove and roles:manage — and
    // still cannot touch the one membership the workspace cannot function
    // without.
    await request(app)
      .patch(`/api/v1/members/${aurora.ownerMembershipId}`)
      .set('Authorization', `Bearer ${deputy.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ status: 'SUSPENDED' })
      .expect(409);

    await request(app)
      .patch(`/api/v1/members/${aurora.ownerMembershipId}`)
      .set('Authorization', `Bearer ${deputy.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ roleId: await roleId(aurora.businessId, 'STAFF') })
      .expect(409);

    await request(app)
      .delete(`/api/v1/members/${aurora.ownerMembershipId}`)
      .set('Authorization', `Bearer ${deputy.token}`)
      .set('X-Business-Id', aurora.businessId)
      .expect(409);

    const owner = await Membership.findByPk(aurora.ownerMembershipId);
    expect(owner?.status).toBe('ACTIVE');
  });

  it('will not demote the last member who can manage roles', async () => {
    // A workspace of its own, so the counting is not disturbed by the deputies
    // the tests above left behind.
    const workspace = await createOwnedWorkspace('lockout-owner', 'Lockout Studio');
    const admin = await registerAccount('lockout-admin');
    const manager = await registerAccount('lockout-manager');
    const adminMembershipId = await inviteAndAccept(workspace, admin, 'BUSINESS_OWNER');
    await inviteAndAccept(workspace, manager, 'MANAGER');

    const staffRole = await roleId(workspace.businessId, 'STAFF');

    // While the owner still holds roles:manage, demoting the other holder is
    // allowed — the guard is about the last one, not about any one.
    await request(app)
      .patch(`/api/v1/members/${adminMembershipId}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .set('X-Business-Id', workspace.businessId)
      .send({ roleId: staffRole })
      .expect(200);

    await request(app)
      .patch(`/api/v1/members/${adminMembershipId}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .set('X-Business-Id', workspace.businessId)
      .send({ roleId: await roleId(workspace.businessId, 'BUSINESS_OWNER') })
      .expect(200);

    // Take the capability away from the owner directly — the API refuses to do
    // it, which is exactly why the guard needs testing from the model side.
    const rolesManage = await Permission.findOne({ where: { key: PERMISSIONS.ROLES_MANAGE } });
    await MembershipPermission.create({
      membershipId: workspace.ownerMembershipId,
      permissionId: rolesManage!.id,
      effect: 'DENY',
    });

    try {
      const refused = await request(app)
        .patch(`/api/v1/members/${adminMembershipId}`)
        .set('Authorization', `Bearer ${manager.token}`)
        .set('X-Business-Id', workspace.businessId)
        .send({ roleId: staffRole })
        .expect(409);
      expect(refused.body.error.message).toContain('last member who can manage roles');

      // Suspension and removal take the same capability away, so they answer
      // the same refusal.
      await request(app)
        .patch(`/api/v1/members/${adminMembershipId}`)
        .set('Authorization', `Bearer ${manager.token}`)
        .set('X-Business-Id', workspace.businessId)
        .send({ status: 'SUSPENDED' })
        .expect(409);

      await request(app)
        .delete(`/api/v1/members/${adminMembershipId}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .set('X-Business-Id', workspace.businessId)
        .expect(409);
    } finally {
      await MembershipPermission.destroy({
        where: { membershipId: workspace.ownerMembershipId, permissionId: rolesManage!.id },
      });
    }
  });

  it('refuses to activate an invitation that was never accepted', async () => {
    const invitee = await registerAccount('never-accepted');
    const invited = await request(app)
      .post('/api/v1/members/invite')
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ email: invitee.email, roleId: await roleId(aurora.businessId, 'STAFF') })
      .expect(201);

    // Otherwise a mistyped address belonging to a real account could be handed
    // a live membership nobody ever asked for.
    await request(app)
      .patch(`/api/v1/members/${invited.body.data.id}`)
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ status: 'ACTIVE' })
      .expect(409);
  });
});

describe('per-member permission overrides', () => {
  it('reports the role grants, the overrides and the effective set', async () => {
    const member = await registerAccount('overridden');
    const membershipId = await inviteAndAccept(aurora, member, 'STAFF');

    const before = await request(app)
      .get(`/api/v1/members/${membershipId}/permissions`)
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .expect(200);

    expect(before.body.data.overrides).toEqual([]);
    expect(before.body.data.rolePermissions).toContain(PERMISSIONS.APPOINTMENTS_READ_OWN);
    expect(before.body.data.effectivePermissions).not.toContain(PERMISSIONS.LOCATIONS_MANAGE);

    const after = await request(app)
      .put(`/api/v1/members/${membershipId}/permissions`)
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({
        overrides: [
          { permission: PERMISSIONS.LOCATIONS_MANAGE, effect: 'GRANT' },
          { permission: PERMISSIONS.APPOINTMENTS_READ_OWN, effect: 'DENY' },
        ],
      })
      .expect(200);

    expect(after.body.data.effectivePermissions).toContain(PERMISSIONS.LOCATIONS_MANAGE);
    expect(after.body.data.effectivePermissions).not.toContain(PERMISSIONS.APPOINTMENTS_READ_OWN);

    // And the middleware agrees, on the member's existing token.
    await request(app)
      .post('/api/v1/locations')
      .set('Authorization', `Bearer ${member.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ name: 'Granted By Override', type: 'PHYSICAL', timezone: 'Asia/Kolkata' })
      .expect(201);

    // A replacement, not a merge: an empty list clears everything.
    const cleared = await request(app)
      .put(`/api/v1/members/${membershipId}/permissions`)
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ overrides: [] })
      .expect(200);
    expect(cleared.body.data.overrides).toEqual([]);

    await request(app)
      .post('/api/v1/locations')
      .set('Authorization', `Bearer ${member.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ name: 'Revoked Again', type: 'PHYSICAL', timezone: 'Asia/Kolkata' })
      .expect(403);
  });

  it('rejects two effects for one permission', async () => {
    const member = await registerAccount('conflicting');
    const membershipId = await inviteAndAccept(aurora, member, 'STAFF');

    await request(app)
      .put(`/api/v1/members/${membershipId}/permissions`)
      .set('Authorization', `Bearer ${aurora.owner.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({
        overrides: [
          { permission: PERMISSIONS.LOCATIONS_MANAGE, effect: 'GRANT' },
          { permission: PERMISSIONS.LOCATIONS_MANAGE, effect: 'DENY' },
        ],
      })
      .expect(422);
  });
});

describe('cross-tenant isolation', () => {
  it("answers 404 for another workspace's membership id on every path", async () => {
    const rivalOwner = `Bearer ${rival.owner.token}`;

    await request(app)
      .patch(`/api/v1/members/${aurora.ownerMembershipId}`)
      .set('Authorization', rivalOwner)
      .set('X-Business-Id', rival.businessId)
      .send({ status: 'SUSPENDED' })
      .expect(404);

    await request(app)
      .delete(`/api/v1/members/${aurora.ownerMembershipId}`)
      .set('Authorization', rivalOwner)
      .set('X-Business-Id', rival.businessId)
      .expect(404);

    await request(app)
      .get(`/api/v1/members/${aurora.ownerMembershipId}/permissions`)
      .set('Authorization', rivalOwner)
      .set('X-Business-Id', rival.businessId)
      .expect(404);

    await request(app)
      .put(`/api/v1/members/${aurora.ownerMembershipId}/permissions`)
      .set('Authorization', rivalOwner)
      .set('X-Business-Id', rival.businessId)
      .send({ overrides: [] })
      .expect(404);
  });

  it('lists only its own workspace’s members', async () => {
    const response = await request(app)
      .get('/api/v1/members')
      .set('Authorization', `Bearer ${rival.owner.token}`)
      .set('X-Business-Id', rival.businessId)
      .query({ pageSize: 100 })
      .expect(200);

    expect(response.body.meta.totalItems).toBe(1);
    expect(response.body.data[0].user.email).toBe(rival.owner.email);
    expect(response.body.data[0].isOwner).toBe(true);
  });
});

describe('permission enforcement', () => {
  /**
   * The test that matters most in this file. This module hands out authority,
   * so a caller who lacks the permission has to be refused on *every* route —
   * a single unguarded one is a privilege-escalation path for anybody already
   * inside the workspace.
   */
  it('refuses a member without the permission on all six routes', async () => {
    const outsider = await registerAccount('outsider');
    await inviteAndAccept(aurora, outsider, 'STAFF');
    const auth = `Bearer ${outsider.token}`;
    const target = aurora.ownerMembershipId;

    await request(app)
      .get('/api/v1/members')
      .set('Authorization', auth)
      .set('X-Business-Id', aurora.businessId)
      .expect(403);

    await request(app)
      .post('/api/v1/members/invite')
      .set('Authorization', auth)
      .set('X-Business-Id', aurora.businessId)
      .send({ email: uniqueEmail('smuggled'), roleId: await roleId(aurora.businessId, 'STAFF') })
      .expect(403);

    await request(app)
      .patch(`/api/v1/members/${target}`)
      .set('Authorization', auth)
      .set('X-Business-Id', aurora.businessId)
      .send({ status: 'SUSPENDED' })
      .expect(403);

    await request(app)
      .delete(`/api/v1/members/${target}`)
      .set('Authorization', auth)
      .set('X-Business-Id', aurora.businessId)
      .expect(403);

    await request(app)
      .get(`/api/v1/members/${target}/permissions`)
      .set('Authorization', auth)
      .set('X-Business-Id', aurora.businessId)
      .expect(403);

    await request(app)
      .put(`/api/v1/members/${target}/permissions`)
      .set('Authorization', auth)
      .set('X-Business-Id', aurora.businessId)
      .send({ overrides: [] })
      .expect(403);
  });

  it('refuses a Manager the right to rewrite the authorisation model', async () => {
    const manager = await registerAccount('manager-limits');
    const membershipId = await inviteAndAccept(aurora, manager, 'MANAGER');

    // A Manager may change who does which job (members:update)…
    await request(app)
      .get('/api/v1/members')
      .set('Authorization', `Bearer ${manager.token}`)
      .set('X-Business-Id', aurora.businessId)
      .expect(200);

    // …but not what a job is allowed to do (roles:manage).
    await request(app)
      .put(`/api/v1/members/${membershipId}/permissions`)
      .set('Authorization', `Bearer ${manager.token}`)
      .set('X-Business-Id', aurora.businessId)
      .send({ overrides: [{ permission: PERMISSIONS.ROLES_MANAGE, effect: 'GRANT' }] })
      .expect(403);
  });

  it('refuses every route without a token at all', async () => {
    await request(app).get('/api/v1/members').expect(401);
    await request(app).post('/api/v1/members/accept').send({ token: 'x' }).expect(401);
    await request(app).get('/api/v1/members/invitations').expect(401);
  });
});
