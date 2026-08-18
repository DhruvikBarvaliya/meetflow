/**
 * The platform-administration surface, over real HTTP.
 *
 * These are the tests that justify `/api/v1/admin` existing as a third router
 * rather than as another mount beside the tenant-scoped ones. Four claims are
 * made about that surface, and none of them can be verified anywhere but here:
 *
 *  1. **It is not behind `requireTenant`.** A platform operator holds no
 *     membership in the workspaces they administer, and tenant resolution
 *     answers 404 to a request without one. Mounted on the management router,
 *     every admin call would 404. The regression that matters most in this file
 *     is therefore the plainest one: an administrator with *zero* memberships
 *     reads every endpoint successfully.
 *  2. **It is behind `requirePlatformAdmin`, at the mount.** An ordinary signed-in
 *     user must be refused on all ten paths, not on the nine somebody remembered.
 *  3. **The privacy boundary is the shape of the response.** No middleware
 *     filters customer PII out of these payloads — the builders in
 *     admin.service.ts simply never put it in. A shape cannot be unit-tested
 *     into safety, so the assertion here is the absence of a real customer's
 *     real email in the real serialised response.
 *  4. **A mutation on this surface changes something.** Suspending a workspace
 *     locks its owner out of tenant resolution; suspending a user ends the
 *     session they are holding right now, on the access token and the refresh
 *     token alike. Both are cross-module consequences that only an end-to-end
 *     request can demonstrate.
 *
 * Where the HTTP response cannot show the effect — a revoked refresh token, an
 * audit row written in the same transaction as the change — the assertion goes
 * to the models directly, the way booking.concurrency.test.ts does.
 *
 * Ordering note: the read suites assert exact platform-wide totals, so they are
 * declared before the mutation suites that change those very figures. Vitest
 * runs files serially (`fileParallelism: false`) and suites in declaration
 * order, which is what makes that safe.
 */
import { Op } from 'sequelize';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import {
  Appointment,
  AuditLog,
  Business,
  Customer,
  Membership,
  RefreshToken,
  Service,
  User,
} from '../../src/database/models';
import type { AppointmentStatus } from '../../src/database/models/Appointment';
import { updatePlatformRole } from '../../src/modules/admin/admin.service';
import { AuditActions } from '../../src/modules/audit/audit.service';
import { ErrorCode } from '../../src/utils/errors';
import { newAppointmentPublicId, newCustomerPublicId, newUuid } from '../../src/utils/ids';
import {
  TEST_PASSWORD,
  closeDatabaseConnection,
  createUser,
  resetDatabase,
} from '../helpers/fixtures';

const app = createApp();

const AURORA_NAME = 'Aurora Clinic Bandra';
const BOREALIS_NAME = 'Borealis Wellness Rooms';

/**
 * A patient of one of the workspaces below, given a name nobody would type by
 * accident. The privacy tests search the serialised admin responses for these
 * three strings; a distinctive value is what makes "not found" meaningful
 * rather than a coincidence of the fixtures.
 */
const PATIENT = {
  firstName: 'Wilhelmina',
  lastName: 'Featherstonehaugh',
  email: 'wilhelmina.featherstonehaugh@patient.invalid',
  notes: 'Prefers the ground-floor consulting room.',
} as const;

const CUSTOMER_NOTE = 'customer-note-must-never-reach-an-operator';
const INTERNAL_NOTE = 'internal-note-must-never-reach-an-operator';

/**
 * What the fixtures create, and therefore what the overview has to report. The
 * numbers are spelled out here rather than counted from the database in the
 * assertions, because a test that recomputes the figure it is checking agrees
 * with the implementation even when both are wrong.
 */
const EXPECTED = {
  workspaces: 2,
  users: 6,
  activeUsers: 5,
  suspendedUsers: 1,
  admins: 1,
  customers: 3,
  appointments: 6,
  upcomingAppointments: 3,
  cancelledAppointments: 1,
  auroraAppointments: 4,
  borealisAppointments: 2,
} as const;

interface Account {
  userId: string;
  email: string;
  token: string;
  refreshToken: string;
}

interface Workspace {
  businessId: string;
  slug: string;
  serviceId: string;
  owner: Account;
}

let admin: Account;
let aurora: Workspace;
let borealis: Workspace;
/** Registered through the API, so it holds a live session to be ended. */
let sessionHolder: Account;
/** The target of the platform-role mutations; never the caller. */
let deputy: User;
/** Already SUSPENDED before any test runs, so the status filter has a subject. */
let dormant: User;

function bearer(token: string): string {
  return `Bearer ${token}`;
}

async function registerAccount(tag: string, firstName: string, lastName: string): Promise<Account> {
  const email = `${tag}-${process.pid}-${Date.now()}@meetflow.test`;
  const response = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: TEST_PASSWORD, firstName, lastName, timezone: 'UTC' })
    .expect(201);

  return {
    userId: response.body.data.user.id as string,
    email,
    token: response.body.data.accessToken as string,
    refreshToken: response.body.data.refreshToken as string,
  };
}

