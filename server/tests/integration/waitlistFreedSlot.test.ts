/**
 * Every way a slot comes free must reach the waitlist.
 *
 * Three lifecycle transitions hand a window back: a cancellation, a rejection,
 * and a reschedule — which frees the time it *left*, not the time it moved to.
 * Only cancellation ever called the matcher, so somebody waiting on a slot that
 * a business rejected, or moved a booking away from, was never told it had
 * opened. Their entry stayed ACTIVE until something else happened to free the
 * same minute, which for a quiet diary is never.
 *
 * The three are now routed through one `offerFreedSlot` helper precisely so the
 * fourth transition to free a slot cannot silently skip it. These tests are the
 * other half of that guarantee: they assert the *behaviour* at each entry point
 * rather than that the helper exists, so inlining it again would still be
 * caught.
 *
 * The offer is deliberately fire-and-forget — a failed offer must never turn a
 * completed cancellation into an error the customer sees — so each test polls
 * for the notification rather than awaiting the transition's own promise.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Customer, Notification } from '../../src/database/models';
import { createBooking } from '../../src/modules/appointments/booking.service';
import {
  cancelAppointment,
  rejectAppointment,
  rescheduleAppointment,
} from '../../src/modules/appointments/lifecycle.service';
import { createWaitlistEntry } from '../../src/modules/waitlist/waitlist.service';
import { toIsoDateInZone } from '../../src/utils/time';
import {
  closeDatabaseConnection,
  createWorkspace,
  nextWeekdayAt,
  resetDatabase,
  type WorkspaceFixture,
} from '../helpers/fixtures';

let fixture: WorkspaceFixture;
let sequence = 0;

beforeEach(async () => {
  await resetDatabase();
  fixture = await createWorkspace();
  sequence = 0;
});

afterAll(async () => {
  await closeDatabaseConnection();
});

/** Somebody holding the slot we are about to free. */
async function bookedAppointment(startsAt: Date) {
  sequence += 1;
  const result = await createBooking({
    businessId: fixture.business.id,
    serviceId: fixture.service.id,
    staffProfileId: fixture.staffProfile.id,
    locationId: null,
    startsAt,
    timezone: 'UTC',
    customer: {
      firstName: 'Holder',
      lastName: 'Ofslot',
      email: `holder-${process.pid}-${sequence}@meetflow.test`,
    },
    source: 'PUBLIC',
    actor: { type: 'CUSTOMER', label: 'holder' },
  });
  return result.appointment;
}

/**
 * Somebody waiting for that same minute.
 *
 * `window: 'day'` accepts anything on the date, which is the ordinary case;
 * `window: 'exact'` narrows to the one half-hour, which is what lets a test
 * distinguish "was offered the slot I meant" from "was offered some other slot
 * on the same day that happens to satisfy them".
 */
async function waitingCustomer(startsAt: Date, window: 'day' | 'exact' = 'day'): Promise<void> {
  sequence += 1;
  const customer = await Customer.create({
    businessId: fixture.business.id,
    publicId: `cus_freed${process.pid}${sequence}`,
    userId: null,
    firstName: `Waiter${sequence}`,
    lastName: 'Hopeful',
    email: `waiter-${process.pid}-${sequence}@meetflow.test`,
    phone: null,
    timezone: 'UTC',
    notes: null,
    preferredStaffProfileId: null,
    preferredLocationId: null,
    firstAppointmentAt: null,
    lastAppointmentAt: null,
  });

  const date = toIsoDateInZone(startsAt, 'UTC');
  const minuteOfDay = startsAt.getUTCHours() * 60 + startsAt.getUTCMinutes();
  await createWaitlistEntry(
    fixture.business.id,
    {
      customerId: customer.id,
      serviceId: fixture.service.id,
      staffProfileId: fixture.staffProfile.id,
      locationId: null,
      earliestDate: date,
      latestDate: date,
      ...(window === 'exact'
        ? { earliestMinute: minuteOfDay, latestMinute: minuteOfDay + 30 }
        : { earliestMinute: 0, latestMinute: 1440 }),
      daysOfWeek: [],
      timezone: 'UTC',
      priority: 100,
      notifyChannel: 'EMAIL',
      expiresAt: null,
      note: null,
    },
    { userId: fixture.user.id, email: fixture.user.email, type: 'OWNER' },
    { requestId: 'freed-slot', ipAddress: null, userAgent: null },
  );
}

/**
 * Waits for the offer the transition fires without awaiting.
 *
 * Polling rather than a fixed sleep: the offer is one round trip behind the
 * transition, and a sleep long enough to be reliable on a loaded machine would
 * be long enough to make the suite tedious on an idle one.
 */
async function offersSent(timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = await Notification.count({ where: { type: 'WAITLIST_SLOT_AVAILABLE' } });
    if (count > 0 || Date.now() > deadline) return count;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const owner = () => ({
  userId: fixture.user.id,
  email: fixture.user.email,
  type: 'OWNER' as const,
});

describe('a freed slot reaches the waitlist', () => {
  it('when the customer cancels', async () => {
    const startsAt = nextWeekdayAt(10);
    const appointment = await bookedAppointment(startsAt);
    await waitingCustomer(startsAt);

    await cancelAppointment({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      actor: owner(),
      reason: 'no longer needed',
    });

    expect(await offersSent()).toBe(1);
  });

  it('when the business rejects it', async () => {
    const startsAt = nextWeekdayAt(11);

    // REJECTED is reachable only from PENDING — rejecting is what a business
    // does to a request awaiting approval, not to a confirmed booking, which it
    // would cancel instead. So the service has to ask for approval for this
    // appointment to be rejectable at all.
    await fixture.service.update({ requiresApproval: true });

    const appointment = await bookedAppointment(startsAt);
    expect(appointment.status).toBe('PENDING');
    await waitingCustomer(startsAt);

    await rejectAppointment({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      actor: owner(),
      reason: 'double booked elsewhere',
    });

    // Before the fix this was 0: rejection freed the slot and told nobody.
    expect(await offersSent()).toBe(1);
  });

  it('when a booking is moved away, offering the time it left', async () => {
    const startsAt = nextWeekdayAt(12);
    const appointment = await bookedAppointment(startsAt);
    await waitingCustomer(startsAt);

    // Two hours later, well clear of the original window and its buffers.
    await rescheduleAppointment({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      newStartsAt: new Date(startsAt.getTime() + 2 * 60 * 60_000),
      actor: owner(),
      reason: 'provider asked to move it',
    });

    expect(await offersSent()).toBe(1);
  });

  it('does not offer the slot a reschedule moved *into*', async () => {
    const startsAt = nextWeekdayAt(13);
    const target = new Date(startsAt.getTime() + 2 * 60 * 60_000);
    const appointment = await bookedAppointment(startsAt);

    // Waiting for the destination *only* — narrowed to that half-hour, so a
    // match can only mean the destination was offered. With a whole-day window
    // the freed 13:00 would satisfy them legitimately, and the test would be
    // asserting nothing.
    await waitingCustomer(target, 'exact');

    await rescheduleAppointment({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      newStartsAt: target,
      actor: owner(),
      reason: 'moved',
    });

    // Offering this would send someone to a slot that is now occupied — the
    // failure mode of naming the wrong end of the move.
    expect(await offersSent(2_000)).toBe(0);
  });
});
