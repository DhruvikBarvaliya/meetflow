/**
 * Tenant resolution and permission enforcement, exercised over real HTTP.
 *
 * The first test here is a regression guard. `requireTenant` eagerly loads a
 * member's permission overrides, and a `required: true` on the *nested*
 * Permission include silently promoted that LEFT JOIN to an INNER JOIN — which
 * excluded every member who had no overrides, i.e. almost everyone. The whole
 * management API returned 404 while unit tests and typechecking stayed green.
 * Only an end-to-end request catches this class of bug.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import {
  Membership,
  MembershipPermission,
  Permission,
  Role,
  RolePermission,
} from '../../src/database/models';
import { PERMISSIONS } from '../../src/modules/auth/permissions';
import { closeDatabaseConnection, resetDatabase } from '../helpers/fixtures';

const app = createApp();
const password = 'Str0ngPass!2026';

interface Session {
  token: string;
  email: string;
  businessId: string;
  membershipId: string;
}

async function registerAndCreateWorkspace(tag: string, name: string): Promise<Session> {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@meetflow.test`;

  const registration = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password, firstName: 'Test', lastName: 'Owner', timezone: 'Asia/Kolkata' })
    .expect(201);

  const token = registration.body.data.accessToken as string;

  const workspace = await request(app)
    .post('/api/v1/workspaces')
    .set('Authorization', `Bearer ${token}`)
    .send({ name, timezone: 'Asia/Kolkata' })
    .expect(201);

  const businessId = workspace.body.data.business.id as string;
  const membership = await Membership.findOne({ where: { businessId } });

  return { token, email, businessId, membershipId: membership!.id };
}

let owner: Session;
let rival: Session;

beforeAll(async () => {
  await resetDatabase();
  owner = await registerAndCreateWorkspace('owner', 'Aurora Studio');
  rival = await registerAndCreateWorkspace('rival', 'Rival Studio');
});

afterAll(async () => {
  await closeDatabaseConnection();
});

describe('tenant resolution', () => {
  it('resolves a membership that has no permission overrides (regression)', async () => {
    const response = await request(app)
      .get('/api/v1/workspace')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('X-Business-Id', owner.businessId)
      .expect(200);

    expect(response.body.data.id).toBe(owner.businessId);
  });

  it('auto-selects the only workspace when no header is sent', async () => {
    await request(app)
      .get('/api/v1/workspace')
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
  });

  it('reports the resolved workspace and permissions on /auth/me', async () => {
    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('X-Business-Id', owner.businessId)
      .expect(200);

    expect(response.body.data.memberships).toHaveLength(1);
  });

  it('rejects a malformed workspace id as not found rather than a 500', async () => {
    await request(app)
      .get('/api/v1/workspace')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('X-Business-Id', 'not-a-uuid')
      .expect(404);
  });
});

describe('cross-tenant isolation', () => {
  it("returns 404 when using another tenant's workspace id", async () => {
    await request(app)
      .get('/api/v1/workspace')
      .set('Authorization', `Bearer ${rival.token}`)
      .set('X-Business-Id', owner.businessId)
      .expect(404);
  });

  it("returns 404 — not 403 — for another tenant's resource id", async () => {
    const created = await request(app)
      .post('/api/v1/locations')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('X-Business-Id', owner.businessId)
      .send({ name: 'Bandra', type: 'PHYSICAL', timezone: 'Asia/Kolkata' })
      .expect(201);

    const locationId = created.body.data.id as string;

    // A 403 here would confirm the record exists, turning the endpoint into an
    // existence oracle for other tenants' ids.
    await request(app)
      .get(`/api/v1/locations/${locationId}`)
      .set('Authorization', `Bearer ${rival.token}`)
      .set('X-Business-Id', rival.businessId)
      .expect(404);
  });

  it('lists only the caller’s own workspace data', async () => {
    const response = await request(app)
      .get('/api/v1/locations')
      .set('Authorization', `Bearer ${rival.token}`)
      .set('X-Business-Id', rival.businessId)
      .expect(200);

    expect(response.body.meta.totalItems).toBe(0);
  });
});

describe('permission enforcement', () => {
  it('refuses an action the role does not grant', async () => {
    // Demote the owner to the STAFF role, which cannot manage locations.
    const staffRole = await Role.findOne({
      where: { businessId: owner.businessId, key: 'STAFF' },
    });
    const membership = await Membership.findByPk(owner.membershipId);
    const originalRoleId = membership!.roleId;
    await membership!.update({ roleId: staffRole!.id });

    try {
      await request(app)
        .post('/api/v1/locations')
        .set('Authorization', `Bearer ${owner.token}`)
        .set('X-Business-Id', owner.businessId)
        .send({ name: 'Should Fail', type: 'PHYSICAL', timezone: 'Asia/Kolkata' })
        .expect(403);
    } finally {
      await membership!.update({ roleId: originalRoleId });
    }
  });

  it('applies a DENY override on top of a granting role', async () => {
    const permission = await Permission.findOne({
      where: { key: PERMISSIONS.LOCATIONS_MANAGE },
    });
    await MembershipPermission.create({
      membershipId: owner.membershipId,
      permissionId: permission!.id,
      effect: 'DENY',
    });

    try {
      await request(app)
        .post('/api/v1/locations')
        .set('Authorization', `Bearer ${owner.token}`)
        .set('X-Business-Id', owner.businessId)
        .send({ name: 'Denied', type: 'PHYSICAL', timezone: 'Asia/Kolkata' })
        .expect(403);
    } finally {
      await MembershipPermission.destroy({
        where: { membershipId: owner.membershipId, permissionId: permission!.id },
      });
    }
  });

  it('applies a GRANT override on top of a restrictive role', async () => {
    const staffRole = await Role.findOne({
      where: { businessId: owner.businessId, key: 'STAFF' },
    });
    const permission = await Permission.findOne({
      where: { key: PERMISSIONS.LOCATIONS_MANAGE },
    });
    const membership = await Membership.findByPk(owner.membershipId);
    const originalRoleId = membership!.roleId;

    await membership!.update({ roleId: staffRole!.id });
    await MembershipPermission.create({
      membershipId: owner.membershipId,
      permissionId: permission!.id,
      effect: 'GRANT',
    });

    try {
      await request(app)
        .post('/api/v1/locations')
        .set('Authorization', `Bearer ${owner.token}`)
        .set('X-Business-Id', owner.businessId)
        .send({ name: 'Granted', type: 'PHYSICAL', timezone: 'Asia/Kolkata' })
        .expect(201);
    } finally {
      await MembershipPermission.destroy({
        where: { membershipId: owner.membershipId, permissionId: permission!.id },
      });
      await membership!.update({ roleId: originalRoleId });
    }
  });

  it('grants the owner role every permission in the catalogue', async () => {
    const [ownerRole, permissionCount] = await Promise.all([
      Role.findOne({ where: { businessId: owner.businessId, key: 'BUSINESS_OWNER' } }),
      Permission.count(),
    ]);
    const granted = await RolePermission.count({ where: { roleId: ownerRole!.id } });
    expect(granted).toBe(permissionCount);
  });
});

describe('authentication guards', () => {
  it('rejects a management request with no token', async () => {
    await request(app).get('/api/v1/workspace').expect(401);
  });

  it('rejects a management request with a tampered token', async () => {
    await request(app)
      .get('/api/v1/workspace')
      .set('Authorization', 'Bearer not.a.real.token')
      .expect(401);
  });

  it('does not let an unknown management path be probed', async () => {
    // 401 rather than 404: the endpoint list must not be enumerable.
    await request(app).get('/api/v1/definitely-not-a-route').expect(401);
  });
});