async function createWorkspaceFor(owner: Account, name: string): Promise<Workspace> {
  const response = await request(app)
    .post('/api/v1/workspaces')
    .set('Authorization', bearer(owner.token))
    .send({ name, timezone: 'UTC' })
    .expect(201);

  const businessId = response.body.data.business.id as string;

  // A catalogue entry, so the workspace's `services` count is non-zero and the
  // appointments below have something to point at. Created through the model:
  // this file is about what the admin surface reports, not about how a service
  // comes into being.
  const service = await Service.create({
    businessId,
    categoryId: null,
    name: 'Consultation',
    slug: 'consultation',
    description: null,
    durationMinutes: 30,
    preBufferMinutes: null,
    postBufferMinutes: null,
    priceAmount: 5000,
    capacity: 1,
    minNoticeMinutes: 0,
    maxHorizonDays: null,
    slotIntervalMinutes: 30,
    maxPerCustomerPerDay: null,
    color: null,
  });

  return {
    businessId,
    slug: response.body.data.business.slug as string,
    serviceId: service.id,
    owner,
  };
}

async function addCustomer(
  businessId: string,
  details: { firstName: string; lastName: string; email: string; notes?: string | null },
): Promise<Customer> {
  return Customer.create({
    businessId,
    publicId: newCustomerPublicId(),
    userId: null,
    firstName: details.firstName,
    lastName: details.lastName,
    email: details.email,
    phone: null,
    timezone: 'UTC',
    notes: details.notes ?? null,
    preferredStaffProfileId: null,
    preferredLocationId: null,
    firstAppointmentAt: null,
    lastAppointmentAt: null,
  });
}

/**
 * One appointment row, written directly.
 *
 * The booking engine is exercised at length in booking.concurrency.test.ts;
 * what this file needs is an exact, chosen mix of statuses and start times,
 * which going through availability would not give. Everything the admin surface
 * reads from this table — `status`, `starts_at`, `created_at`, `business_id` —
 * is set here explicitly.
 */
async function addAppointment(input: {
  businessId: string;
  serviceId: string;
  customerId: string;
  status: AppointmentStatus;
  startsAt: Date;
  customerNotes?: string | null;
  internalNotes?: string | null;
}): Promise<Appointment> {
  const endsAt = new Date(input.startsAt.getTime() + 30 * 60_000);
  return Appointment.create({
    publicId: newAppointmentPublicId(),
    businessId: input.businessId,
    serviceId: input.serviceId,
    locationId: null,
    staffProfileId: null,
    teamId: null,
    customerId: input.customerId,
    bookingLinkId: null,
    status: input.status,
    startsAt: input.startsAt,
    endsAt,
    // No buffers, so the calendar footprint is the appointment itself. The
    // table's CHECK requires the buffered window to contain the visible one.
    bufferStartAt: input.startsAt,
    bufferEndAt: endsAt,
    durationMinutes: 30,
    title: 'Consultation',
    customerNotes: input.customerNotes ?? null,
    internalNotes: input.internalNotes ?? null,
    confirmedAt: input.status === 'CONFIRMED' ? new Date() : null,
    checkedInAt: null,
    startedAt: null,
    completedAt: input.status === 'COMPLETED' ? new Date() : null,
    cancelledAt: input.status === 'CANCELLED' ? new Date() : null,
    noShowAt: null,
    cancellationReason: null,
    cancelledByType: null,
    cancelledByUserId: null,
    rescheduledFromId: null,
    idempotencyKey: null,
    createdByUserId: null,
  });
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60_000);
}

/** Every path on the surface, with a body where the route takes one. */
function everyAdminRoute(
  businessId: string,
  userId: string,
): Array<{ method: 'get' | 'patch'; path: string; body?: Record<string, unknown> }> {
  return [
    { method: 'get', path: '/api/v1/admin/overview' },
    { method: 'get', path: '/api/v1/admin/workspaces' },
    { method: 'get', path: `/api/v1/admin/workspaces/${businessId}` },
    {
      method: 'patch',
      path: `/api/v1/admin/workspaces/${businessId}/status`,
      body: { status: 'SUSPENDED' },
    },
    { method: 'get', path: '/api/v1/admin/users' },
    { method: 'get', path: `/api/v1/admin/users/${userId}` },
    {
      method: 'patch',
      path: `/api/v1/admin/users/${userId}/status`,
      body: { status: 'SUSPENDED' },
    },
    {
      method: 'patch',
      path: `/api/v1/admin/users/${userId}/platform-role`,
      body: { platformRole: 'ADMIN' },
    },
    { method: 'get', path: '/api/v1/admin/audit-logs' },
    { method: 'get', path: '/api/v1/admin/health' },
  ];
}

