/**
 * `customers:read:assigned`, exercised over real HTTP.
 *
 * This file exists because the permission was a dead end. The STAFF role held
 * it, the client's navigation and route guard both accepted it, and every one
 * of the six customer endpoints demanded the unscoped `customers:read` — so a
 * staff member could reach `/app/customers` and watch every request 403. The
 * narrowing function was written, exported and never called.
 *
 * Nothing short of an end-to-end request catches that class of bug: the service
 * compiled, the permission existed in the catalogue, and the role template was
 * correct. What was missing was the wire between them.
 *
 * Three properties are asserted, and the middle one is the load-bearing one:
 *
 *  1. A staff member reaches the endpoints at all.
 *  2. They see the customers booked with them and *no others* — proving the
 *     route was widened without being opened. A test that only checked "STAFF
 *     gets 200" would pass just as happily against a route that dropped its
 *     permission check altogether.
 *  3. Somebody else's customer answers 404 rather than 403, so the id space
 *     cannot be walked to learn who else the workspace books.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import {
  Customer,
  Membership,
  Role,
  ServiceStaff,
  StaffAvailabilityRule,
  StaffProfile,
} from '../../src/database/models';
import { createBooking } from '../../src/modules/appointments/booking.service';
import { login } from '../../src/modules/auth/auth.service';
import {
  TEST_PASSWORD,
  closeDatabaseConnection,
  createUser,
  createWorkspace,
  nextWeekdayAt,
  resetDatabase,
  type WorkspaceFixture,
} from '../helpers/fixtures';

const app = createApp();

let fixture: WorkspaceFixture;
let ownerToken: string;

/** A STAFF-role member who is also bookable. */
let staffToken: string;
let staffProfileId: string;

/** A STAFF-role member who is *not* bookable — no staff profile, no bookings. */
let deskToken: string;

/** Booked with the staff member. */
let assignedCustomerId: string;
/** Booked with the owner, and never with the staff member. */
let otherCustomerId: string;

async function tokenFor(email: string): Promise<string> {
  const session = await login(email, TEST_PASSWORD, {
    ipAddress: null,
    userAgent: null,
    requestId: 'customer-visibility',
  });
  return session.accessToken;
}

/**
 * A member on the STAFF role.
 *
 * The membership is created directly rather than through the invitation flow:
 * what is under test is what the role may *see*, and members.test.ts already
 * owns the proof that the invitation chain produces one.
 */
async function addStaffMember(bookable: boolean): Promise<{ token: string; profileId?: string }> {
  const user = await createUser();
  const role = await Role.findOne({ where: { businessId: fixture.business.id, key: 'STAFF' } });
  if (!role) throw new Error('fixture expected the workspace to have a STAFF role');

  const membership = await Membership.create({
    userId: user.id,
    businessId: fixture.business.id,
    roleId: role.id,
    status: 'ACTIVE',
    invitedByUserId: null,
    invitedAt: null,
    joinedAt: new Date(),
  });

  const token = await tokenFor(user.email);
  if (!bookable) return { token };

  // `staffProfileId` on the tenant context is resolved from this row, and it is
  // what turns `customers:read:assigned` into a real set rather than an empty
  // one. A member without it is the NOTHING scope.
  const profile = await StaffProfile.create({
    businessId: fixture.business.id,
    userId: user.id,
    membershipId: membership.id,
    displayName: 'Nadia Provider',
    title: null,
    bio: null,
    avatarUrl: null,
    timezone: 'UTC',
    defaultLocationId: null,
    preBufferMinutes: null,
    postBufferMinutes: null,
    minNoticeMinutes: null,
    maxDailyAppointments: null,
    maxWeeklyAppointments: null,
    lastAssignedAt: null,
  });

  await ServiceStaff.create({
    serviceId: fixture.service.id,
    staffProfileId: profile.id,
    durationMinutesOverride: null,
    priceAmountOverride: null,
  });

  // The same Mon–Fri 09:00–17:00 the fixture gives the owner, so this provider
  // has slots the booking path will accept.
  await StaffAvailabilityRule.bulkCreate(
    [1, 2, 3, 4, 5].map((dayOfWeek) => ({
      businessId: fixture.business.id,
      staffProfileId: profile.id,
      locationId: null,
      dayOfWeek,
      startMinute: 9 * 60,
      endMinute: 17 * 60,
      effectiveFrom: null,
      effectiveTo: null,
    })),
  );

  return { token, profileId: profile.id };
}

async function bookWith(profileId: string, startsAt: Date, email: string): Promise<string> {
  await createBooking({
    businessId: fixture.business.id,
    serviceId: fixture.service.id,
    staffProfileId: profileId,
    locationId: null,
    startsAt,
    timezone: 'UTC',
    customer: { firstName: 'Booked', lastName: 'Person', email },
    source: 'PUBLIC',
    actor: { type: 'CUSTOMER', label: email },
  });

  const customer = await Customer.findOne({ where: { businessId: fixture.business.id, email } });
  if (!customer) throw new Error(`booking did not produce a customer for ${email}`);
  return customer.id;
}

function asStaff(path: string): request.Test {
  return request(app)
    .get(path)
    .set('Authorization', `Bearer ${staffToken}`)
    .set('X-Business-Id', fixture.business.id);
}

