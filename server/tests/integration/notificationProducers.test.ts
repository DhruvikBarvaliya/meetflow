/**
 * The producers behind the built-in templates, against real PostgreSQL.
 *
 * This file exists because six of the sixteen shipped templates had none. A
 * template with no producer is the same species of defect as a documented
 * endpoint nobody mounted: the feature reads as present everywhere except in
 * the one place that decides whether it happens.
 *
 * Two things are asserted throughout, and the second is the one that matters:
 *
 *  1. the row is written at all, to the right recipient, with the dedupe key
 *     that makes a retry harmless;
 *  2. the row is written **inside the transaction of the change that caused
 *     it**. That is the whole promise of the outbox, and it cannot be observed
 *     from the outside by looking at a committed database — both orderings look
 *     identical afterwards. So it is observed the other way round: a trigger
 *     makes the INSERT fail, and if the two really do share a transaction the
 *     business change has to disappear with the message. An enqueue that ran
 *     after the commit would leave the appointment behind and fail the
 *     assertion.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sequelize } from '../../src/config/database';
import {
  Appointment,
  BusinessSettings,
  Membership,
  Notification,
  Role,
  ServiceStaff,
  StaffAvailabilityRule,
  StaffProfile,
} from '../../src/database/models';
import { sendOwnerDailyDigests } from '../../src/jobs/processors/digest.processor';
import {
  FOLLOW_UP_DELAY_MINUTES,
  createBooking,
} from '../../src/modules/appointments/booking.service';
import {
  markNoShow,
  rescheduleAppointment,
} from '../../src/modules/appointments/lifecycle.service';
import { newAppointmentPublicId } from '../../src/utils/ids';
import {
  closeDatabaseConnection,
  createUser,
  createWorkspace,
  nextWeekdayAt,
  resetDatabase,
  type WorkspaceFixture,
} from '../helpers/fixtures';

let fixture: WorkspaceFixture;
const actor = { type: 'OWNER' as const, label: 'owner@meetflow.test' };

beforeEach(async () => {
  await resetDatabase();
  fixture = await createWorkspace();
});

afterEach(async () => {
  await unpoisonOutbox();
});

afterAll(async () => {
  await closeDatabaseConnection();
});

/**
 * A second bookable provider, with their own login.
 *
 * The fixture owner is also the fixture provider, which is exactly the case
 * that must *not* produce an owner notification — so anything about the owner
 * being told needs somebody else to be running the appointment.
 */