beforeAll(async () => {
  await resetDatabase();

  /*
   * There is no API that mints a platform administrator, and that absence is
   * the design rather than an oversight: a self-service route to ADMIN would be
   * a privilege-escalation endpoint sitting in the middle of the auth surface,
   * and the role is granted by whoever operates the deployment — a migration,
   * a seed, a psql session. This test therefore has to reach for the model,
   * which is exactly what an operator does in production.
   *
   * `authenticate` re-reads the user row on every request, so the token issued
   * at registration would already carry admin authority. Signing in again
   * anyway keeps the token's own `role` claim honest and matches what a real
   * operator holds after being promoted.
   */
  admin = await registerAccount('platform-admin', 'Casey', 'Operator');
  await User.update({ platformRole: 'ADMIN' }, { where: { id: admin.userId } });
  const relogin = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: admin.email, password: TEST_PASSWORD })
    .expect(200);
  admin.token = relogin.body.data.accessToken as string;
  admin.refreshToken = relogin.body.data.refreshToken as string;

  const auroraOwner = await registerAccount('aurora-owner', 'Nadia', 'Rao');
  const borealisOwner = await registerAccount('borealis-owner', 'Tomas', 'Lindqvist');
  aurora = await createWorkspaceFor(auroraOwner, AURORA_NAME);
  borealis = await createWorkspaceFor(borealisOwner, BOREALIS_NAME);

  sessionHolder = await registerAccount('session-holder', 'Priya', 'Shah');

  deputy = await createUser({ firstName: 'Devon' });
  dormant = await createUser({ firstName: 'Dorothy' });
  await dormant.update({ status: 'SUSPENDED' });

  // Aurora: two patients, one of them the one the privacy tests hunt for.
  const patient = await addCustomer(aurora.businessId, PATIENT);
  const secondPatient = await addCustomer(aurora.businessId, {
    firstName: 'Sam',
    lastName: 'Ortega',
    email: `sam-ortega-${process.pid}@patient.invalid`,
  });
  const borealisClient = await addCustomer(borealis.businessId, {
    firstName: 'Ines',
    lastName: 'Duarte',
    email: `ines-duarte-${process.pid}@patient.invalid`,
  });

  // Aurora books four: two live, one called off, one already seen. Only the two
  // live ones sit in the future with a calendar-occupying status, so `upcoming`
  // has something to exclude rather than merely something to count.
  await addAppointment({
    businessId: aurora.businessId,
    serviceId: aurora.serviceId,
    customerId: patient.id,
    status: 'CONFIRMED',
    startsAt: daysFromNow(2),
    customerNotes: CUSTOMER_NOTE,
    internalNotes: INTERNAL_NOTE,
  });
  await addAppointment({
    businessId: aurora.businessId,
    serviceId: aurora.serviceId,
    customerId: secondPatient.id,
    status: 'CONFIRMED',
    startsAt: daysFromNow(3),
  });
  await addAppointment({
    businessId: aurora.businessId,
    serviceId: aurora.serviceId,
    customerId: patient.id,
    status: 'CANCELLED',
    startsAt: daysFromNow(4),
  });
  await addAppointment({
    businessId: aurora.businessId,
    serviceId: aurora.serviceId,
    customerId: secondPatient.id,
    status: 'COMPLETED',
    startsAt: daysFromNow(-2),
  });

  await addAppointment({
    businessId: borealis.businessId,
    serviceId: borealis.serviceId,
    customerId: borealisClient.id,
    status: 'PENDING',
    startsAt: daysFromNow(5),
  });
  await addAppointment({
    businessId: borealis.businessId,
    serviceId: borealis.serviceId,
    customerId: borealisClient.id,
    status: 'COMPLETED',
    startsAt: daysFromNow(-3),
  });
});

afterAll(async () => {
  await closeDatabaseConnection();
});

describe('access control', () => {
  it('refuses an unauthenticated request', async () => {
    await request(app).get('/api/v1/admin/overview').expect(401);
  });

  it('refuses an ordinary signed-in user on every route', async () => {
    const routes = everyAdminRoute(aurora.businessId, sessionHolder.userId);
    expect(routes).toHaveLength(10);

    for (const route of routes) {
      const response = await request(app)
        [route.method](route.path)
        .set('Authorization', bearer(aurora.owner.token))
        .send(route.body ?? {});

      // 403, not 404 or 422: the guard sits at the mount and runs before
      // validation, so a caller who is not an operator learns nothing from the
      // shape of the rejection either.
      expect(response.status, `${route.method.toUpperCase()} ${route.path}`).toBe(403);
    }
  });

  it('answers 404, not 401, for an unknown path once the caller is an operator', async () => {
    // The management router carries no path prefix and would otherwise swallow
    // this request into tenant resolution. `/admin` has its own notFoundHandler
    // terminator for exactly that reason.
    await request(app)
      .get('/api/v1/admin/definitely-not-a-route')
      .set('Authorization', bearer(admin.token))
      .expect(404);
  });

  it('serves every read endpoint to an administrator with no workspace membership', async () => {
    // The regression this whole file exists for. If the surface ever drifts
    // behind `requireTenant`, this operator — who belongs to nothing — starts
    // getting 404s from all seven endpoints at once.
    expect(await Membership.count({ where: { userId: admin.userId } })).toBe(0);

    const readPaths = [
      '/api/v1/admin/overview',
      '/api/v1/admin/workspaces',
      `/api/v1/admin/workspaces/${aurora.businessId}`,
      '/api/v1/admin/users',
      `/api/v1/admin/users/${aurora.owner.userId}`,
      '/api/v1/admin/audit-logs',
      '/api/v1/admin/health',
    ];

    for (const path of readPaths) {
      const response = await request(app).get(path).set('Authorization', bearer(admin.token));
      expect(response.status, path).toBe(200);
    }
  });
});

