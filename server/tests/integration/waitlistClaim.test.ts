/**
 * The customer's end of the waitlist, over real HTTP and real PostgreSQL.
 *
 * The defect these tests exist for was invisible from inside the server. Every
 * piece of the waitlist worked: a slot freed, the matcher picked the fairest
 * candidate, a hold was placed, an audit line was written and an email went out
 * saying "Claim it here". The link in that email pointed at a route no client
 * and no server had ever implemented, so the customer landed on a Not Found
 * page, the hold lapsed, and the opening went unfilled. Nothing failed, nothing
 * was logged, and the only way to see it was to follow the link.
 *
 * So the first test does exactly that: it reads the URL out of the queued
 * notification and drives it, rather than asserting against a path this file
 * happens to know. A future rename that breaks the promise the email makes
 * fails here, which is the only kind of test that can catch this class of bug.
 *
 * The rest pin the states a claim can land in, because "you cannot have it" is
 * three different sentences to the person holding the link: somebody already
 * took it, you took it yourself, or you were too late.
 */
import express, { Router, type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Appointment,
  AppointmentStaff,
  BookingLink,
  Customer,
  Notification,
  WaitlistEntry,
} from '../../src/database/models';
import { errorHandler, notFoundHandler } from '../../src/middleware/errorHandler';
import { requestId } from '../../src/middleware/requestContext';
import { publicWaitlistRouter } from '../../src/modules/waitlist/publicWaitlist.routes';
import { evaluateWaitlistForSlot } from '../../src/modules/waitlist/waitlist.matcher';
import {
  createWaitlistEntry,
  type WaitlistStaffActor,
} from '../../src/modules/waitlist/waitlist.service';
import { ErrorCode } from '../../src/utils/errors';
import { toIsoDateInZone } from '../../src/utils/time';
import {
  closeDatabaseConnection,
  createWorkspace,
  nextWeekdayAt,
  resetDatabase,
  type WorkspaceFixture,
} from '../helpers/fixtures';

/**
 * The public surface as this module asks for it to be mounted.
 *
 * `createApp()` cannot be used yet: mounting the router belongs to
 * src/routes/index.ts, which this wave does not own, so the wiring is reported
 * rather than made. This mirrors that mount exactly — the same parent path, the
 * same 404 terminator, the same error translation — so the day the line lands
 * these tests describe the real application without changing.
 */
function createPublicApp(): Express {
  const app = express();
  app.use(requestId);
  app.use(express.json());

  const publicRouter = Router();
  publicRouter.use(publicWaitlistRouter);
  publicRouter.use(notFoundHandler);

  app.use('/api/v1/public', publicRouter);
  app.use(errorHandler);
  return app;
}

const app = createPublicApp();

let fixture: WorkspaceFixture;
let actor: WaitlistStaffActor;
let slug = 0;

beforeEach(async () => {
  await resetDatabase();
  fixture = await createWorkspace();
  actor = { userId: fixture.user.id, email: fixture.user.email, type: 'OWNER' };
});

afterAll(async () => {
  await closeDatabaseConnection();
});

/** A standing request that matches any time on the slot's own calendar day. */
async function waitlistFor(customerId: string, startsAt: Date): Promise<WaitlistEntry> {
  const date = toIsoDateInZone(startsAt, 'UTC');
  return createWaitlistEntry(
    fixture.business.id,
    {
      customerId,
      serviceId: fixture.service.id,
      staffProfileId: null,
      locationId: null,
      earliestDate: date,
      latestDate: date,
      earliestMinute: 0,
      latestMinute: 1440,
      daysOfWeek: [],
      timezone: 'UTC',
      priority: 100,
      notifyChannel: 'EMAIL',
      expiresAt: null,
      note: null,
    },
    actor,
    { requestId: 'fixture', ipAddress: null, userAgent: null },
  );
}

/** Frees `startsAt` in the eyes of the matcher and lets it make an offer. */
async function offerSlot(startsAt: Date): Promise<WaitlistEntry | null> {
  return evaluateWaitlistForSlot({
    businessId: fixture.business.id,
    serviceId: fixture.service.id,
    staffProfileId: fixture.staffProfile.id,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
  });
}

async function reload(entry: WaitlistEntry): Promise<WaitlistEntry> {
  const fresh = await WaitlistEntry.findByPk(entry.id);
  if (!fresh) throw new Error('the waitlist entry vanished');
  return fresh;
}