async function addProvider(displayName: string): Promise<StaffProfile> {
  const user = await createUser();
  const role = await Role.findOne({ where: { businessId: fixture.business.id } });
  if (!role) throw new Error('fixture expected the workspace to have system roles');

  const membership = await Membership.create({
    userId: user.id,
    businessId: fixture.business.id,
    roleId: role.id,
    status: 'ACTIVE',
    invitedByUserId: null,
    invitedAt: null,
    joinedAt: new Date(),
  });

  const profile = await StaffProfile.create({
    businessId: fixture.business.id,
    userId: user.id,
    membershipId: membership.id,
    displayName,
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

  return profile;
}

async function book(startsAt: Date, staffProfileId: string, email = 'producer@meetflow.test') {
  return createBooking({
    businessId: fixture.business.id,
    serviceId: fixture.service.id,
    staffProfileId,
    locationId: null,
    startsAt,
    timezone: 'UTC',
    customer: { firstName: 'Ada', lastName: 'Customer', email },
    source: 'PUBLIC',
    actor: { type: 'CUSTOMER', label: email },
  });
}

/** Every outbox row of one type for the fixture workspace. */
async function queued(type: string): Promise<Notification[]> {
  return Notification.findAll({
    where: { businessId: fixture.business.id, type },
    order: [['createdAt', 'ASC']],
  });
}

const POISON_TRIGGER = 'meetflow_test_reject_notification';

/**
 * Makes every INSERT of one notification type fail, in whatever transaction
 * attempts it.
 *
 * A trigger rather than a mock because the point is the *database* transaction:
 * a stub would prove that a function was called and nothing at all about which
 * transaction the row belonged to.
 */
async function poisonOutbox(type: string): Promise<void> {
  await sequelize.query(`
    CREATE OR REPLACE FUNCTION ${POISON_TRIGGER}() RETURNS trigger AS $fn$
    BEGIN
      RAISE EXCEPTION 'poisoned outbox insert for %', NEW.type;
    END;
    $fn$ LANGUAGE plpgsql;
  `);
  await sequelize.query(`
    CREATE TRIGGER ${POISON_TRIGGER}
    BEFORE INSERT ON notifications
    FOR EACH ROW WHEN (NEW.type = '${type}')
    EXECUTE FUNCTION ${POISON_TRIGGER}();
  `);
}

/** Always runs, so a failed assertion cannot leave the outbox poisoned. */
async function unpoisonOutbox(): Promise<void> {
  await sequelize.query(`DROP TRIGGER IF EXISTS ${POISON_TRIGGER} ON notifications;`);
  await sequelize.query(`DROP FUNCTION IF EXISTS ${POISON_TRIGGER}();`);
}

describe('booking producers', () => {
  it('tells the owner about a booking taken by somebody else', async () => {
    const provider = await addProvider('Dr Locum');

    const { appointment, customer } = await book(nextWeekdayAt(10), provider.id);

    const rows = await queued('OWNER_NEW_BOOKING');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipientType).toBe('OWNER');
    expect(rows[0]!.recipientUserId).toBe(fixture.user.id);
    expect(rows[0]!.recipientAddress).toBe(fixture.user.email);
    expect(rows[0]!.appointmentId).toBe(appointment.id);
    expect(rows[0]!.dedupeKey).toBe(`owner-new-booking:${appointment.id}:${customer.id}`);
    // Rendered at enqueue time from the real template, so a broken placeholder
    // is a failure here rather than a puzzling email later.
    expect(rows[0]!.subject).toContain('New booking');
    expect(rows[0]!.body).toContain('Dr Locum');
  });

  it('does not tell the owner twice when the owner is the provider', async () => {
    await book(nextWeekdayAt(10), fixture.staffProfile.id);

    // They have already been written to as the staff member; a second message
    // about the same appointment is how a business learns to filter both.
    expect(await queued('OWNER_NEW_BOOKING')).toHaveLength(0);
    expect(await queued('STAFF_ASSIGNED')).toHaveLength(1);
  });

  it('welcomes a customer once, on their first booking only', async () => {
    const { customer } = await book(nextWeekdayAt(10), fixture.staffProfile.id);

    const welcome = await queued('CUSTOMER_WELCOME');
    expect(welcome).toHaveLength(1);
    expect(welcome[0]!.recipientCustomerId).toBe(customer.id);
    expect(welcome[0]!.dedupeKey).toBe(`welcome:${customer.id}`);

    // The same person books again: a second confirmation, no second welcome.
    await book(nextWeekdayAt(14), fixture.staffProfile.id);
    expect(await queued('CUSTOMER_WELCOME')).toHaveLength(1);
    expect(await queued('BOOKING_CONFIRMATION')).toHaveLength(2);
  });

  it('queues the follow-up for after the appointment, not for now', async () => {
    const { appointment, customer } = await book(nextWeekdayAt(10), fixture.staffProfile.id);

    const followUps = await queued('APPOINTMENT_FOLLOW_UP');
    expect(followUps).toHaveLength(1);
    expect(followUps[0]!.dedupeKey).toBe(`follow-up:${appointment.id}:${customer.id}`);
    expect(followUps[0]!.scheduledFor.getTime()).toBe(
      appointment.endsAt.getTime() + FOLLOW_UP_DELAY_MINUTES * 60_000,
    );
  });

  it('keeps the owner notification in the booking transaction', async () => {
    const provider = await addProvider('Dr Locum');
    await poisonOutbox('OWNER_NEW_BOOKING');

    await expect(book(nextWeekdayAt(10), provider.id)).rejects.toThrow();

    // If the message were enqueued after the commit, the appointment would have
    // survived its failure. It must not have been created at all.
    expect(await Appointment.count({ where: { businessId: fixture.business.id } })).toBe(0);
    expect(await Notification.count({ where: { businessId: fixture.business.id } })).toBe(0);
  });
});

describe('no-show producer', () => {
  /**
   * A booking that has already been and gone.
   *
   * The appointment is moved into the past rather than booked there — booking
   * in the past is refused, which is correct — and the grace period is dropped
   * to zero. The buffer columns move with it because `appointments_buffer_check`
   * requires them to bracket the window.
   */
  async function bookAndLetItPass() {
    const result = await book(nextWeekdayAt(10), fixture.staffProfile.id);
    const past = new Date(Date.now() - 60 * 60_000);
    const pastEnd = new Date(past.getTime() + 30 * 60_000);
    await Appointment.update(
      { startsAt: past, endsAt: pastEnd, bufferStartAt: past, bufferEndAt: pastEnd },
      { where: { id: result.appointment.id } },
    );
    await BusinessSettings.update(
      { noShowGraceMinutes: 0 },
      { where: { businessId: fixture.business.id } },
    );
    return result;
  }

  it('writes to the customer who did not arrive', async () => {
    const { appointment, customer } = await bookAndLetItPass();

    await markNoShow({ businessId: fixture.business.id, appointmentId: appointment.id, actor });

    const rows = await queued('APPOINTMENT_NO_SHOW');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipientCustomerId).toBe(customer.id);
    expect(rows[0]!.recipientAddress).toBe(customer.email);
    expect(rows[0]!.dedupeKey).toBe(`no-show:${appointment.id}:${customer.id}`);
    expect(rows[0]!.body).toContain('We had you booked');
  });

  it('withdraws the reminder and the follow-up it replaces', async () => {
    const { appointment } = await bookAndLetItPass();

    await markNoShow({ businessId: fixture.business.id, appointmentId: appointment.id, actor });

    const followUps = await queued('APPOINTMENT_FOLLOW_UP');
    expect(followUps).toHaveLength(1);
    // Nobody is thanked for a visit they did not make.
    expect(followUps[0]!.status).toBe('CANCELLED');
    for (const reminder of await queued('APPOINTMENT_REMINDER')) {
      expect(reminder.status).toBe('CANCELLED');
    }
  });

  it('keeps the message in the transaction that marked the absence', async () => {
    const { appointment } = await bookAndLetItPass();
    await poisonOutbox('APPOINTMENT_NO_SHOW');

    await expect(
      markNoShow({ businessId: fixture.business.id, appointmentId: appointment.id, actor }),
    ).rejects.toThrow();

    // The marking is what the message describes, so it has to roll back too —
    // a customer's no-show count is not a thing to change and then fail to
    // mention.
    const refreshed = await Appointment.findByPk(appointment.id);
    expect(refreshed!.status).toBe('CONFIRMED');
    expect(refreshed!.noShowAt).toBeNull();
  });
});