describe('overview', () => {
  it('reports totals that agree with what the fixtures created', async () => {
    const response = await request(app)
      .get('/api/v1/admin/overview')
      .set('Authorization', bearer(admin.token))
      .expect(200);

    expect(response.body.data.workspaces).toEqual({
      total: EXPECTED.workspaces,
      active: EXPECTED.workspaces,
      suspended: 0,
      archived: 0,
      createdLast30Days: EXPECTED.workspaces,
    });
    expect(response.body.data.users).toEqual({
      total: EXPECTED.users,
      active: EXPECTED.activeUsers,
      invited: 0,
      suspended: EXPECTED.suspendedUsers,
      deactivated: 0,
      admins: EXPECTED.admins,
      createdLast30Days: EXPECTED.users,
    });
    expect(response.body.data.appointments).toEqual({
      total: EXPECTED.appointments,
      // The cancelled booking is in the future and the completed ones are in
      // the past, so only the three live future rows are upcoming.
      upcoming: EXPECTED.upcomingAppointments,
      last30Days: EXPECTED.appointments,
      cancelledLast30Days: EXPECTED.cancelledAppointments,
    });
    expect(response.body.data.customers).toEqual({ total: EXPECTED.customers });
  });

  it('returns a zero-filled fourteen-day booking series ending today', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const response = await request(app)
      .get('/api/v1/admin/overview')
      .set('Authorization', bearer(admin.token))
      .expect(200);

    const series = response.body.data.bookingsByDay as Array<{ date: string; count: number }>;
    expect(series).toHaveLength(14);
    expect(series[13]?.date).toBe(today);

    // Every fixture appointment was inserted moments ago, so the whole platform's
    // volume lands in today's bucket and the preceding thirteen days are the
    // zeros `generate_series` supplies rather than gaps the client must handle.
    expect(series[13]?.count).toBe(EXPECTED.appointments);
    expect(series.slice(0, 13).every((day) => day.count === 0)).toBe(true);
  });

  it('ranks workspaces by the volume they actually booked', async () => {
    const response = await request(app)
      .get('/api/v1/admin/overview')
      .set('Authorization', bearer(admin.token))
      .expect(200);

    const top = response.body.data.topWorkspaces as Array<{
      businessId: string;
      appointmentsLast30Days: number;
    }>;
    expect(top).toHaveLength(EXPECTED.workspaces);
    expect(top[0]).toMatchObject({
      businessId: aurora.businessId,
      appointmentsLast30Days: EXPECTED.auroraAppointments,
    });
    expect(top[1]).toMatchObject({
      businessId: borealis.businessId,
      appointmentsLast30Days: EXPECTED.borealisAppointments,
    });
  });
});

