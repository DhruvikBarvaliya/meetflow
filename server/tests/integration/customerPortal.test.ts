/**
 * The customer portal, over real HTTP.
 *
 * The finding this file guards is not a bug in a query — it is a missing
 * identity. MeetFlow's spec names four workspace roles *and a customer*, but
 * only the four are memberships, and every authenticated route was mounted
 * behind `requireTenant`, which answers 404 to anyone holding no membership. A
 * customer holds none by definition. The customer dashboard was therefore
 * reachable only by an owner or manager whose email happened to match a
 * customer record — which is to say, by nobody the feature was built for.
 *
 * So the regression that matters most here is the plainest one, and it is
 * asserted first: **a signed-in person with zero memberships can read their own
 * bookings.** Its companion is the counter-example — the same router behind
 * `requireTenant` 404s for that same person — because a test that only proves
 * the new arrangement works would not show why the old one could not.
 *
 * Four further claims can only be checked end to end:
 *
 *  1. **One person, many workspaces.** Two businesses that have never heard of
 *     each other hold two `Customer` rows for the same human, and the portal
 *     shows both sets of bookings in one list. Nothing else in the codebase
 *     reads across tenants except the platform-admin surface, so this is the
 *     one place the union can be observed to be correct — and, crucially, to be
 *     limited to *that* person's rows.
 *  2. **Someone else's booking is not found.** Not forbidden — not found. A 403
 *     would confirm the `apt_…` handle is real and turn the endpoint into an
 *     existence oracle over every appointment on the platform.
 *  3. **Cancelling goes through the lifecycle service.** Asserted by its side
 *     effects rather than by the response: the status history gains a row
 *     attributed to a CUSTOMER, and an audit row is written naming the *user*
 *     account — the thing the anonymous manage link cannot record.
 *  4. **The workspace's policy still governs.** A customer who is inside the
 *     cancellation deadline is refused, exactly as they would be through the
 *     public link. Being signed in is not a way around a business's rules.
 *
 * Mounting note: this file builds its own Express app rather than calling
 * `createApp()`. The mount in src/routes/index.ts is owned by a different
 * change, and a test that waited on it would fail for a reason that has nothing
 * to do with what it asserts. The stack below is the intended production mount
 * exactly — `authenticate -> apiRateLimit -> customerPortalRouter`, with no
 * `requireTenant` — using the real middleware and the real error handler, so
 * what is exercised here is the router as it will be served.
 */
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Appointment,
  AppointmentStatusHistory,
  AuditLog,
  BusinessSettings,
  Customer,
  Membership,
  User,
} from '../../src/database/models';
import { authenticate } from '../../src/middleware/authenticate';
import { errorHandler, notFoundHandler } from '../../src/middleware/errorHandler';
import { apiRateLimit } from '../../src/middleware/rateLimit';
import { requestId } from '../../src/middleware/requestContext';
import { requireTenant } from '../../src/middleware/tenant';
import { createBooking } from '../../src/modules/appointments/booking.service';
import { AuditActions } from '../../src/modules/audit/audit.service';
import { login } from '../../src/modules/auth/auth.service';
import { customerPortalRouter } from '../../src/modules/customers/portal.routes';
import { ErrorCode } from '../../src/utils/errors';
import {
  TEST_PASSWORD,
  closeDatabaseConnection,
  createUser,
  createWorkspace,
  nextWeekdayAt,
  resetDatabase,
  type WorkspaceFixture,
} from '../helpers/fixtures';

