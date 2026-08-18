/**
 * Where "this needs approving" is decided, over real HTTP and real PostgreSQL.
 *
 * Three layers can ask for a booking to be reviewed before it is promised: the
 * booking link it arrived through, the service being booked, and the workspace
 * setting. Only the last two were ever consulted. `BookingLink.requiresApproval`
 * existed as a column, was settable through the API, was published on the
 * booking context and was drawn in the owner UI as both a toggle and a "Needs
 * approval" badge — and a link flagged that way still produced CONFIRMED
 * appointments, because the effective policy was computed from the service and
 * the settings alone.
 *
 * That is the worst shape a bug of this kind can take. Nothing fails: the
 * toggle saves, the badge renders, the customer is told their booking is
 * confirmed, and the appointment goes straight into the diary. The only way to
 * see it is to book through such a link and read the status that comes back,
 * which is what this file does.
 *
 * The resolution is an OR across all three layers, and the tests are arranged
 * to pin that down rather than merely to pin down the link: each layer is
 * exercised alone, so a fix that made the link authoritative — overriding the
 * other two downwards — would fail here just as the original bug does.
 */
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { Appointment, BookingLink, BusinessSettings } from '../../src/database/models';
import {
  closeDatabaseConnection,
  createWorkspace,
  nextWeekdayAt,
  resetDatabase,
  type WorkspaceFixture,
} from '../helpers/fixtures';

const app = createApp();

let fixture: WorkspaceFixture;
let sequence = 0;

/** Slugs are the whole public URL path, so they must survive `slugSchema`. */
function uniqueSlug(tag: string): string {
  sequence += 1;
  return `${tag}-${process.pid}-${sequence}`;
}

async function createLink(requiresApproval: boolean): Promise<BookingLink> {
  return BookingLink.create({
    businessId: fixture.business.id,
    slug: uniqueSlug(requiresApproval ? 'review' : 'instant'),
    name: requiresApproval ? 'Reviewed bookings' : 'Instant bookings',
    description: null,
    type: 'SINGLE_SERVICE',
    serviceId: fixture.service.id,
    teamId: null,
    staffProfileId: null,
    locationId: null,
    requiresApproval,
    maxBookingsTotal: null,
    expiresAt: null,
    deletedAt: null,
  });
}

interface Booked {
  status: string;
  requiresApproval: boolean;
  publicId: string;
}

/** Books the fixture service through a link and returns what the customer is told. */
async function bookThrough(link: BookingLink, hour: number, email: string): Promise<Booked> {
  const response = await request(app)
    .post(`/api/v1/public/booking-links/${link.slug}/bookings`)
    .send({
      serviceId: fixture.service.id,
      staffProfileId: fixture.staffProfile.id,
      startsAt: nextWeekdayAt(hour).toISOString(),
      timezone: 'UTC',
      customer: { firstName: 'Ada', lastName: 'Booker', email },
    })
    .expect(201);

  return response.body.data.appointment as Booked;
}

/** The stored row, which is what the workspace actually has to act on. */
async function storedAppointment(publicId: string): Promise<Appointment> {
  const appointment = await Appointment.findOne({ where: { publicId } });
  if (!appointment) throw new Error(`no appointment stored for ${publicId}`);
  return appointment;
}

// Per test rather than per file: each case changes a different layer of the
// policy, and a leftover flag would silently make the next one pass.
beforeEach(async () => {
  await resetDatabase();
  fixture = await createWorkspace();
});

afterAll(async () => {
  await closeDatabaseConnection();
});

describe('a booking link flagged as requiring approval', () => {
  it('lands PENDING, not CONFIRMED', async () => {
    // The regression, and the whole defect in one assertion: the service is not
    // flagged, the workspace setting is off, and the link alone asks for review.
    const link = await createLink(true);

    const booked = await bookThrough(link, 10, 'reviewed@meetflow.test');

    expect(booked.status).toBe('PENDING');
    expect(booked.requiresApproval).toBe(true);
  });

  it('is stored unconfirmed, so nothing downstream treats it as promised', async () => {
    const link = await createLink(true);
    const booked = await bookThrough(link, 11, 'reviewed-row@meetflow.test');

    const stored = await storedAppointment(booked.publicId);
    expect(stored.status).toBe('PENDING');
    expect(stored.requiresApproval).toBe(true);
    // `confirmedAt` is what reminders, webhooks and the customer's own view read
    // to decide whether this is a real commitment yet.
    expect(stored.confirmedAt).toBeNull();
  });

  it('advertises the same answer on the page before anyone books', async () => {
    // A page that promised instant confirmation and then handed back PENDING
    // would be the same defect wearing a different hat.
    const link = await createLink(true);

    const response = await request(app)
      .get(`/api/v1/public/booking-links/${link.slug}`)
      .expect(200);

    expect(response.body.data.policy.requiresApproval).toBe(true);
    const services = response.body.data.services as Array<{ requiresApproval: boolean }>;
    expect(services.every((service) => service.requiresApproval)).toBe(true);
  });
});

describe('an unflagged link', () => {
  it('confirms immediately when no other layer asks for review', async () => {
    // The control. Without it, a fix that simply forced every booking PENDING
    // would pass every test above.
    const link = await createLink(false);

    const booked = await bookThrough(link, 12, 'instant@meetflow.test');

    expect(booked.status).toBe('CONFIRMED');
    expect(booked.requiresApproval).toBe(false);
    expect((await storedAppointment(booked.publicId)).confirmedAt).not.toBeNull();
  });

  it('still defers to the service when the service asks for review', async () => {
    // Approval is a safety valve: the link not asking for it cannot switch off
    // a layer that did. An override chain — nearest layer wins — would confirm
    // this booking, which is why the resolution is an OR.
    await fixture.service.update({ requiresApproval: true });
    const link = await createLink(false);

    const booked = await bookThrough(link, 13, 'service-review@meetflow.test');
    expect(booked.status).toBe('PENDING');
  });

  it('still defers to the workspace setting when the workspace asks for review', async () => {
    const [settings] = await BusinessSettings.findOrCreate({
      where: { businessId: fixture.business.id },
    });
    await settings.update({ requireApproval: true });
    const link = await createLink(false);

    const booked = await bookThrough(link, 14, 'workspace-review@meetflow.test');
    expect(booked.status).toBe('PENDING');
  });
});