describe('workspace directory', () => {
  it('paginates', async () => {
    const first = await request(app)
      .get('/api/v1/admin/workspaces')
      .query({ pageSize: 1, sort: 'name' })
      .set('Authorization', bearer(admin.token))
      .expect(200);

    expect(first.body.data).toHaveLength(1);
    expect(first.body.meta).toMatchObject({
      page: 1,
      pageSize: 1,
      totalItems: EXPECTED.workspaces,
      totalPages: 2,
      hasNextPage: true,
    });
    expect(first.body.data[0].name).toBe(AURORA_NAME);

    const second = await request(app)
      .get('/api/v1/admin/workspaces')
      .query({ pageSize: 1, page: 2, sort: 'name' })
      .set('Authorization', bearer(admin.token))
      .expect(200);

    expect(second.body.data[0].name).toBe(BOREALIS_NAME);
    expect(second.body.meta.hasNextPage).toBe(false);
  });

  it('matches a search term against the name and against the slug', async () => {
    // 'borealis wellness' contains a space, so it can only have matched the
    // name; 'clinic-bandra' contains a hyphen, so it can only have matched the
    // slug. Two terms that each rule the other column out.
    const byName = await request(app)
      .get('/api/v1/admin/workspaces')
      .query({ search: 'borealis wellness' })
      .set('Authorization', bearer(admin.token))
      .expect(200);
    expect(byName.body.meta.totalItems).toBe(1);
    expect(byName.body.data[0].id).toBe(borealis.businessId);

    const bySlug = await request(app)
      .get('/api/v1/admin/workspaces')
      .query({ search: 'clinic-bandra' })
      .set('Authorization', bearer(admin.token))
      .expect(200);
    expect(bySlug.body.meta.totalItems).toBe(1);
    expect(bySlug.body.data[0].id).toBe(aurora.businessId);
    expect(bySlug.body.data[0].slug).toBe(aurora.slug);
  });

  it('treats LIKE wildcards in a search term as literal characters', async () => {
    // Unescaped, '%' would match every workspace on the platform. Escaped, it
    // matches only a workspace whose name or slug contains a literal per-cent
    // sign, and there is none.
    const response = await request(app)
      .get('/api/v1/admin/workspaces')
      .query({ search: '%' })
      .set('Authorization', bearer(admin.token))
      .expect(200);

    expect(response.body.meta.totalItems).toBe(0);
  });

  it('filters by status', async () => {
    const response = await request(app)
      .get('/api/v1/admin/workspaces')
      .query({ status: 'SUSPENDED' })
      .set('Authorization', bearer(admin.token))
      .expect(200);

    expect(response.body.meta.totalItems).toBe(0);
  });

  it('describes a workspace by its members and its appointment mix', async () => {
    const response = await request(app)
      .get(`/api/v1/admin/workspaces/${aurora.businessId}`)
      .set('Authorization', bearer(admin.token))
      .expect(200);

    const workspace = response.body.data;
    expect(workspace.id).toBe(aurora.businessId);
    expect(workspace.owner).toMatchObject({
      id: aurora.owner.userId,
      email: aurora.owner.email,
    });
    expect(workspace.counts).toEqual({
      members: 1,
      staff: 1,
      services: 1,
      locations: 0,
      appointments: EXPECTED.auroraAppointments,
      customers: 2,
    });

    expect(workspace.members).toHaveLength(1);
    expect(workspace.members[0]).toMatchObject({
      roleKey: 'BUSINESS_OWNER',
      status: 'ACTIVE',
      user: { id: aurora.owner.userId, email: aurora.owner.email, platformRole: 'USER' },
    });

    // Ordered by count descending, then status alphabetically.
    expect(workspace.appointmentsByStatus).toEqual([
      { status: 'CONFIRMED', count: 2 },
      { status: 'CANCELLED', count: 1 },
      { status: 'COMPLETED', count: 1 },
    ]);

    // `lastAppointmentAt` is the most recent booking taken, not the furthest
    // date in the diary, so it is in the past even though appointments are not.
    expect(workspace.lastAppointmentAt).not.toBeNull();
    expect(Date.parse(workspace.lastAppointmentAt as string)).toBeLessThanOrEqual(Date.now());

    expect(
      (workspace.recentActivity as Array<{ action: string }>).some(
        (entry) => entry.action === AuditActions.BUSINESS_CREATED,
      ),
    ).toBe(true);
  });

  it('answers 404 for a workspace id that does not exist', async () => {
    await request(app)
      .get(`/api/v1/admin/workspaces/${newUuid()}`)
      .set('Authorization', bearer(admin.token))
      .expect(404);
  });
});

describe('account directory', () => {
  it('filters by status', async () => {
    const response = await request(app)
      .get('/api/v1/admin/users')
      .query({ status: 'SUSPENDED' })
      .set('Authorization', bearer(admin.token))
      .expect(200);

    expect(response.body.meta.totalItems).toBe(EXPECTED.suspendedUsers);
    expect(response.body.data[0].id).toBe(dormant.id);
    expect(response.body.data[0].status).toBe('SUSPENDED');
  });

  it('filters by platform role', async () => {
    const response = await request(app)
      .get('/api/v1/admin/users')
      .query({ platformRole: 'ADMIN' })
      .set('Authorization', bearer(admin.token))
      .expect(200);

    expect(response.body.meta.totalItems).toBe(EXPECTED.admins);
    expect(response.body.data[0].id).toBe(admin.userId);
  });

  it('lists a user’s memberships and marks the workspace they own', async () => {
    const response = await request(app)
      .get(`/api/v1/admin/users/${aurora.owner.userId}`)
      .set('Authorization', bearer(admin.token))
      .expect(200);

    const user = response.body.data;
    expect(user.memberships).toHaveLength(1);
    expect(user.memberships[0]).toMatchObject({
      businessId: aurora.businessId,
      businessName: AURORA_NAME,
      businessStatus: 'ACTIVE',
      roleKey: 'BUSINESS_OWNER',
      status: 'ACTIVE',
      isOwner: true,
    });
    // The two counts are computed by different subqueries and must agree with
    // the array above; a disagreement sends someone hunting for a bug.
    expect(user.workspaceCount).toBe(1);
    expect(user.ownedWorkspaceCount).toBe(1);
    expect(user.activeSessionCount).toBeGreaterThan(0);
  });

  it('reports an administrator who belongs to nothing as belonging to nothing', async () => {
    const response = await request(app)
      .get(`/api/v1/admin/users/${admin.userId}`)
      .set('Authorization', bearer(admin.token))
      .expect(200);

    expect(response.body.data.memberships).toEqual([]);
    expect(response.body.data.workspaceCount).toBe(0);
    expect(response.body.data.platformRole).toBe('ADMIN');
  });

  it('answers 404 for a user id that does not exist', async () => {
    await request(app)
      .get(`/api/v1/admin/users/${newUuid()}`)
      .set('Authorization', bearer(admin.token))
      .expect(404);
  });
});