describe('reschedule producer', () => {
  it('tells both providers when an appointment changes hands', async () => {
    const provider = await addProvider('Dr Locum');
    const { appointment } = await book(nextWeekdayAt(10), fixture.staffProfile.id);

    await rescheduleAppointment({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      newStartsAt: nextWeekdayAt(14),
      newStaffProfileId: provider.id,
      actor,
    });

    const rows = await queued('STAFF_SCHEDULE_CHANGED');
    expect(rows).toHaveLength(2);

    const arriving = rows.find((row) => row.recipientUserId === provider.userId);
    const leaving = rows.find((row) => row.recipientUserId === fixture.user.id);
    expect(arriving?.body).toContain('Assigned to you');
    expect(leaving?.body).toContain('Reassigned to another provider');
    expect(arriving?.dedupeKey).toBe(`schedule-changed:${appointment.id}:${provider.id}:r1`);
  });

  it('re-queues the follow-up the move withdrew', async () => {
    const { appointment } = await book(nextWeekdayAt(10), fixture.staffProfile.id);
    const moved = await rescheduleAppointment({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      newStartsAt: nextWeekdayAt(14),
      actor,
    });

    const followUps = await queued('APPOINTMENT_FOLLOW_UP');
    expect(followUps).toHaveLength(2);
    expect(followUps[0]!.status).toBe('CANCELLED');
    expect(followUps[1]!.status).toBe('PENDING');
    expect(followUps[1]!.scheduledFor.getTime()).toBe(
      moved.endsAt.getTime() + FOLLOW_UP_DELAY_MINUTES * 60_000,
    );
  });
});