/** The production mount: authenticated, rate limited, and pointedly untenanted. */
function buildPortalApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(requestId);
  app.use('/api/v1/me', authenticate, apiRateLimit, customerPortalRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/**
 * The arrangement this change replaces, kept so the counter-example can be
 * demonstrated rather than described.
 */
function buildTenantedApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(requestId);
  app.use('/api/v1/me', authenticate, apiRateLimit, requireTenant, customerPortalRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const app = buildPortalApp();
const tenantedApp = buildTenantedApp();

const CUSTOMER_EMAIL = 'portal-person@meetflow.test';
const STRANGER_EMAIL = 'portal-stranger@meetflow.test';

let clinic: WorkspaceFixture;
let salon: WorkspaceFixture;
let token: string;
let strangerToken: string;

/** Their booking at the clinic — the one used for the mutation suites. */
let clinicBookingPublicId: string;
let clinicAppointmentId: string;
/** Their booking at the salon, in a workspace the clinic knows nothing about. */
let salonBookingPublicId: string;
/** Somebody else's booking, at the same clinic. */
let strangerBookingPublicId: string;

async function signIn(email: string): Promise<string> {
  const result = await login(email, TEST_PASSWORD, {
    ipAddress: null,
    userAgent: null,
    requestId: 'customer-portal-test',
  });
  return result.accessToken;
}

async function book(
  workspace: WorkspaceFixture,
  email: string,
  startsAt: Date,
): Promise<Appointment> {
  const { appointment } = await createBooking({
    businessId: workspace.business.id,
    serviceId: workspace.service.id,
    staffProfileId: workspace.staffProfile.id,
    locationId: null,
    startsAt,
    timezone: 'UTC',
    customer: { firstName: 'Portal', lastName: 'Person', email },
    source: 'PUBLIC',
    actor: { type: 'CUSTOMER', label: email },
  });
  return appointment;
}

beforeAll(async () => {
  await resetDatabase();

  clinic = await createWorkspace();
  salon = await createWorkspace();

  // Two accounts that own nothing and belong to nowhere. `createUser` stamps
  // `emailVerifiedAt`, which is what makes their customer records linkable —
  // see the reasoning on `linkCustomerRecords`.
  await createUser({ email: CUSTOMER_EMAIL, firstName: 'Portal' });
  await createUser({ email: STRANGER_EMAIL, firstName: 'Stranger' });

  // The same human books with two unrelated businesses, which is two Customer
  // rows, because tenants never share customer data.
  const clinicAppointment = await book(clinic, CUSTOMER_EMAIL, nextWeekdayAt(10));
  clinicBookingPublicId = clinicAppointment.publicId;
  clinicAppointmentId = clinicAppointment.id;

  salonBookingPublicId = (await book(salon, CUSTOMER_EMAIL, nextWeekdayAt(11))).publicId;
  strangerBookingPublicId = (await book(clinic, STRANGER_EMAIL, nextWeekdayAt(12))).publicId;

  token = await signIn(CUSTOMER_EMAIL);
  strangerToken = await signIn(STRANGER_EMAIL);
});

afterAll(async () => {
  await closeDatabaseConnection();
});

describe('a customer holds no membership', () => {
  it('has zero memberships — the precondition every test below depends on', async () => {
    const account = await User.findOne({ where: { email: CUSTOMER_EMAIL } });
    const customer = await Customer.findOne({ where: { email: CUSTOMER_EMAIL } });
    const memberships = await Membership.count({ where: { userId: account!.id } });

    expect(memberships).toBe(0);
    // Still unlinked at this moment: reconciliation happens on the first portal
    // read, which is the next test. Holding no membership, by contrast, is not
    // a transient state — it is what being a customer means, and it is what
    // `requireTenant` would refuse forever.
    expect(customer!.userId).toBeNull();
  });

  it('reads its own bookings with zero memberships (the regression)', async () => {
    const response = await request(app)
      .get('/api/v1/me/bookings')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.data).toHaveLength(2);
  });

  it('would 404 behind requireTenant — which is the bug being fixed', async () => {
    // Same router, same token, same person. The only difference is the guard,
    // and tenant resolution has no membership to resolve.
    await request(tenantedApp)
      .get('/api/v1/me/bookings')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('still requires authentication', async () => {
    await request(app).get('/api/v1/me/bookings').expect(401);
  });
});

describe('linking a person to their customer records', () => {
  it('links every unlinked record sharing the verified address', async () => {
    const rows = await Customer.findAll({ where: { email: CUSTOMER_EMAIL } });

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.userId !== null)).toBe(true);
    // One id, two workspaces: the link is what makes them one person.
    expect(new Set(rows.map((row) => row.userId)).size).toBe(1);
  });

  it('writes an audit row per workspace, attributed to the account', async () => {
    const customer = await Customer.findOne({ where: { email: CUSTOMER_EMAIL } });
    const audit = await AuditLog.findOne({
      where: { entityType: 'customer', entityId: customer!.id, actorType: 'CUSTOMER' },
    });

    expect(audit).not.toBeNull();
    expect(audit!.businessId).toBe(customer!.businessId);
    expect(audit!.actorUserId).toBe(customer!.userId);
    expect(audit!.metadata).toMatchObject({ reason: 'verified_email_match' });
  });

  it('never links a record whose address was never verified', async () => {
    // An unverified account is an unproven claim on a mailbox. If a match alone
    // were enough, registering a stranger's address would hand over their whole
    // history — every business they use and every time they will be there.
    const unverified = await createUser({ email: 'unverified-portal@meetflow.test' });
    await unverified.update({ emailVerifiedAt: null });
    await book(clinic, 'unverified-portal@meetflow.test', nextWeekdayAt(13));

    const response = await request(app)
      .get('/api/v1/me/bookings')
      .set('Authorization', `Bearer ${await signIn('unverified-portal@meetflow.test')}`)
      .expect(200);

    expect(response.body.data).toHaveLength(0);
    const row = await Customer.findOne({ where: { email: 'unverified-portal@meetflow.test' } });
    expect(row!.userId).toBeNull();
  });

  it('never claims a record that already belongs to someone else', async () => {
    const stranger = await Customer.findOne({ where: { email: STRANGER_EMAIL } });
    const customer = await Customer.findOne({ where: { email: CUSTOMER_EMAIL } });

    expect(stranger!.userId).not.toBe(customer!.userId);
  });
});

describe('bookings across every workspace', () => {
  it('returns bookings from two unrelated workspaces in one list', async () => {
    const response = await request(app)
      .get('/api/v1/me/bookings')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const handles = (response.body.data as Array<{ publicId: string }>).map((row) => row.publicId);
    expect(handles).toContain(clinicBookingPublicId);
    expect(handles).toContain(salonBookingPublicId);
    expect(response.body.meta.totalItems).toBe(2);
  });

  it("never returns another person's booking", async () => {
    const response = await request(app)
      .get('/api/v1/me/bookings')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const handles = (response.body.data as Array<{ publicId: string }>).map((row) => row.publicId);
    expect(handles).not.toContain(strangerBookingPublicId);
  });

  it('names each workspace on the row it belongs to', async () => {
    const response = await request(app)
      .get('/api/v1/me/bookings')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const rows = response.body.data as Array<{ publicId: string; business: { name: string } }>;
    const clinicRow = rows.find((row) => row.publicId === clinicBookingPublicId);
    expect(clinicRow!.business.name).toBe(clinic.business.name);
  });

  it('paginates', async () => {
    const response = await request(app)
      .get('/api/v1/me/bookings?page=1&pageSize=1')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.meta.totalItems).toBe(2);
    expect(response.body.meta.hasNextPage).toBe(true);
  });

  it('refuses a workspace id smuggled into the query', async () => {
    // `.strict()` is the whole defence: this surface has no tenant input, and a
    // field that is ignored today is a field that gets honoured tomorrow.
    await request(app)
      .get(`/api/v1/me/bookings?businessId=${clinic.business.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(422);
  });

  it('reads one booking by its opaque handle', async () => {
    const response = await request(app)
      .get(`/api/v1/me/bookings/${clinicBookingPublicId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.data.publicId).toBe(clinicBookingPublicId);
    expect(response.body.data.business.name).toBe(clinic.business.name);
    // The public serialiser's boundary, inherited wholesale.
    expect(response.body.data).not.toHaveProperty('internalNotes');
    expect(response.body.data).not.toHaveProperty('customerId');
  });

  it("404s — not 403s — on another person's booking", async () => {
    await request(app)
      .get(`/api/v1/me/bookings/${strangerBookingPublicId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('404s on a handle that belongs to nobody, with the same answer', async () => {
    await request(app)
      .get('/api/v1/me/bookings/apt_ZZZZZZZZZZZZZZZZZZZZZZZZZZ')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('refuses an internal id where a handle belongs', async () => {
    await request(app)
      .get(`/api/v1/me/bookings/${clinicAppointmentId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(422);
  });
});

describe('the workspace policy still governs', () => {
  it('refuses a cancellation inside the business deadline', async () => {
    const [settings] = await BusinessSettings.findOrCreate({
      where: { businessId: clinic.business.id },
      defaults: { businessId: clinic.business.id },
    });
    const original = settings.cancellationDeadlineMinutes;

    // A fortnight's notice required, against a booking a few days out.
    await settings.update({ cancellationDeadlineMinutes: 20_160 });

    try {
      const response = await request(app)
        .post(`/api/v1/me/bookings/${clinicBookingPublicId}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Changed my mind' })
        .expect(422);

      expect(response.body.error.code).toBe(ErrorCode.POLICY_VIOLATION);
      const untouched = await Appointment.findByPk(clinicAppointmentId);
      expect(untouched!.status).not.toBe('CANCELLED');
    } finally {
      await settings.update({ cancellationDeadlineMinutes: original });
    }
  });

  it('refuses a cancellation when the business does not allow customers to cancel', async () => {
    const [settings] = await BusinessSettings.findOrCreate({
      where: { businessId: clinic.business.id },
      defaults: { businessId: clinic.business.id },
    });
    await settings.update({ allowCustomerCancel: false });

    try {
      await request(app)
        .post(`/api/v1/me/bookings/${clinicBookingPublicId}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(422);
    } finally {
      await settings.update({ allowCustomerCancel: true });
    }
  });
});

describe('changing a booking goes through the lifecycle service', () => {
  it('moves a booking and records the new time', async () => {
    const target = nextWeekdayAt(14);

    const response = await request(app)
      .post(`/api/v1/me/bookings/${salonBookingPublicId}/reschedule`)
      .set('Authorization', `Bearer ${token}`)
      .send({ startsAt: target.toISOString(), reason: 'Traffic' })
      .expect(200);

    expect(new Date(response.body.data.startsAt as string).toISOString()).toBe(
      target.toISOString(),
    );
    expect(response.body.data.rescheduleCount).toBe(1);
  });

  it('cancels, and leaves the lifecycle side effects behind it', async () => {
    await request(app)
      .post(`/api/v1/me/bookings/${clinicBookingPublicId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'No longer needed' })
      .expect(200);

    const appointment = await Appointment.findByPk(clinicAppointmentId);
    expect(appointment!.status).toBe('CANCELLED');
    expect(appointment!.cancelledByType).toBe('CUSTOMER');

    // History is appended by the lifecycle service, not by the portal.
    const history = await AppointmentStatusHistory.findOne({
      where: { appointmentId: clinicAppointmentId, toStatus: 'CANCELLED' },
    });
    expect(history).not.toBeNull();
    expect(history!.actorType).toBe('CUSTOMER');

    // The audit row names the account — which is precisely what the anonymous
    // manage link, holding only a bearer handle, can never record.
    const audit = await AuditLog.findOne({
      where: {
        action: AuditActions.APPOINTMENT_CANCELLED,
        entityId: clinicAppointmentId,
      },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorType).toBe('CUSTOMER');
    expect(audit!.actorUserId).toBe(appointment!.cancelledByUserId);
    expect(audit!.businessId).toBe(clinic.business.id);
  });

  it("refuses to cancel another person's booking, as a 404", async () => {
    await request(app)
      .post(`/api/v1/me/bookings/${strangerBookingPublicId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(404);

    const stranger = await Appointment.findOne({
      where: { publicId: strangerBookingPublicId },
    });
    expect(stranger!.status).not.toBe('CANCELLED');
  });

  it('lets the other person cancel their own', async () => {
    await request(app)
      .post(`/api/v1/me/bookings/${strangerBookingPublicId}/cancel`)
      .set('Authorization', `Bearer ${strangerToken}`)
      .send({})
      .expect(200);
  });
});

describe('profile', () => {
  it('lists the workspaces that know this person, and nothing about the rest', async () => {
    const response = await request(app)
      .get('/api/v1/me/profile')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const names = (response.body.data.workspaces as Array<{ business: { name: string } }>).map(
      (row) => row.business.name,
    );
    expect(names).toContain(clinic.business.name);
    expect(names).toContain(salon.business.name);

    // The workspace's internal id is never published to its customers, and
    // neither is a password hash.
    expect(JSON.stringify(response.body.data)).not.toContain(clinic.business.id);
    expect(response.body.data.user).not.toHaveProperty('passwordHash');
    expect(response.body.data.user.email).toBe(CUSTOMER_EMAIL);
  });

  it('reports an empty profile for someone no business has met', async () => {
    const newcomer = await createUser({ email: 'newcomer-portal@meetflow.test' });

    const response = await request(app)
      .get('/api/v1/me/profile')
      .set('Authorization', `Bearer ${await signIn(newcomer.email)}`)
      .expect(200);

    expect(response.body.data.workspaces).toHaveLength(0);
    expect(response.body.data.upcomingBookings).toBe(0);
  });
});

describe('notification preferences', () => {
  it('reports one set of preferences for the person', async () => {
    const response = await request(app)
      .get('/api/v1/me/preferences')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.data.workspaceCount).toBe(2);
    expect(response.body.data.divergent).toBe(false);
    expect(response.body.data.preferences.emailEnabled).toBe(true);
  });

  it('applies a change to every workspace that holds a record', async () => {
    await request(app)
      .patch('/api/v1/me/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ marketingOptIn: true, reminderOffsetsMinutes: [60, 1440] })
      .expect(200);

    const rows = await Customer.findAll({ where: { email: CUSTOMER_EMAIL } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.communicationPreferences).toMatchObject({
        marketingOptIn: true,
        // Folded and sorted furthest-out first, as the reminder scheduler reads them.
        reminderOffsetsMinutes: [1440, 60],
      });
      // A patch merges; the flags left alone keep their stored values.
      expect(row.communicationPreferences).toMatchObject({ emailEnabled: true });
    }
  });

  it('reports divergence when one workspace was changed from the address book', async () => {
    const [first] = await Customer.findAll({
      where: { email: CUSTOMER_EMAIL },
      order: [['createdAt', 'ASC']],
    });
    await first!.update({
      communicationPreferences: { ...first!.communicationPreferences, emailEnabled: false },
    });

    const response = await request(app)
      .get('/api/v1/me/preferences')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.data.divergent).toBe(true);
    // Conservative where they disagree: showing "on" would promise something
    // that will not happen in one of the two workspaces.
    expect(response.body.data.preferences.emailEnabled).toBe(false);
  });

  it('refuses an empty patch', async () => {
    await request(app)
      .patch('/api/v1/me/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(422);
  });

  it('refuses a patch from someone with nowhere to store it', async () => {
    const newcomer = await createUser({ email: 'nowhere-portal@meetflow.test' });

    const response = await request(app)
      .patch('/api/v1/me/preferences')
      .set('Authorization', `Bearer ${await signIn(newcomer.email)}`)
      .send({ emailEnabled: false })
      .expect(409);

    expect(response.body.error.code).toBe(ErrorCode.CONFLICT);
  });
});