describe('audit feed', () => {
  it('spans more than one workspace', async () => {
    // The reason this endpoint exists. A workspace's own audit feed is scoped
    // to that workspace by construction, so no amount of tenant-side work can
    // answer "what happened on the platform last night".
    const response = await request(app)
      .get('/api/v1/admin/audit-logs')
      .query({ pageSize: 100 })
      .set('Authorization', bearer(admin.token))
      .expect(200);

    const rows = response.body.data as Array<{ businessId: string | null; createdAt: string }>;
    const businessIds = new Set(rows.map((row) => row.businessId).filter(Boolean));

    expect(businessIds.has(aurora.businessId)).toBe(true);
    expect(businessIds.has(borealis.businessId)).toBe(true);
    expect(businessIds.size).toBeGreaterThanOrEqual(2);

    // And platform-level rows, which belong to no tenant and would therefore
    // appear in no tenant's feed at all.
    expect(rows.some((row) => row.businessId === null)).toBe(true);

    const timestamps = rows.map((row) => Date.parse(row.createdAt));
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
  });

  it('narrows to one workspace when asked', async () => {
    const response = await request(app)
      .get('/api/v1/admin/audit-logs')
      .query({ businessId: borealis.businessId, pageSize: 100 })
      .set('Authorization', bearer(admin.token))
      .expect(200);

    expect(response.body.meta.totalItems).toBeGreaterThan(0);
    expect(
      (response.body.data as Array<{ businessId: string | null }>).every(
        (row) => row.businessId === borealis.businessId,
      ),
    ).toBe(true);
  });

  it('treats a from/to range as whole inclusive days', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const response = await request(app)
      .get('/api/v1/admin/audit-logs')
      .query({ from: today, to: today, pageSize: 100 })
      .set('Authorization', bearer(admin.token))
      .expect(200);

    // Everything in this suite happened within the last few seconds, so a
    // single-day range must return it rather than only the day's first instant.
    expect(response.body.meta.totalItems).toBeGreaterThan(0);
  });
});

describe('health', () => {
  it('reports the database as reachable', async () => {
    const response = await request(app)
      .get('/api/v1/admin/health')
      .set('Authorization', bearer(admin.token))
      .expect(200);

    expect(response.body.data.database.ok).toBe(true);
    expect(response.body.data.database.error).toBeNull();
    expect(response.body.data.api.apiVersion).toBe('v1');
    expect(typeof response.body.data.api.uptimeSeconds).toBe('number');
    expect(typeof response.body.data.outbox.dueNow).toBe('number');
  });
});

describe('the privacy boundary', () => {
  /*
   * These two tests ARE the enforcement.
   *
   * Nothing filters customer PII out of an admin response: the builders in
   * admin.service.ts name every field they emit and simply never name a
   * customer's. That is a property of the response shape, which means it cannot
   * be asserted by checking that some middleware ran — only by serialising a
   * real response about a workspace that really does hold a patient's details,
   * and looking for those details in it.
   *
   * A failure here is not a cosmetic one. It means an operator running the
   * platform can read a clinic's patient list.
   */
  it('never names a workspace’s customers in its detail response', async () => {
    const response = await request(app)
      .get(`/api/v1/admin/workspaces/${aurora.businessId}`)
      .set('Authorization', bearer(admin.token))
      .expect(200);

    // The patient is genuinely there — otherwise the absence below is trivial.
    expect(response.body.data.counts.customers).toBe(2);
    expect(
      await Customer.count({ where: { businessId: aurora.businessId, email: PATIENT.email } }),
    ).toBe(1);

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain(PATIENT.email);
    expect(serialised).not.toContain(PATIENT.firstName);
    expect(serialised).not.toContain(PATIENT.lastName);
    expect(serialised).not.toContain(PATIENT.notes);
  });

  it('never carries appointment contents, only their counts', async () => {
    const [detail, directory, overview] = await Promise.all([
      request(app)
        .get(`/api/v1/admin/workspaces/${aurora.businessId}`)
        .set('Authorization', bearer(admin.token))
        .expect(200),
      request(app)
        .get('/api/v1/admin/workspaces')
        .set('Authorization', bearer(admin.token))
        .expect(200),
      request(app)
        .get('/api/v1/admin/overview')
        .set('Authorization', bearer(admin.token))
        .expect(200),
    ]);

    expect(
      await Appointment.count({
        where: { businessId: aurora.businessId, internalNotes: INTERNAL_NOTE },
      }),
    ).toBe(1);

    for (const response of [detail, directory, overview]) {
      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain(CUSTOMER_NOTE);
      expect(serialised).not.toContain(INTERNAL_NOTE);
      expect(serialised).not.toContain(PATIENT.email);
    }
  });
});