describe('owner daily digest', () => {
  /**
   * A workspace whose local clock reads 07:00 right now.
   *
   * The digest job asks PostgreSQL which workspaces are currently in their
   * digest hour, so the test cannot choose the time — it chooses the zone
   * instead. `Etc/GMT±n` zones have whole-hour offsets and no daylight saving,
   * which makes "07:00 there" exact whatever hour the suite runs at. Note the
   * POSIX sign convention: `Etc/GMT+5` is five hours *behind* UTC.
   */
  function zoneWhereItIsSevenAM(): string {
    const utcHour = new Date().getUTCHours();
    let offset = (7 - utcHour) % 24;
    if (offset > 12) offset -= 24;
    if (offset < -11) offset += 24;
    if (offset === 0) return 'UTC';
    return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
  }

  /**
   * One appointment in the workspace's local day, written directly.
   *
   * The digest reads the diary; how a row got into it is not what is under
   * test, and driving the booking path here would mean finding a workspace
   * whose local 09:00 is both in the future and on a weekday, on whatever day
   * the suite happens to run.
   */
  async function appointmentLaterToday(workspace: WorkspaceFixture): Promise<Appointment> {
    const startsAt = new Date(Date.now() + 2 * 60 * 60_000);
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    return Appointment.create({
      publicId: newAppointmentPublicId(),
      businessId: workspace.business.id,
      serviceId: workspace.service.id,
      locationId: null,
      staffProfileId: workspace.staffProfile.id,
      teamId: null,
      customerId: workspace.customer.id,
      bookingLinkId: null,
      status: 'CONFIRMED',
      startsAt,
      endsAt,
      bufferStartAt: startsAt,
      bufferEndAt: endsAt,
      durationMinutes: 30,
      preBufferMinutes: 0,
      postBufferMinutes: 0,
      timezone: workspace.business.timezone,
      capacity: 1,
      bookedCount: 1,
      priceAmount: 5000,
      currency: 'USD',
      source: 'STAFF',
      title: 'Consultation',
      customerNotes: null,
      internalNotes: null,
      answers: {},
      requiresApproval: false,
      confirmedAt: new Date(),
      cancellationReason: null,
      cancelledByType: null,
      cancelledByUserId: null,
      rescheduledFromId: null,
      idempotencyKey: null,
      createdByUserId: null,
      checkedInAt: null,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      noShowAt: null,
    });
  }

  it('queues one digest per workspace in its digest hour, and only one', async () => {
    const workspace = await createWorkspace({ timezone: zoneWhereItIsSevenAM() });
    await appointmentLaterToday(workspace);

    expect(await sendOwnerDailyDigests()).toBeGreaterThanOrEqual(1);

    const rows = await Notification.findAll({
      where: { businessId: workspace.business.id, type: 'OWNER_DAILY_DIGEST' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipientUserId).toBe(workspace.user.id);
    expect(rows[0]!.payload.appointmentCount).toBe(1);
    expect(rows[0]!.subject).toContain('1 appointments');

    // The hourly job overlapping its own hour, or a worker restarting, must not
    // produce a second one: the dedupe key is what makes that true.
    await sendOwnerDailyDigests();
    expect(
      await Notification.count({
        where: { businessId: workspace.business.id, type: 'OWNER_DAILY_DIGEST' },
      }),
    ).toBe(1);
  });

  it('says nothing to a workspace with an empty day', async () => {
    const workspace = await createWorkspace({ timezone: zoneWhereItIsSevenAM() });

    await sendOwnerDailyDigests();

    expect(
      await Notification.count({
        where: { businessId: workspace.business.id, type: 'OWNER_DAILY_DIGEST' },
      }),
    ).toBe(0);
  });

  it('says nothing to a workspace whose morning is not now', async () => {
    // 07:00 somewhere else entirely: twelve hours from the digest hour.
    const utcHour = new Date().getUTCHours();
    let offset = (19 - utcHour) % 24;
    if (offset > 12) offset -= 24;
    if (offset < -11) offset += 24;
    const zone = offset === 0 ? 'UTC' : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;

    const workspace = await createWorkspace({ timezone: zone });
    await appointmentLaterToday(workspace);

    await sendOwnerDailyDigests();

    expect(
      await Notification.count({
        where: { businessId: workspace.business.id, type: 'OWNER_DAILY_DIGEST' },
      }),
    ).toBe(0);
  });
});
