/**
 * `GET /auth/me` as the client's source of truth, over real HTTP.
 *
 * This endpoint is where a signed-in client learns two things: which workspaces
 * it may act in, and what it may do in the one it has chosen. The second half
 * never worked. `authRouter` mounts straight onto `apiRouter`, above the
 * management chain, so no request to it ever passed through tenant resolution;
 * `req.tenant` was unset on every call and `activeWorkspace` was
 * unconditionally null. The contract documented a condition — "once a workspace
 * has been selected for the request" — that no code path could satisfy.
 *
 * The visible consequence was a client that kept its own copy of the role
 * catalogue, and a copy is exactly what cannot be right here: per-member GRANT
 * and DENY overrides live on the membership, the server applies them to every
 * single request, and a table compiled into the client cannot see them. So the
 * UI showed controls the server would refuse and hid ones it would allow.
 *
 * The tests are therefore built around overrides rather than around plain role
 * permissions. A role's own grants would pass against a hardcoded table too;
 * only an override distinguishes "the server answered" from "the client
 * guessed". Each one is asserted twice — once in the payload and once against
 * the endpoint the permission guards — because the two agreeing is the property
 * that makes this endpoint worth trusting.
 *
 * The other half of the fix is that resolution is *optional*. `requireTenant`
 * answers 404 to anyone without an ACTIVE membership, and this endpoint has to
 * keep answering for exactly those people: a customer, an invitee who has not
 * accepted, someone who belongs to several workspaces and has not yet chosen.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { Membership, Role } from '../../src/database/models';
import { login } from '../../src/modules/auth/auth.service';
import { PERMISSIONS } from '../../src/modules/auth/permissions';
import {
  TEST_PASSWORD,
  closeDatabaseConnection,
  createUser,
  createWorkspace,
  resetDatabase,
  type WorkspaceFixture,
} from '../helpers/fixtures';

const app = createApp();

let aurora: WorkspaceFixture;
let ownerToken: string;

let staffToken: string;
let staffMembershipId: string;

/** A real identity that belongs to no workspace — a customer, or an invitee. */
let outsiderToken: string;

async function tokenFor(email: string): Promise<string> {
  const session = await login(email, TEST_PASSWORD, {
    ipAddress: null,
    userAgent: null,
    requestId: 'auth-context',
  });
  return session.accessToken;
}

interface ActiveWorkspace {
  businessId: string;
  businessSlug: string;
  timezone: string;
  roleKey: string;
  staffProfileId: string | null;
  permissions: string[];
}

interface MeBody {
  user: { id: string; email: string };
  memberships: Array<{ businessId: string }>;
  activeWorkspace: ActiveWorkspace | null;
}

/** `/auth/me` as the given caller sees it, optionally naming a workspace. */
async function me(token: string, businessId?: string): Promise<MeBody> {
  const call = request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
  if (businessId) call.set('X-Business-Id', businessId);
  const response = await call.expect(200);
  return response.body.data as MeBody;
}

/**
 * Replaces the staff member's override set through the real endpoint, so what
 * is asserted is the loop an owner actually drives — not a row inserted behind
 * the API's back.
 */