describe('suspending a workspace', () => {
  it('locks its owner out of tenant resolution, and reinstating restores access', async () => {
    // The button does something, demonstrated end to end: `requireTenant` joins
    // through `businesses` with `status = 'ACTIVE'`, so the owner's membership
    // stops resolving the moment the workspace is suspended.
    await request(app)
      .get('/api/v1/workspace')
      .set('Authorization', bearer(aurora.owner.token))
      .set('X-Business-Id', aurora.businessId)
      .expect(200);

    const suspended = await request(app)
      .patch(`/api/v1/admin/workspaces/${aurora.businessId}/status`)
      .set('Authorization', bearer(admin.token))
      .send({ status: 'SUSPENDED', reason: 'Chargeback raised by the card issuer.' })
      .expect(200);
    expect(suspended.body.data.status).toBe('SUSPENDED');

    await request(app)
      .get('/api/v1/workspace')
      .set('Authorization', bearer(aurora.owner.token))
      .set('X-Business-Id', aurora.businessId)
      .expect(404);

    const reinstated = await request(app)
      .patch(`/api/v1/admin/workspaces/${aurora.businessId}/status`)
      .set('Authorization', bearer(admin.token))
      .send({ status: 'ACTIVE' })
      .expect(200);
    expect(reinstated.body.data.status).toBe('ACTIVE');

    await request(app)
      .get('/api/v1/workspace')
      .set('Authorization', bearer(aurora.owner.token))
      .set('X-Business-Id', aurora.businessId)
      .expect(200);

    expect((await Business.findByPk(aurora.businessId))?.status).toBe('ACTIVE');
  });

  it('records who did it, in the workspace’s own trail', async () => {
    const entries = await AuditLog.findAll({
      where: {
        businessId: aurora.businessId,
        action: AuditActions.PLATFORM_WORKSPACE_STATUS_CHANGED,
      },
      order: [['createdAt', 'ASC']],
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      actorType: 'USER',
      actorUserId: admin.userId,
      actorLabel: admin.email,
      entityType: 'business',
      entityId: aurora.businessId,
    });
    expect(entries[0]?.metadata).toMatchObject({
      before: 'ACTIVE',
      after: 'SUSPENDED',
      reason: 'Chargeback raised by the card issuer.',
    });
    // The reason is optional, and its absence is recorded as null rather than
    // left off the row.
    expect(entries[1]?.metadata).toMatchObject({
      before: 'SUSPENDED',
      after: 'ACTIVE',
      reason: null,
    });
  });

  it('answers 404 for a workspace id that does not exist', async () => {
    await request(app)
      .patch(`/api/v1/admin/workspaces/${newUuid()}/status`)
      .set('Authorization', bearer(admin.token))
      .send({ status: 'SUSPENDED' })
      .expect(404);
  });
});

describe('suspending a user', () => {
  it('ends the session they are holding right now', async () => {
    await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(sessionHolder.token))
      .expect(200);

    const suspended = await request(app)
      .patch(`/api/v1/admin/users/${sessionHolder.userId}/status`)
      .set('Authorization', bearer(admin.token))
      .send({ status: 'SUSPENDED' })
      .expect(200);

    expect(suspended.body.data.status).toBe('SUSPENDED');
    // Not "will be zero shortly": the revocation shares a transaction with the
    // status change, so the response that reports the suspension already
    // reports no live sessions.
    expect(suspended.body.data.activeSessionCount).toBe(0);

    // Read the token rows before exercising /auth/refresh below, which revokes
    // the family a second time with a different reason as reuse protection.
    const tokens = await RefreshToken.findAll({ where: { userId: sessionHolder.userId } });
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((token) => token.revokedAt !== null)).toBe(true);
    expect(tokens.every((token) => token.revokedReason === 'ADMIN_REVOKED')).toBe(true);

    // The 15-minute access token dies at its very next call rather than at its
    // expiry: `authenticate` re-reads the user row and refuses a non-ACTIVE
    // account with 403.
    await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(sessionHolder.token))
      .expect(403);

    // And the refresh token cannot mint a replacement, which is the half that
    // would otherwise keep the account alive for another thirty days.
    await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: sessionHolder.refreshToken })
      .expect(401);
  });

  it('revokes nothing when the account is reactivated', async () => {
    const reactivated = await request(app)
      .patch(`/api/v1/admin/users/${sessionHolder.userId}/status`)
      .set('Authorization', bearer(admin.token))
      .send({ status: 'ACTIVE' })
      .expect(200);

    expect(reactivated.body.data.status).toBe('ACTIVE');

    const entry = await AuditLog.findOne({
      where: {
        action: AuditActions.PLATFORM_USER_STATUS_CHANGED,
        entityId: sessionHolder.userId,
      },
      order: [['createdAt', 'DESC']],
    });
    expect(entry?.metadata).toMatchObject({
      before: 'SUSPENDED',
      after: 'ACTIVE',
      revokedSessions: 0,
    });
  });

  it('refuses to let an administrator change their own status', async () => {
    // Unrecoverable if it were allowed: the only surface that could restore the
    // account is the one the account just lost.
    const response = await request(app)
      .patch(`/api/v1/admin/users/${admin.userId}/status`)
      .set('Authorization', bearer(admin.token))
      .send({ status: 'SUSPENDED' })
      .expect(409);

    expect(response.body.error.code).toBe(ErrorCode.CONFLICT);
    expect((await User.findByPk(admin.userId))?.status).toBe('ACTIVE');
  });
});

