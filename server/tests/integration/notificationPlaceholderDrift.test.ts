/**
 * The placeholder catalogue, checked against what the producers actually send.
 *
 * `TEMPLATE_PLACEHOLDERS` is a promise made to operators: write `{{staffName}}`
 * in your cancellation email and it will be filled. Nothing in the type system
 * connects that promise to the objects `enqueueNotification` is handed —
 * `payload` is `Record<string, unknown>` on every producer — so the day someone
 * renames a field while tidying `buildPayload`, the catalogue keeps promising it
 * and `renderTemplate` starts substituting an empty string. No error, no log
 * line, no failing test: just every affected message going out with a hole in
 * it, discovered when a customer replies to ask who they are seeing.
 *
 * So this file runs the real flows — book, cancel, reschedule, approve, reject,
 * mark no-show, join a waitlist — reads the rows that land in the outbox, and
 * asserts that every name the catalogue promises for that message is actually
 * present in the payload the producer wrote.
 *
 * Two deliberate choices about what "present" means:
 *
 *  - A key that is present and an **empty string** passes. `reason` is empty on
 *    a cancellation nobody gave a reason for, and that is the correct render:
 *    the template author wrote the sentence around it.
 *  - A key that is **absent** fails, even though `renderTemplate` treats absent
 *    and empty identically today. The distinction is the whole point: absent
 *    means the producer never knew about the field, which is drift; empty means
 *    it knew and had nothing to say.
 *
 * `OWNER_DAILY_DIGEST` is excluded by name through
 * `TEMPLATE_KEYS_WITHOUT_PRODUCERS` rather than by silence, so wiring a producer
 * for it later does not quietly inherit an exemption.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Appointment,
  BusinessSettings,
  Membership,
  Notification,
  Role,
  ServiceStaff,
  StaffProfile,
  StaffAvailabilityRule,
} from '../../src/database/models';
import type { NotificationTemplateKey } from '../../src/database/models/NotificationTemplate';
import { createBooking } from '../../src/modules/appointments/booking.service';
import {
  approveAppointment,
  cancelAppointment,
  markNoShow,
  rejectAppointment,
  rescheduleAppointment,
} from '../../src/modules/appointments/lifecycle.service';
import {
  TEMPLATE_KEYS_WITHOUT_PRODUCERS,
  TEMPLATE_PLACEHOLDERS,
} from '../../src/modules/notifications/placeholders';
import { DEFAULT_TEMPLATES } from '../../src/modules/notifications/templates';
import { createWaitlistEntry } from '../../src/modules/waitlist/waitlist.service';
import { createWaitlistEntrySchema } from '../../src/modules/waitlist/waitlist.validation';
import {
  closeDatabaseConnection,
  createUser,
  createWorkspace,
  nextWeekdayAt,
  resetDatabase,
  type WorkspaceFixture,
} from '../helpers/fixtures';

let fixture: WorkspaceFixture;

/** Every payload that reached the outbox, keyed by template. */
const payloadsByType = new Map<string, Array<Record<string, unknown>>>();

function record(rows: Notification[]): void {
  for (const row of rows) {
    const list = payloadsByType.get(row.type) ?? [];
    list.push(row.payload);
    payloadsByType.set(row.type, list);
  }
}

async function drainOutbox(): Promise<void> {
  record(await Notification.findAll());
}

const actor = () => ({ type: 'OWNER' as const, label: 'owner@meetflow.test' });

/**
 * One booking exercised through every transition that produces a message.
 *
 * Done once in `beforeAll` rather than per test: each flow is several seconds
 * of real scheduling work against real constraints, and the assertions are all
 * reads of what it produced. A failure names the template, so a single shared
 * arrangement costs nothing in diagnosis.
 */