async function setOverrides(
  overrides: Array<{ permission: string; effect: 'GRANT' | 'DENY' }>,
): Promise<void> {
  await request(app)
    .put(`/api/v1/members/${staffMembershipId}/permissions`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('X-Business-Id', aurora.business.id)
    .send({ overrides })
    .expect(200);
}

beforeAll(async () => {
  await resetDatabase();
  aurora = await createWorkspace();
  ownerToken = await tokenFor(aurora.user.email);

  const staffUser = await createUser();
  const staffRole = await Role.findOne({
    where: { businessId: aurora.business.id, key: 'STAFF' },
  });
  if (!staffRole) throw new Error('fixture expected the workspace to have a STAFF role');

  const membership = await Membership.create({
    userId: staffUser.id,
    businessId: aurora.business.id,
    roleId: staffRole.id,
    status: 'ACTIVE',
    invitedByUserId: null,
    invitedAt: null,
    joinedAt: new Date(),
  });
  staffMembershipId = membership.id;
  staffToken = await tokenFor(staffUser.email);

  const outsider = await createUser();
  outsiderToken = await tokenFor(outsider.email);
});

afterAll(async () => {
  await closeDatabaseConnection();
});

describe('activeWorkspace', () => {
  it('is populated once a workspace is named', async () => {
    // The regression. This field was null on every response ever served,
    // whatever headers the caller sent.
    const body = await me(ownerToken, aurora.business.id);

    expect(body.activeWorkspace).not.toBeNull();
    expect(body.activeWorkspace?.businessId).toBe(aurora.business.id);
    expect(body.activeWorkspace?.businessSlug).toBe(aurora.business.slug);
    expect(body.activeWorkspace?.roleKey).toBe('BUSINESS_OWNER');
    expect(body.activeWorkspace?.staffProfileId).toBe(aurora.staffProfile.id);
    expect(body.activeWorkspace?.permissions).toContain(PERMISSIONS.ROLES_MANAGE);
  });

  it('is populated without a header when the caller belongs to exactly one workspace', async () => {
    const body = await me(staffToken);
    expect(body.activeWorkspace?.businessId).toBe(aurora.business.id);
    expect(body.activeWorkspace?.roleKey).toBe('STAFF');
  });

  it('carries the role template, narrowed to what this role really holds', async () => {
    const body = await me(staffToken, aurora.business.id);
    const permissions = body.activeWorkspace?.permissions ?? [];

    expect(permissions).toContain(PERMISSIONS.WORKSPACE_READ);
    expect(permissions).toContain(PERMISSIONS.CUSTOMERS_READ_ASSIGNED);
    // The narrower `:assigned` variant is not additional to the unscoped one —
    // a client that assumed otherwise would draw the whole address book.
    expect(permissions).not.toContain(PERMISSIONS.CUSTOMERS_READ);
    expect(permissions).not.toContain(PERMISSIONS.ANALYTICS_READ);
  });
});

describe('per-member overrides, which no client-side table can see', () => {
  it('drops a DENYed permission, and the endpoint refuses in the same breath', async () => {
    // Held by the STAFF role, so the only thing that can remove it is the
    // override — which is precisely what a mirrored role catalogue misses.
    const before = await me(staffToken, aurora.business.id);
    expect(before.activeWorkspace?.permissions).toContain(PERMISSIONS.WORKSPACE_READ);

    await setOverrides([{ permission: PERMISSIONS.WORKSPACE_READ, effect: 'DENY' }]);

    const after = await me(staffToken, aurora.business.id);
    expect(after.activeWorkspace?.permissions).not.toContain(PERMISSIONS.WORKSPACE_READ);

    // The assertion that makes the previous one mean something: the payload and
    // the enforcement are the same answer, computed by the same code.
    await request(app)
      .get('/api/v1/workspace')
      .set('Authorization', `Bearer ${staffToken}`)
      .set('X-Business-Id', aurora.business.id)
      .expect(403);
  });

  it('adds a GRANTed permission the role never had, and the endpoint allows it', async () => {
    await setOverrides([{ permission: PERMISSIONS.ANALYTICS_READ, effect: 'GRANT' }]);

    const body = await me(staffToken, aurora.business.id);
    expect(body.activeWorkspace?.permissions).toContain(PERMISSIONS.ANALYTICS_READ);
    // The DENY from the previous test was replaced, not merged — the endpoint
    // takes the complete set — so this permission is back too.
    expect(body.activeWorkspace?.permissions).toContain(PERMISSIONS.WORKSPACE_READ);

    await request(app)
      .get('/api/v1/workspace')
      .set('Authorization', `Bearer ${staffToken}`)
      .set('X-Business-Id', aurora.business.id)
      .expect(200);
  });

  it('lets DENY beat GRANT on the same permission', async () => {
    // Both effects cannot coexist on one pair — the composite key forbids it —
    // so the interesting case is a DENY on something the role already grants
    // alongside a GRANT of something else. Order must not matter.
    await setOverrides([
      { permission: PERMISSIONS.ANALYTICS_READ, effect: 'GRANT' },
      { permission: PERMISSIONS.SERVICES_READ, effect: 'DENY' },
    ]);

    const permissions = (await me(staffToken, aurora.business.id)).activeWorkspace?.permissions;
    expect(permissions).toContain(PERMISSIONS.ANALYTICS_READ);
    expect(permissions).not.toContain(PERMISSIONS.SERVICES_READ);

    await setOverrides([]);
    const restored = (await me(staffToken, aurora.business.id)).activeWorkspace?.permissions;
    expect(restored).toContain(PERMISSIONS.SERVICES_READ);
    expect(restored).not.toContain(PERMISSIONS.ANALYTICS_READ);
  });
});

describe('callers with no workspace to resolve', () => {
  it('answers a user who belongs to nothing at all', async () => {
    // The reason this is `optionalTenant` and not `requireTenant`: the latter
    // 404s anyone without an ACTIVE membership, which is every customer and
    // every invitee who has not accepted yet.
    const body = await me(outsiderToken);

    expect(body.memberships).toEqual([]);
    expect(body.activeWorkspace).toBeNull();
    expect(body.user.id).toBeTruthy();
  });

  it('answers a malformed workspace id with a null workspace, not a 404', async () => {
    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-Business-Id', 'not-a-uuid')
      .expect(200);

    expect(response.body.data.activeWorkspace).toBeNull();
  });

  it("answers another tenant's workspace id with a null workspace", async () => {
    const rival = await createWorkspace();

    const body = await me(ownerToken, rival.business.id);
    expect(body.activeWorkspace).toBeNull();
    // And says nothing about whether that id exists.
    expect(body.memberships.map((row) => row.businessId)).toEqual([aurora.business.id]);
  });

  it('leaves the choice open when the caller belongs to several and named none', async () => {
    // `requireTenant` refuses this case and tells the client to choose. Here
    // that would be circular: this endpoint is where the list to choose from
    // comes from.
    const second = await request(app)
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Aurora Annexe', timezone: 'Asia/Kolkata' })
      .expect(201);
    const secondId = second.body.data.business.id as string;

    const ambiguous = await me(ownerToken);
    expect(ambiguous.memberships).toHaveLength(2);
    expect(ambiguous.activeWorkspace).toBeNull();

    // Naming one resolves it, and resolves it to the one that was named.
    const chosen = await me(ownerToken, secondId);
    expect(chosen.activeWorkspace?.businessId).toBe(secondId);
  });
});