describe('platform role', () => {
  it('refuses to let an administrator change their own role', async () => {
    const response = await request(app)
      .patch(`/api/v1/admin/users/${admin.userId}/platform-role`)
      .set('Authorization', bearer(admin.token))
      .send({ platformRole: 'USER' })
      .expect(409);

    expect(response.body.error.code).toBe(ErrorCode.CONFLICT);
    expect((await User.findByPk(admin.userId))?.platformRole).toBe('ADMIN');
  });

  it('promotes a second administrator, and then demotes them', async () => {
    const promoted = await request(app)
      .patch(`/api/v1/admin/users/${deputy.id}/platform-role`)
      .set('Authorization', bearer(admin.token))
      .send({ platformRole: 'ADMIN' })
      .expect(200);
    expect(promoted.body.data.platformRole).toBe('ADMIN');

    // With two administrators the last-admin guard has nothing to protect, so
    // the demotion goes through.
    const demoted = await request(app)
      .patch(`/api/v1/admin/users/${deputy.id}/platform-role`)
      .set('Authorization', bearer(admin.token))
      .send({ platformRole: 'USER' })
      .expect(200);
    expect(demoted.body.data.platformRole).toBe('USER');

    await deputy.reload();
    expect(deputy.platformRole).toBe('USER');
  });

  it('refuses to demote the last remaining active administrator', async () => {
    /*
     * Called through the service rather than over HTTP, and that is not a
     * shortcut. Over HTTP the caller is by definition an ACTIVE ADMIN who
     * cannot demote themselves, so a second administrator always survives and
     * the guard is unreachable. It exists for every other caller — a
     * maintenance script, a future job, this test — and this is the only way to
     * prove it holds.
     */
    expect(await User.count({ where: { platformRole: 'ADMIN', status: 'ACTIVE' } })).toBe(1);

    await expect(
      updatePlatformRole(
        admin.userId,
        { platformRole: 'USER' },
        { userId: aurora.owner.userId, email: aurora.owner.email },
        { requestId: 'admin-integration-test', ipAddress: null, userAgent: null },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: ErrorCode.CONFLICT });

    expect((await User.findByPk(admin.userId))?.platformRole).toBe('ADMIN');
  });

  it('answers 404 for a user id that does not exist', async () => {
    await request(app)
      .patch(`/api/v1/admin/users/${newUuid()}/platform-role`)
      .set('Authorization', bearer(admin.token))
      .send({ platformRole: 'ADMIN' })
      .expect(404);
  });
});

describe('the audit trail every mutation leaves', () => {
  it('scopes workspace actions to their workspace and account actions to no tenant', async () => {
    const workspaceEntries = await AuditLog.findAll({
      where: { action: AuditActions.PLATFORM_WORKSPACE_STATUS_CHANGED },
    });
    const accountEntries = await AuditLog.findAll({
      where: {
        action: {
          [Op.in]: [
            AuditActions.PLATFORM_USER_STATUS_CHANGED,
            AuditActions.PLATFORM_USER_ROLE_CHANGED,
          ],
        },
      },
    });

    // Two workspace changes (suspend, reinstate), two account status changes
    // (suspend, reactivate) and two role changes (promote, demote). The refused
    // mutations wrote nothing: every guard throws before any database work.
    expect(workspaceEntries).toHaveLength(2);
    expect(accountEntries).toHaveLength(4);

    expect(workspaceEntries.every((entry) => entry.businessId === aurora.businessId)).toBe(true);

    // A platform-level event belongs to no single tenant, so no workspace's own
    // audit feed may surface it.
    expect(accountEntries.every((entry) => entry.businessId === null)).toBe(true);
    expect(accountEntries.every((entry) => entry.entityType === 'user')).toBe(true);

    for (const entry of [...workspaceEntries, ...accountEntries]) {
      expect(entry.actorType).toBe('USER');
      expect(entry.actorUserId).toBe(admin.userId);
      expect(entry.actorLabel).toBe(admin.email);
      expect(entry.requestId).not.toBeNull();
    }
  });
});