describe('the link in the offer email', () => {
  it('resolves to a claimable offer, and claiming it books the slot', async () => {
    const startsAt = nextWeekdayAt(10);
    const entry = await waitlistFor(fixture.customer.id, startsAt);
    expect(await offerSlot(startsAt)).not.toBeNull();

    // The address the customer is actually given, taken from the message that
    // gives it to them rather than assumed.
    const message = await Notification.findOne({
      where: { type: 'WAITLIST_SLOT_AVAILABLE', waitlistEntryId: entry.id },
    });
    expect(message).not.toBeNull();
    const claimUrl = String(message?.payload.claimUrl ?? '');
    expect(claimUrl).toContain(entry.publicId);

    const offerPath = new URL(claimUrl).pathname;

    const shown = await request(app).get(`/api/v1/public${offerPath}`).expect(200);
    expect(shown.body.data.claimable).toBe(true);
    expect(shown.body.data.offer.startsAt).toBe(startsAt.toISOString());
    expect(shown.body.data.service.name).toBe(fixture.service.name);
    // A bearer-token URL must not hand on contact details with it.
    expect(shown.body.data.customer).toEqual({ firstName: 'Ada', lastName: 'Customer' });

    const claimed = await request(app)
      .post(`/api/v1/public${offerPath}/claim`)
      .send({})
      .expect(201);

    expect(claimed.body.data.appointment.publicId).toMatch(/^apt_/);
    expect(claimed.body.data.waitlist.status).toBe('CONVERTED');
  });
});

