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
  Appointment,
  BookingLink,
  Customer,
  Location,
  Membership,
  MembershipPermission,
  Permission,
  Role,
  RolePermission,
  Service,
  ServiceStaff,
  StaffProfile,
} from '../../src/database/models';
import { login } from '../../src/modules/auth/auth.service';
import { PERMISSIONS } from '../../src/modules/auth/permissions';
import {
  TEST_PASSWORD,
  type WorkspaceFixture,
  closeDatabaseConnection,
  createWorkspace,
  markEmailVerified,
  nextWeekdayAt,
  resetDatabase,
} from '../helpers/fixtures';

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
  // Past the verification gate. The real flow is exercised in
  // `emailVerification.test.ts`; here it is arrangement, standing in for the
  // user having clicked the link before this test began.
  await markEmailVerified(email);

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

/**
 * Cross-tenant **writes**.
 *
 * The block above proves a rival cannot read another workspace's rows. It
 * proves nothing about whether they can change them, and the two are not the
 * same guard: reads are scoped by a WHERE clause in a list or detail query,
 * while every write resolves its target through its own
 * `find…OrFail(businessId, id)` — a separate line per module, each one a
 * forgotten `businessId` away from letting one workspace rename, empty or
 * delete another's data. Nothing in the suite would have noticed.
 *
 * Modification is the worse half of the leak, which is why it is the half worth
 * proving. A workspace that can be *read* by a rival loses its privacy; one
 * that can be *written* by a rival loses its bookings, its staff assignments
 * and its customer records, and hears about it from its customers.
 *
 * Every case asserts two things, and the second is the load-bearing one:
 *
 *  - the answer is **404, not 403** — the same rule the reads follow, because a
 *    403 confirms the row exists and turns every write endpoint into an
 *    existence oracle for other workspaces' ids;
 *  - the target row is **genuinely unchanged** afterwards. A status code is the
 *    server's claim about what it did; re-reading the row is the evidence. A
 *    handler that mutated first and threw afterwards would answer 404 too.
 *
 * The victim is a full fixture workspace rather than one of the sessions above,
 * because a workspace with nothing in it cannot demonstrate that nothing was
 * taken from it. The attacker is `rival`, acting inside their own workspace
 * with a role that grants every permission — so the only thing that can refuse
 * these requests is tenant scoping.
 */
