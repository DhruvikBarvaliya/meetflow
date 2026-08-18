/**
 * Booking safety under concurrency.
 *
 * These are the tests that justify the whole design. They run against real
 * PostgreSQL with real transactions, because the guarantees being verified —
 * exclusion constraints, row locks, idempotency — do not exist anywhere else.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Appointment,
  AppointmentParticipant,
  AppointmentStaff,
  Customer,
} from '../../src/database/models';
import { createBooking } from '../../src/modules/appointments/booking.service';
import { ErrorCode, type AppError } from '../../src/utils/errors';
import {
  closeDatabaseConnection,
  createWorkspace,
  nextWeekdayAt,
  resetDatabase,
  type WorkspaceFixture,
} from '../helpers/fixtures';

let fixture: WorkspaceFixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await createWorkspace();
});

afterAll(async () => {
  await closeDatabaseConnection();
});

function bookingInput(fixtureRef: WorkspaceFixture, startsAt: Date, email: string) {
  return {
    businessId: fixtureRef.business.id,
    serviceId: fixtureRef.service.id,
    staffProfileId: fixtureRef.staffProfile.id,
    locationId: null,
    startsAt,
    timezone: 'UTC',
    customer: { firstName: 'Test', lastName: 'Customer', email },
    source: 'PUBLIC' as const,
    actor: { type: 'CUSTOMER' as const, label: email },
  };
}

describe('concurrent booking of the same slot', () => {
  it('lets exactly one of ten simultaneous requests win', async () => {
    const startsAt = nextWeekdayAt(10);

    const attempts = Array.from({ length: 10 }, (_, index) =>
      createBooking(bookingInput(fixture, startsAt, `racer${index}@meetflow.test`)),
    );
    const results = await Promise.allSettled(attempts);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(9);

    // Every loser must get an actionable conflict, never a raw database error.
    for (const failure of rejected) {
      const error = (failure as PromiseRejectedResult).reason as AppError;
      expect(error.statusCode).toBe(409);
      expect([
        ErrorCode.SLOT_UNAVAILABLE,
        ErrorCode.CONFLICT,
        ErrorCode.RESOURCE_UNAVAILABLE,
      ]).toContain(error.code);
    }

    // And the database must hold exactly one appointment and one reservation.
    const appointments = await Appointment.count({ where: { businessId: fixture.business.id } });
    const reservations = await AppointmentStaff.count({
      where: { staffProfileId: fixture.staffProfile.id, isBlocking: true },
    });
    expect(appointments).toBe(1);
    expect(reservations).toBe(1);
  });

  it('allows adjacent slots to be booked simultaneously', async () => {
    const first = nextWeekdayAt(10);
    const second = new Date(first.getTime() + 30 * 60_000);

    const results = await Promise.allSettled([
      createBooking(bookingInput(fixture, first, 'a@meetflow.test')),
      createBooking(bookingInput(fixture, second, 'b@meetflow.test')),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(await Appointment.count({ where: { businessId: fixture.business.id } })).toBe(2);
  });

  it('rejects an overlapping booking made after the fact', async () => {
    const startsAt = nextWeekdayAt(11);
    await createBooking(bookingInput(fixture, startsAt, 'first@meetflow.test'));

    // 15 minutes into an existing 30-minute appointment.
    const overlapping = new Date(startsAt.getTime() + 15 * 60_000);
    await expect(
      createBooking(bookingInput(fixture, overlapping, 'second@meetflow.test')),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('buffers block adjacent time', () => {
  it('prevents a booking that would collide with the previous appointment’s cleanup buffer', async () => {
    const buffered = await createWorkspace({ postBufferMinutes: 15, slotIntervalMinutes: 15 });
    const startsAt = nextWeekdayAt(10);

    await createBooking(bookingInput(buffered, startsAt, 'first@meetflow.test'));

    // Appointment ends 10:30, buffer runs to 10:45 — 10:30 must be refused.
    const tooSoon = new Date(startsAt.getTime() + 30 * 60_000);
    await expect(
      createBooking(bookingInput(buffered, tooSoon, 'second@meetflow.test')),
    ).rejects.toMatchObject({ statusCode: 409 });

    // 10:45 is clear.
    const clear = new Date(startsAt.getTime() + 45 * 60_000);
    await expect(
      createBooking(bookingInput(buffered, clear, 'third@meetflow.test')),
    ).resolves.toBeTruthy();
  });
});

describe('idempotency', () => {
  it('returns the same appointment for a repeated key instead of double booking', async () => {
    const startsAt = nextWeekdayAt(14);
    const key = 'idem-key-abc-123';

    const first = await createBooking({
      ...bookingInput(fixture, startsAt, 'idem@meetflow.test'),
      idempotencyKey: key,
    });
    const second = await createBooking({
      ...bookingInput(fixture, startsAt, 'idem@meetflow.test'),
      idempotencyKey: key,
    });

    expect(second.replayed).toBe(true);
    expect(second.appointment.id).toBe(first.appointment.id);
    expect(await Appointment.count({ where: { businessId: fixture.business.id } })).toBe(1);
  });

  it('survives concurrent retries of the same key', async () => {
    const startsAt = nextWeekdayAt(15);
    const key = 'idem-key-concurrent';

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        createBooking({
          ...bookingInput(fixture, startsAt, 'retry@meetflow.test'),
          idempotencyKey: key,
        }),
      ),
    );

    // Whatever the interleaving, the database must end up with one appointment.
    expect(await Appointment.count({ where: { businessId: fixture.business.id } })).toBe(1);

    // Any request that did not succeed must say why in a way a client can act
    // on — "already processing" or "slot taken", never an opaque 500.
    for (const failure of results.filter((r) => r.status === 'rejected')) {
      const error = (failure as PromiseRejectedResult).reason as AppError;
      expect(error.statusCode).toBeLessThan(500);
    }
  });

  it('rejects the same key used with a different payload', async () => {
    const startsAt = nextWeekdayAt(16);
    const key = 'idem-key-mismatch';

    await createBooking({
      ...bookingInput(fixture, startsAt, 'one@meetflow.test'),
      idempotencyKey: key,
    });

    await expect(
      createBooking({
        ...bookingInput(fixture, new Date(startsAt.getTime() + 60 * 60_000), 'two@meetflow.test'),
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.IDEMPOTENCY_KEY_REUSED });
  });
});

describe('group services', () => {
  it('fills a class up to capacity and then refuses', async () => {
    const group = await createWorkspace({ serviceCapacity: 3, serviceDurationMinutes: 60 });
    const startsAt = nextWeekdayAt(10);

    for (let index = 0; index < 3; index += 1) {
      await createBooking(bookingInput(group, startsAt, `attendee${index}@meetflow.test`));
    }

    // One appointment, three participants — not three appointments.
    const appointments = await Appointment.findAll({ where: { businessId: group.business.id } });
    expect(appointments).toHaveLength(1);
    expect(appointments[0]!.bookedCount).toBe(3);
    expect(
      await AppointmentParticipant.count({ where: { appointmentId: appointments[0]!.id } }),
    ).toBe(3);

    await expect(
      createBooking(bookingInput(group, startsAt, 'toolate@meetflow.test')),
    ).rejects.toMatchObject({ code: ErrorCode.CAPACITY_EXCEEDED });
  });

  it('never oversells the last place under concurrency', async () => {
    const group = await createWorkspace({ serviceCapacity: 2, serviceDurationMinutes: 60 });
    const startsAt = nextWeekdayAt(11);

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        createBooking(bookingInput(group, startsAt, `rush${index}@meetflow.test`)),
      ),
    );

    const appointments = await Appointment.findAll({ where: { businessId: group.business.id } });
    expect(appointments).toHaveLength(1);
    expect(appointments[0]!.bookedCount).toBe(2);
    expect(appointments[0]!.bookedCount).toBeLessThanOrEqual(appointments[0]!.capacity);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
  });

  it('refuses to book the same customer into one session twice', async () => {
    const group = await createWorkspace({ serviceCapacity: 5, serviceDurationMinutes: 60 });
    const startsAt = nextWeekdayAt(12);

    await createBooking(bookingInput(group, startsAt, 'dup@meetflow.test'));
    await expect(
      createBooking(bookingInput(group, startsAt, 'dup@meetflow.test')),
    ).rejects.toMatchObject({ code: ErrorCode.ALREADY_EXISTS });
  });
});

describe('cross-tenant isolation', () => {
  it('refuses to book a service belonging to another workspace', async () => {
    const other = await createWorkspace();

    await expect(
      createBooking({
        ...bookingInput(fixture, nextWeekdayAt(10), 'x@meetflow.test'),
        // This tenant's business id, the other tenant's service.
        serviceId: other.service.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses to assign a staff member from another workspace', async () => {
    const other = await createWorkspace();

    await expect(
      createBooking({
        ...bookingInput(fixture, nextWeekdayAt(10), 'y@meetflow.test'),
        staffProfileId: other.staffProfile.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('keeps a customer with the same email separate per workspace', async () => {
    const other = await createWorkspace();
    const email = 'shared@meetflow.test';

    await createBooking(bookingInput(fixture, nextWeekdayAt(10), email));
    await createBooking(bookingInput(other, nextWeekdayAt(10), email));

    const customers = await Customer.findAll({ where: { email } });
    expect(customers).toHaveLength(2);
    expect(new Set(customers.map((customer) => customer.businessId)).size).toBe(2);
  });
});

describe('booking policy', () => {
  it('refuses a time outside working hours', async () => {
    // 03:00 UTC is well before the 09:00 opening.
    await expect(
      createBooking(bookingInput(fixture, nextWeekdayAt(3), 'early@meetflow.test')),
    ).rejects.toMatchObject({ code: ErrorCode.SLOT_UNAVAILABLE });
  });

  it('refuses a booking inside the minimum notice window', async () => {
    const strict = await createWorkspace({ minNoticeMinutes: 60 * 24 * 14 }); // two weeks
    await expect(
      createBooking(bookingInput(strict, nextWeekdayAt(10), 'soon@meetflow.test')),
    ).rejects.toMatchObject({ code: ErrorCode.SLOT_UNAVAILABLE });
  });
});