beforeAll(async () => {
  await resetDatabase();
  fixture = await createWorkspace();

  const book = async (hourUtc: number, email: string) =>
    createBooking({
      businessId: fixture.business.id,
      serviceId: fixture.service.id,
      staffProfileId: fixture.staffProfile.id,
      locationId: null,
      startsAt: nextWeekdayAt(hourUtc),
      timezone: 'Asia/Kolkata',
      customer: { firstName: 'Priya', lastName: 'Shah', email },
      source: 'PUBLIC',
      actor: { type: 'CUSTOMER', label: email },
    });

  // Confirmation, reminders, follow-up, welcome, staff-assigned, owner-notified.
  const confirmed = await book(9, 'drift-confirm@meetflow.test');

  // `OWNER_NEW_BOOKING` is deliberately skipped when the owner *is* the
  // provider — in a single-practitioner workspace they have already been told
  // as the staff member, and two emails about one appointment is how a business
  // learns to filter both. The fixture is exactly that shape, so a second
  // provider is what makes the message reachable at all.
  const colleague = await createUser({ email: 'drift-colleague@meetflow.test' });
  const colleagueMembership = await Membership.create({
    businessId: fixture.business.id,
    userId: colleague.id,
    roleId: (await Role.findOne({
      where: { businessId: fixture.business.id, key: 'STAFF' },
    }))!.id,
    status: 'ACTIVE',
  });
  const colleagueProfile = await StaffProfile.create({
    businessId: fixture.business.id,
    membershipId: colleagueMembership.id,
    userId: colleague.id,
    displayName: 'Dr Anjali Rao',
    title: null,
    bio: null,
    avatarUrl: null,
    // UTC, matching the fixture workspace. A provider in another zone would
    // have their 9-to-5 rule land somewhere else entirely on the UTC clock the
    // helpers book against, which is a real behaviour and the wrong thing to
    // test incidentally here.
    timezone: 'UTC',
    defaultLocationId: null,
    isBookable: true,
    preBufferMinutes: null,
    postBufferMinutes: null,
    minNoticeMinutes: null,
    maxDailyAppointments: null,
    maxWeeklyAppointments: null,
    lastAssignedAt: null,
    deletedAt: null,
  });
  await ServiceStaff.create({
    serviceId: fixture.service.id,
    staffProfileId: colleagueProfile.id,
    isActive: true,
  });
  // The same 9-to-5 the fixture gives the owner, so the two providers are
  // interchangeable as far as the scheduling engine is concerned.
  await StaffAvailabilityRule.bulkCreate(
    [1, 2, 3, 4, 5].map((dayOfWeek) => ({
      businessId: fixture.business.id,
      staffProfileId: colleagueProfile.id,
      locationId: null,
      dayOfWeek,
      startMinute: 9 * 60,
      endMinute: 17 * 60,
      effectiveFrom: null,
      effectiveTo: null,
    })),
  );

  await createBooking({
    businessId: fixture.business.id,
    serviceId: fixture.service.id,
    staffProfileId: colleagueProfile.id,
    locationId: null,
    startsAt: nextWeekdayAt(16),
    timezone: 'Asia/Kolkata',
    customer: { firstName: 'Owner', lastName: 'Told', email: 'drift-owner@meetflow.test' },
    source: 'PUBLIC',
    actor: { type: 'CUSTOMER', label: 'drift-owner@meetflow.test' },
  });

  // Cancellation, with a reason — so `{{reason}}` is exercised as filled rather
  // than only as present-and-empty.
  const toCancel = await book(10, 'drift-cancel@meetflow.test');
  await cancelAppointment({
    businessId: fixture.business.id,
    appointmentId: toCancel.appointment.id,
    actor: actor(),
    reason: 'The provider is unwell.',
  });

  // Reschedule, which is the only producer of `previousStartsAtLocal` and also
  // re-queues reminders through the second of the two payload builders.
  await rescheduleAppointment({
    businessId: fixture.business.id,
    appointmentId: confirmed.appointment.id,
    newStartsAt: nextWeekdayAt(14),
    actor: actor(),
    reason: 'Moved at the customer’s request.',
  });

  // No-show. The transition refuses an appointment whose start time has not
  // passed by 15 minutes, and that guard is correct — so the row is moved into
  // the past directly rather than the guard being loosened for a test. A
  // booking cannot be *made* in the past either, hence booking it forward first.
  const toMiss = await book(11, 'drift-noshow@meetflow.test');
  //
  // The buffer columns move with it: `appointments_buffer_check` requires
  // `buffer_start_at <= starts_at` and `buffer_end_at >= ends_at`, so shifting
  // only the appointment window would leave the row failing its own constraint.
  const missedStart = new Date(Date.now() - 2 * 3_600_000);
  const missedEnd = new Date(missedStart.getTime() + 30 * 60_000);
  await Appointment.update(
    {
      startsAt: missedStart,
      endsAt: missedEnd,
      bufferStartAt: missedStart,
      bufferEndAt: missedEnd,
    },
    { where: { id: toMiss.appointment.id } },
  );
  await markNoShow({
    businessId: fixture.business.id,
    appointmentId: toMiss.appointment.id,
    actor: actor(),
  });

  // Approval and rejection both need a PENDING appointment, which is what a
  // workspace requiring approval produces.
  await BusinessSettings.update(
    { requireApproval: true },
    { where: { businessId: fixture.business.id } },
  );

  const toApprove = await book(12, 'drift-approve@meetflow.test');
  await approveAppointment({
    businessId: fixture.business.id,
    appointmentId: toApprove.appointment.id,
    actor: actor(),
  });

  const toReject = await book(13, 'drift-reject@meetflow.test');
  await rejectAppointment({
    businessId: fixture.business.id,
    appointmentId: toReject.appointment.id,
    actor: actor(),
    reason: 'Fully booked that week.',
  });

  // Waitlist, both messages. The confirmation comes from joining; the offer
  // comes from the matcher, which only runs when a slot the entry wants is
  // actually freed — so an appointment is booked inside the entry's window and
  // then cancelled.
  const waitedFor = nextWeekdayAt(15);
  const contested = await book(15, 'drift-contested@meetflow.test');
  const waitedDate = waitedFor.toISOString().slice(0, 10);

  await createWaitlistEntry(
    fixture.business.id,
    createWaitlistEntrySchema.parse({
      customerId: fixture.customer.id,
      serviceId: fixture.service.id,
      staffProfileId: fixture.staffProfile.id,
      earliestDate: waitedDate,
      latestDate: waitedDate,
      timezone: 'UTC',
    }),
    { type: 'CUSTOMER', customerId: fixture.customer.id, email: fixture.customer.email },
    { requestId: 'drift', ipAddress: null, userAgent: null },
  );

  await cancelAppointment({
    businessId: fixture.business.id,
    appointmentId: contested.appointment.id,
    actor: actor(),
    reason: 'Freeing the slot the waitlist wants.',
  });

  // The offer is fired without being awaited — deliberately, so a waitlist
  // problem cannot turn a completed cancellation into an error the customer
  // sees. Polling rather than sleeping, for the same reason `waitlistFreedSlot`
  // does: a sleep long enough to be reliable under load is tedious when idle.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await Notification.count({ where: { type: 'WAITLIST_SLOT_AVAILABLE' } })) > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await drainOutbox();
}, 180_000);