describe('cross-tenant writes', () => {
  let victim: WorkspaceFixture;
  let victimToken: string;
  let locationId: string;
  let bookingLinkId: string;
  let appointmentId: string;
  let appointmentStatus: string;
  let rivalBaseline: Record<string, number>;

  /** Authenticated as the rival, acting inside the rival's own workspace. */
  function asRival(attempt: request.Test): request.Test {
    return attempt
      .set('Authorization', `Bearer ${rival.token}`)
      .set('X-Business-Id', rival.businessId);
  }

  /** The same request, sent by the workspace that actually owns the rows. */
  function asVictim(attempt: request.Test): request.Test {
    return attempt
      .set('Authorization', `Bearer ${victimToken}`)
      .set('X-Business-Id', victim.business.id);
  }

  /**
   * What the rival's own workspace holds. Compared before and after, because
   * "the rival gained nothing" is a different claim from "the victim lost
   * nothing" and only one of them is proved by a 404.
   */
  async function rivalRowCounts(): Promise<Record<string, number>> {
    const where = { businessId: rival.businessId };
    const [services, staff, customers, appointments, locations, bookingLinks] = await Promise.all([
      Service.count({ where }),
      StaffProfile.count({ where }),
      Customer.count({ where }),
      Appointment.count({ where }),
      Location.count({ where }),
      BookingLink.count({ where }),
    ]);
    return { services, staff, customers, appointments, locations, bookingLinks };
  }

  beforeAll(async () => {
    rivalBaseline = await rivalRowCounts();
    victim = await createWorkspace();
    const session = await login(victim.user.email, TEST_PASSWORD, {
      ipAddress: null,
      userAgent: null,
      requestId: 'tenancy-writes',
    });
    victimToken = session.accessToken;

    const location = await asVictim(request(app).post('/api/v1/locations'))
      .send({ name: 'Aurora Bandra', type: 'PHYSICAL', timezone: 'UTC' })
      .expect(201);
    locationId = location.body.data.id as string;

    const bookingLink = await asVictim(request(app).post('/api/v1/booking-links'))
      .send({ name: 'Aurora Front Desk', type: 'CATALOG', serviceIds: [victim.service.id] })
      .expect(201);
    bookingLinkId = bookingLink.body.data.id as string;

    // Booked through the API rather than inserted, so the row under attack is
    // the same shape a real one has — participants, staff reservation and all.
    const booked = await asVictim(request(app).post('/api/v1/appointments'))
      .send({
        serviceId: victim.service.id,
        staffProfileId: victim.staffProfile.id,
        startsAt: nextWeekdayAt(10).toISOString(),
        timezone: 'UTC',
        customer: { firstName: 'Ada', lastName: 'Customer', email: victim.customer.email },
      })
      .expect(201);
    appointmentId = booked.body.data.appointment.id as string;
    appointmentStatus = booked.body.data.appointment.status as string;
  });

  it('refuses a write aimed at the victim’s workspace id in the header', async () => {
    // The most direct attempt there is: the rival's own token, the victim's
    // workspace named in `X-Business-Id`. `requireTenant` resolves the tenant
    // from an ACTIVE membership, so this dies before any handler runs.
    await request(app)
      .patch(`/api/v1/services/${victim.service.id}`)
      .set('Authorization', `Bearer ${rival.token}`)
      .set('X-Business-Id', victim.business.id)
      .send({ name: 'Seized' })
      .expect(404);

    expect((await Service.findByPk(victim.service.id))!.name).toBe(victim.service.name);
  });

  it('cannot rename, re-staff or delete another workspace’s service', async () => {
    const staffBefore = await ServiceStaff.count({ where: { serviceId: victim.service.id } });

    await asRival(request(app).patch(`/api/v1/services/${victim.service.id}`))
      .send({ name: 'Seized', priceAmount: 1 })
      .expect(404);

    // An empty roster needs no ids of the rival's own, which is what makes it
    // the sharpest version of this attack: a body with nothing in it must still
    // not reach a foreign service's assignments.
    await asRival(request(app).put(`/api/v1/services/${victim.service.id}/staff`))
      .send({ staffProfileIds: [] })
      .expect(404);

    await asRival(request(app).delete(`/api/v1/services/${victim.service.id}`)).expect(404);

    const service = await Service.findByPk(victim.service.id);
    // The model is paranoid, so `findByPk` skips soft-deleted rows: getting one
    // back is itself the proof that the DELETE did not land.
    expect(service).not.toBeNull();
    expect(service!.name).toBe(victim.service.name);
    expect(service!.priceAmount).toBe(victim.service.priceAmount);
    expect(await ServiceStaff.count({ where: { serviceId: victim.service.id } })).toBe(staffBefore);
  });

  it('cannot rename or delete another workspace’s staff profile', async () => {
    await asRival(request(app).patch(`/api/v1/staff/${victim.staffProfile.id}`))
      .send({ displayName: 'Seized', isBookable: false })
      .expect(404);

    await asRival(request(app).delete(`/api/v1/staff/${victim.staffProfile.id}`)).expect(404);

    const staff = await StaffProfile.findByPk(victim.staffProfile.id);
    expect(staff).not.toBeNull();
    expect(staff!.displayName).toBe(victim.staffProfile.displayName);
    expect(staff!.isBookable).toBe(victim.staffProfile.isBookable);
  });

  it('cannot edit or delete another workspace’s customer', async () => {
    // The address book is the record a rival would most want to rewrite: an
    // edited email address silently redirects that person's confirmations.
    await asRival(request(app).patch(`/api/v1/customers/${victim.customer.id}`))
      .send({ firstName: 'Seized', email: 'attacker@meetflow.test' })
      .expect(404);

    await asRival(request(app).delete(`/api/v1/customers/${victim.customer.id}`)).expect(404);

    const customer = await Customer.findByPk(victim.customer.id);
    expect(customer).not.toBeNull();
    expect(customer!.firstName).toBe(victim.customer.firstName);
    expect(customer!.email).toBe(victim.customer.email);
  });

  it('cannot annotate, reschedule or cancel another workspace’s appointment', async () => {
    const before = await Appointment.findByPk(appointmentId);

    await asRival(request(app).patch(`/api/v1/appointments/${appointmentId}`))
      .send({ internalNotes: 'Seized' })
      .expect(404);

    await asRival(request(app).post(`/api/v1/appointments/${appointmentId}/reschedule`))
      .send({ startsAt: new Date(before!.startsAt.getTime() + 60 * 60_000).toISOString() })
      .expect(404);

    // The one that would be noticed immediately: a cancellation also emails the
    // customer, so a leak here is a rival cancelling a competitor's diary.
    await asRival(request(app).post(`/api/v1/appointments/${appointmentId}/cancel`))
      .send({ reason: 'Seized' })
      .expect(404);

    const after = await Appointment.findByPk(appointmentId);
    expect(after!.status).toBe(appointmentStatus);
    expect(after!.internalNotes).toBe(before!.internalNotes);
    expect(after!.startsAt.getTime()).toBe(before!.startsAt.getTime());
  });

  it('cannot edit or delete another workspace’s location', async () => {
    await asRival(request(app).patch(`/api/v1/locations/${locationId}`))
      .send({ name: 'Seized', isActive: false })
      .expect(404);

    await asRival(request(app).delete(`/api/v1/locations/${locationId}`)).expect(404);

    const location = await Location.findByPk(locationId);
    expect(location).not.toBeNull();
    expect(location!.name).toBe('Aurora Bandra');
    expect(location!.isActive).toBe(true);
  });

  it('cannot edit, re-point or delete another workspace’s booking link', async () => {
    // A booking link is a public page. Deactivating one takes a workspace off
    // the internet; re-pointing its catalogue changes what the public can book.
    await asRival(request(app).patch(`/api/v1/booking-links/${bookingLinkId}`))
      .send({ name: 'Seized', isActive: false })
      .expect(404);

    await asRival(request(app).put(`/api/v1/booking-links/${bookingLinkId}/services`))
      .send({ serviceIds: [] })
      .expect(404);

    await asRival(request(app).delete(`/api/v1/booking-links/${bookingLinkId}`)).expect(404);

    const link = await BookingLink.findByPk(bookingLinkId);
    expect(link).not.toBeNull();
    expect(link!.name).toBe('Aurora Front Desk');
    expect(link!.isActive).toBe(true);
  });

  it('leaves the rival’s own workspace exactly as it was', async () => {
    // The counterpart to every assertion above: nothing the rival attempted
    // created a row on their side either. A handler that "helpfully" fell back
    // to the caller's tenant on a miss would pass every 404 assertion in this
    // block and still be copying another workspace's data into this one.
    expect(await rivalRowCounts()).toEqual(rivalBaseline);
  });

  it('accepts every one of those requests from the workspace that owns the rows', async () => {
    // The control, and the reason the rest of the block means anything. A 404
    // is also what a mistyped path, an unmounted router or a route declared on
    // the wrong verb answers, so a block made entirely of 404 assertions can
    // pass while proving nothing at all. These are the same URLs and the same
    // verbs, sent by the owner; they must land.
    //
    // Runs last because it is destructive: it ends by deleting the rows the
    // earlier tests assert are still untouched.
    await asVictim(request(app).patch(`/api/v1/services/${victim.service.id}`))
      .send({ name: 'Renamed by its owner' })
      .expect(200);
    await asVictim(request(app).put(`/api/v1/services/${victim.service.id}/staff`))
      .send({ staffProfileIds: [victim.staffProfile.id] })
      .expect(200);
    await asVictim(request(app).patch(`/api/v1/staff/${victim.staffProfile.id}`))
      .send({ displayName: 'Renamed by its owner' })
      .expect(200);
    await asVictim(request(app).patch(`/api/v1/customers/${victim.customer.id}`))
      .send({ firstName: 'Renamed' })
      .expect(200);
    await asVictim(request(app).patch(`/api/v1/locations/${locationId}`))
      .send({ name: 'Renamed by its owner' })
      .expect(200);
    await asVictim(request(app).patch(`/api/v1/booking-links/${bookingLinkId}`))
      .send({ name: 'Renamed by its owner' })
      .expect(200);
    await asVictim(request(app).put(`/api/v1/booking-links/${bookingLinkId}/services`))
      .send({ serviceIds: [victim.service.id] })
      .expect(200);
    await asVictim(request(app).patch(`/api/v1/appointments/${appointmentId}`))
      .send({ internalNotes: 'Written by its owner' })
      .expect(200);

    // Cancelling first: a service, staff member or customer with an upcoming
    // appointment refuses to be deleted, which is a 409 the rival never got
    // close enough to see.
    await asVictim(request(app).post(`/api/v1/appointments/${appointmentId}/cancel`))
      .send({ reason: 'Cancelled by its owner' })
      .expect(200);

    await asVictim(request(app).delete(`/api/v1/booking-links/${bookingLinkId}`)).expect(204);
    await asVictim(request(app).delete(`/api/v1/locations/${locationId}`)).expect(204);
    await asVictim(request(app).delete(`/api/v1/services/${victim.service.id}`)).expect(204);
    await asVictim(request(app).delete(`/api/v1/staff/${victim.staffProfile.id}`)).expect(204);

    /*
     * This line is the one that found the bug.
     *
     * `DELETE /customers/:id` answered 500 for its own owner, in every
     * workspace: `countBlockingAppointments` filtered on
     * `$participants.customerId$`, and Sequelize emits a `$…$` reference
     * verbatim, so the query asked PostgreSQL for a camelCase column on an
     * underscored table and every deletion died on "column
     * participants.customerId does not exist".
     *
     * It survived because the only other coverage of this route asserts a 403
     * and never reaches the query — which is exactly why a control that
     * exercises the *permitted* path belongs beside an isolation test. Without
     * it, the whole block above would pass just as happily against routes that
     * are broken for everybody.
     */
    await asVictim(request(app).delete(`/api/v1/customers/${victim.customer.id}`)).expect(204);
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