beforeAll(async () => {
  await resetDatabase();
  fixture = await createWorkspace();
  ownerToken = await tokenFor(fixture.user.email);

  const bookable = await addStaffMember(true);
  staffToken = bookable.token;
  staffProfileId = bookable.profileId!;

  deskToken = (await addStaffMember(false)).token;

  // 10:00 and 11:00 on the same weekday: two providers, two customers, no
  // overlap for either of them.
  assignedCustomerId = await bookWith(staffProfileId, nextWeekdayAt(10), 'assigned@meetflow.test');
  otherCustomerId = await bookWith(
    fixture.staffProfile.id,
    nextWeekdayAt(11),
    'stranger@meetflow.test',
  );
});

afterAll(async () => {
  await closeDatabaseConnection();
});

describe('a staff member holding only customers:read:assigned', () => {
  it('reaches the customer list at all', async () => {
    // The regression. Before the routes accepted the scoped permission this was
    // a 403, and the client's own navigation sent every staff member into it.
    await asStaff('/api/v1/customers').expect(200);
  });

  it('sees the customers booked with them, and no others', async () => {
    const response = await asStaff('/api/v1/customers').expect(200);

    const ids = (response.body.data as Array<{ id: string }>).map((row) => row.id);
    expect(ids).toEqual([assignedCustomerId]);
    expect(ids).not.toContain(otherCustomerId);
    // The page count has to agree with the page, or the client paginates into
    // rows it is never shown.
    expect(response.body.meta.totalItems).toBe(1);
  });

  it('opens one of their own customers', async () => {
    const response = await asStaff(`/api/v1/customers/${assignedCustomerId}`).expect(200);
    expect(response.body.data.customer.id).toBe(assignedCustomerId);
    expect(response.body.data.recentAppointments).toHaveLength(1);
  });

  it("answers 404 — not 403 — for somebody else's customer", async () => {
    // 403 would confirm the record exists, which is all it takes to walk the id
    // space and learn who else the workspace books.
    await asStaff(`/api/v1/customers/${otherCustomerId}`).expect(404);
  });

  it("answers 404 for somebody else's customer history too", async () => {
    await asStaff(`/api/v1/customers/${otherCustomerId}/appointments`).expect(404);
  });

  it('sees their own share of a shared customer, not the whole history', async () => {
    // The same person, booked with both providers. The staff member may see
    // them — but seeing the appointment they are not on would be a way around
    // `appointments:read:own`, reached by asking about the customer instead of
    // about the diary.
    const shared = await bookWith(staffProfileId, nextWeekdayAt(14), 'shared@meetflow.test');
    await bookWith(fixture.staffProfile.id, nextWeekdayAt(15), 'shared@meetflow.test');

    const staffView = await asStaff(`/api/v1/customers/${shared}/appointments`).expect(200);
    expect(staffView.body.meta.totalItems).toBe(1);
    expect(staffView.body.data[0].staffProfile.id).toBe(staffProfileId);

    const ownerView = await request(app)
      .get(`/api/v1/customers/${shared}/appointments`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-Business-Id', fixture.business.id)
      .expect(200);
    expect(ownerView.body.meta.totalItems).toBe(2);
  });

  it('still cannot create, edit or delete a customer', async () => {
    // Widening the read routes must not have widened the write ones: those
    // still take `customers:manage`, which this role does not hold.
    await request(app)
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${staffToken}`)
      .set('X-Business-Id', fixture.business.id)
      .send({ firstName: 'Mallory', email: 'mallory@meetflow.test' })
      .expect(403);

    await request(app)
      .patch(`/api/v1/customers/${assignedCustomerId}`)
      .set('Authorization', `Bearer ${staffToken}`)
      .set('X-Business-Id', fixture.business.id)
      .send({ firstName: 'Renamed' })
      .expect(403);

    await request(app)
      .delete(`/api/v1/customers/${assignedCustomerId}`)
      .set('Authorization', `Bearer ${staffToken}`)
      .set('X-Business-Id', fixture.business.id)
      .expect(403);
  });
});

describe('a member with the permission but no staff profile', () => {
  it('gets an empty list rather than an error', async () => {
    // Nobody is booked with somebody who cannot be booked. That is an empty
    // answer, not a refusal about a permission they genuinely hold.
    const response = await request(app)
      .get('/api/v1/customers')
      .set('Authorization', `Bearer ${deskToken}`)
      .set('X-Business-Id', fixture.business.id)
      .expect(200);

    expect(response.body.data).toEqual([]);
    expect(response.body.meta.totalItems).toBe(0);
  });

  it('cannot open a customer by id either', async () => {
    await request(app)
      .get(`/api/v1/customers/${assignedCustomerId}`)
      .set('Authorization', `Bearer ${deskToken}`)
      .set('X-Business-Id', fixture.business.id)
      .expect(404);
  });
});

describe('the owner', () => {
  it('still sees the whole address book', async () => {
    const response = await request(app)
      .get('/api/v1/customers')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-Business-Id', fixture.business.id)
      .expect(200);

    const ids = (response.body.data as Array<{ id: string }>).map((row) => row.id);
    expect(ids).toContain(assignedCustomerId);
    expect(ids).toContain(otherCustomerId);
  });
});