describe('claiming an offer', () => {
  it('books through the booking service, reservation and all', async () => {
    const startsAt = nextWeekdayAt(11);
    const entry = await waitlistFor(fixture.customer.id, startsAt);
    await offerSlot(startsAt);

    await request(app).post(`/api/v1/public/waitlist/${entry.publicId}/claim`).send({}).expect(201);

    // A row in `appointments` is not the interesting part; the blocking staff
    // reservation is. It is written only by `createBooking`, and it is what the
    // exclusion constraint protects — so its presence is the proof that this
    // claim went through every safety layer rather than around them.
    const appointment = await Appointment.findOne({ where: { businessId: fixture.business.id } });
    expect(appointment).not.toBeNull();
    expect(appointment?.source).toBe('WAITLIST');
    expect(appointment?.startsAt.toISOString()).toBe(startsAt.toISOString());
    expect(
      await AppointmentStaff.count({
        where: { appointmentId: appointment?.id, isBlocking: true },
      }),
    ).toBe(1);

    const settled = await reload(entry);
    expect(settled.status).toBe('CONVERTED');
    expect(settled.convertedAppointmentId).toBe(appointment?.id);
    expect(settled.holdExpiresAt).toBeNull();
  });

  it('refuses a hold that has already expired, and puts the customer back in the queue', async () => {
    const startsAt = nextWeekdayAt(12);
    const entry = await waitlistFor(fixture.customer.id, startsAt);
    await offerSlot(startsAt);

    // The hold as it looks a minute after it lapsed, before the sweep has run.
    const held = await reload(entry);
    await held.update({ holdExpiresAt: new Date(Date.now() - 60_000) });

    const response = await request(app)
      .post(`/api/v1/public/waitlist/${entry.publicId}/claim`)
      .send({})
      .expect(409);

    expect(response.body.error.code).toBe(ErrorCode.BOOKING_WINDOW_CLOSED);
    // Actionable, not merely refused: they are still on the list.
    expect(response.body.error.message).toMatch(/still on the waitlist/i);

    const released = await reload(entry);
    expect(released.status).toBe('ACTIVE');
    expect(released.heldSlotStartsAt).toBeNull();
    expect(await Appointment.count({ where: { businessId: fixture.business.id } })).toBe(0);
  });

  it('refuses a second claim and points at the booking the first one made', async () => {
    const startsAt = nextWeekdayAt(13);
    const entry = await waitlistFor(fixture.customer.id, startsAt);
    await offerSlot(startsAt);

    const first = await request(app)
      .post(`/api/v1/public/waitlist/${entry.publicId}/claim`)
      .send({})
      .expect(201);

    const second = await request(app)
      .post(`/api/v1/public/waitlist/${entry.publicId}/claim`)
      .send({})
      .expect(409);

    expect(second.body.error.code).toBe(ErrorCode.ALREADY_EXISTS);
    expect(second.body.error.meta.appointmentPublicId).toBe(first.body.data.appointment.publicId);
    expect(await Appointment.count({ where: { businessId: fixture.business.id } })).toBe(1);
  });

  it('leaves exactly one appointment when two claims arrive at once', async () => {
    const startsAt = nextWeekdayAt(14);
    const entry = await waitlistFor(fixture.customer.id, startsAt);
    await offerSlot(startsAt);

    const claim = (): request.Test =>
      request(app).post(`/api/v1/public/waitlist/${entry.publicId}/claim`).send({});
    const [a, b] = await Promise.all([claim(), claim()]);

    // One appointment is the invariant. Which of the two losing shapes the
    // second request takes is timing: it either loses the race for the
    // idempotency key and is refused with a 409, or arrives just late enough to
    // replay the first result. Both are correct; a second appointment and a 500
    // are the failures worth naming.
    const booked = [a, b].filter((response) => response.status === 201);
    expect(booked.length).toBeGreaterThanOrEqual(1);
    for (const response of [a, b]) expect([201, 409]).toContain(response.status);

    const publicIds = new Set(
      booked.map((response) => String(response.body.data.appointment.publicId)),
    );
    expect(publicIds.size).toBe(1);
    expect(await Appointment.count({ where: { businessId: fixture.business.id } })).toBe(1);
  });

  it('refuses a claim when no opening is being held', async () => {
    const entry = await waitlistFor(fixture.customer.id, nextWeekdayAt(15));

    const response = await request(app)
      .post(`/api/v1/public/waitlist/${entry.publicId}/claim`)
      .send({})
      .expect(409);

    expect(response.body.error.code).toBe(ErrorCode.CONFLICT);
    expect(response.body.error.message).toMatch(/still on the waitlist/i);
  });

  it('answers an unknown handle with a 404 that says nothing else', async () => {
    const response = await request(app)
      .get('/api/v1/public/waitlist/wlt_0123456789ABCDEFGHJKMNPQRS')
      .expect(404);
    expect(response.body.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});

describe('joining a waitlist from a booking link', () => {
  async function createLink(): Promise<BookingLink> {
    slug += 1;
    return BookingLink.create({
      businessId: fixture.business.id,
      slug: `waitlist-join-${process.pid}-${slug}`,
      name: 'Book a consultation',
      description: null,
      type: 'SINGLE_SERVICE',
      serviceId: fixture.service.id,
      teamId: null,
      staffProfileId: null,
      locationId: null,
      requiresApproval: false,
      maxBookingsTotal: null,
      expiresAt: null,
      deletedAt: null,
    });
  }

  function joinBody(email: string): Record<string, unknown> {
    const date = toIsoDateInZone(nextWeekdayAt(10), 'UTC');
    return {
      serviceId: fixture.service.id,
      earliestDate: date,
      latestDate: date,
      timezone: 'UTC',
      customer: { firstName: 'Bea', lastName: 'Waiting', email },
    };
  }

  it('takes a request from somebody the workspace has never seen', async () => {
    const link = await createLink();

    const response = await request(app)
      .post(`/api/v1/public/booking-links/${link.slug}/waitlist`)
      .send(joinBody('newcomer@meetflow.test'))
      .expect(201);

    expect(response.body.data.status).toBe('ACTIVE');
    expect(response.body.data.offer).toBeNull();
    expect(response.body.data.offerUrl).toContain(response.body.data.publicId);

    const customer = await Customer.findOne({
      where: { businessId: fixture.business.id, email: 'newcomer@meetflow.test' },
    });
    expect(customer).not.toBeNull();

    const entry = await WaitlistEntry.findOne({ where: { customerId: customer?.id } });
    // Neither of these is settable from the public body, and both matter: one
    // is the customer's place in the queue, the other is how they are reached.
    expect(entry?.priority).toBe(100);
    expect(entry?.notifyChannel).toBe('EMAIL');
  });

  it('is matched by the engine like any other entry', async () => {
    const link = await createLink();
    const startsAt = nextWeekdayAt(10);

    await request(app)
      .post(`/api/v1/public/booking-links/${link.slug}/waitlist`)
      .send(joinBody('matched@meetflow.test'))
      .expect(201);

    const served = await offerSlot(startsAt);
    expect(served).not.toBeNull();
    expect(served?.status).toBe('NOTIFIED');
  });

  it('refuses a second live request for the same service', async () => {
    const link = await createLink();

    await request(app)
      .post(`/api/v1/public/booking-links/${link.slug}/waitlist`)
      .send(joinBody('twice@meetflow.test'))
      .expect(201);

    const response = await request(app)
      .post(`/api/v1/public/booking-links/${link.slug}/waitlist`)
      .send(joinBody('twice@meetflow.test'))
      .expect(409);

    expect(response.body.error.code).toBe(ErrorCode.ALREADY_EXISTS);
  });

  it('refuses a service the link does not publish, without confirming it exists', async () => {
    const link = await createLink();
    const other = await createWorkspace();

    const response = await request(app)
      .post(`/api/v1/public/booking-links/${link.slug}/waitlist`)
      .send({ ...joinBody('probe@meetflow.test'), serviceId: other.service.id })
      .expect(404);

    expect(response.body.error.code).toBe(ErrorCode.NOT_FOUND);
    expect(await WaitlistEntry.count({ where: { businessId: other.business.id } })).toBe(0);
  });

  it('refuses a body that names a workspace', async () => {
    const link = await createLink();

    await request(app)
      .post(`/api/v1/public/booking-links/${link.slug}/waitlist`)
      .send({ ...joinBody('smuggler@meetflow.test'), businessId: fixture.business.id })
      .expect(422);
  });
});