afterAll(async () => {
  await closeDatabaseConnection();
});

/** Template keys with at least one producer, i.e. everything this must cover. */
const producedKeys = [...new Set(DEFAULT_TEMPLATES.map((item) => item.key))].filter(
  (key) => !TEMPLATE_KEYS_WITHOUT_PRODUCERS.includes(key),
) as NotificationTemplateKey[];

describe('every catalogued placeholder is really sent', () => {
  it.each(producedKeys)('%s', (key) => {
    const payloads = payloadsByType.get(key);

    // A key with no payload at all is the louder failure of the two: it means
    // a message MeetFlow defines is one nothing ever queues, which is the state
    // `OWNER_DAILY_DIGEST` is in and is disclosed for.
    expect(
      payloads,
      `no ${key} notification was produced — either a producer regressed, or the ` +
        `key belongs in TEMPLATE_KEYS_WITHOUT_PRODUCERS with a disclosure to match`,
    ).toBeDefined();
    expect(payloads!.length).toBeGreaterThan(0);

    for (const payload of payloads!) {
      const missing = TEMPLATE_PLACEHOLDERS[key].filter(
        (name) => !Object.prototype.hasOwnProperty.call(payload, name),
      );
      expect(
        missing,
        `${key} promises ${missing.join(', ')} but its producer does not send it, so an ` +
          `operator writing {{${missing[0] ?? ''}}} would get empty text`,
      ).toEqual([]);
    }
  });
});

describe('the built-in defaults stay inside their own catalogue', () => {
  // The defaults and the catalogue are two hand-maintained lists describing one
  // thing. This is the cheap half of keeping them honest: a default that uses a
  // placeholder the catalogue does not list would render empty for everybody,
  // and would also be a template no operator could re-save unchanged.
  it.each(DEFAULT_TEMPLATES.map((item) => [item.key, item.channel, item] as const))(
    '%s/%s',
    (key, _channel, template) => {
      const allowed = new Set<string>(TEMPLATE_PLACEHOLDERS[key]);
      const used = [
        ...`${template.subject}\n${template.bodyText}`.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g),
      ].map((match) => match[1]!);

      expect(used.filter((name) => !allowed.has(name))).toEqual([]);
    },
  );
});
