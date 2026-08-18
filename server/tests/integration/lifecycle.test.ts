/**
 * Appointment lifecycle against real PostgreSQL.
 *
 * The interesting assertions are not "the status changed" but the side effects
 * that make the status meaningful: the old slot becomes bookable again, the new
 * one becomes blocked, pending reminders stop, and history is appended rather
 * than overwritten.
 */
import { Op } from 'sequelize';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Appointment,
  AppointmentParticipant,
  AppointmentStaff,
  AppointmentStatusHistory,
  BusinessSettings,
  Customer,
  Notification,
  RescheduleHistory,
} from '../../src/database/models';
import { createBooking } from '../../src/modules/appointments/booking.service';
import {
  cancelAppointment,
  checkInAppointment,
  completeAppointment,
  markNoShow,
  rescheduleAppointment,
} from '../../src/modules/appointments/lifecycle.service';
import { ErrorCode } from '../../src/utils/errors';
import {
  closeDatabaseConnection,
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

afterAll(async () => {
  await closeDatabaseConnection();
});

async function book(startsAt: Date, email = 'lifecycle@meetflow.test') {
  return createBooking({
    businessId: fixture.business.id,
    serviceId: fixture.service.id,
    staffProfileId: fixture.staffProfile.id,
    locationId: null,
    startsAt,
    timezone: 'UTC',
    customer: { firstName: 'Life', lastName: 'Cycle', email },
    source: 'PUBLIC',
    actor: { type: 'CUSTOMER', label: email },
  });
}

describe('reschedule', () => {
  it('moves the appointment and its reservation, freeing the original slot', async () => {
    const original = nextWeekdayAt(10);
    const moved = nextWeekdayAt(11);
    const { appointment } = await book(original);

    const updated = await rescheduleAppointment({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      newStartsAt: moved,
      reason: 'Customer request',
      actor,
    });

    expect(updated.startsAt.toISOString()).toBe(moved.toISOString());
    expect(updated.status).toBe('RESCHEDULED');
    expect(updated.rescheduleCount).toBe(1);
    // Identity is preserved so the customer's management link keeps working.
    expect(updated.publicId).toBe(appointment.publicId);

    const reservations = await AppointmentStaff.findAll({
      where: { appointmentId: appointment.id, isBlocking: true },
    });
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!.startsAt.toISOString()).toBe(moved.toISOString());

    // The vacated time is bookable again.
    await expect(book(original, 'someone-else@meetflow.test')).resolves.toBeTruthy();
  });

  it('records the move in reschedule history rather than overwriting it', async () => {
    const original = nextWeekdayAt(10);
    const { appointment } = await book(original);

    await rescheduleAppointment({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      newStartsAt: nextWeekdayAt(11),
      actor,
    });

    const history = await RescheduleHistory.findAll({ where: { appointmentId: appointment.id } });
    expect(history).toHaveLength(1);
    expect(history[0]!.previousStartsAt.toISOString()).toBe(original.toISOString());

    const statusHistory = await AppointmentStatusHistory.findAll({
      where: { appointmentId: appointment.id },
      order: [['createdAt', 'ASC']],
    });
    // One row for the booking, one for the move.
    expect(statusHistory.length).toBeGreaterThanOrEqual(2);
    expect(statusHistory.at(-1)!.toStatus).toBe('RESCHEDULED');
  });

  it('refuses a move onto a time that is already taken', async () => {
    const first = nextWeekdayAt(10);
    const second = nextWeekdayAt(11);
    const { appointment } = await book(first);
    await book(second, 'other@meetflow.test');

    await expect(
      rescheduleAppointment({
        businessId: fixture.business.id,
        appointmentId: appointment.id,
        newStartsAt: second,
        actor,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.SLOT_UNAVAILABLE });
  });

  it('enforces the customer reschedule deadline, but not for staff', async () => {
    const { appointment } = await book(nextWeekdayAt(10));

    // Deadline far larger than the lead time, so a customer move is refused.
    await BusinessSettings.update(
      { rescheduleDeadlineMinutes: 60 * 24 * 365 },
      { where: { businessId: fixture.business.id } },
    );

    await expect(
      rescheduleAppointment({
        businessId: fixture.business.id,
        appointmentId: appointment.id,
        newStartsAt: nextWeekdayAt(11),
        actor: { type: 'CUSTOMER' },
        enforceCustomerPolicy: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.POLICY_VIOLATION });

    // The business itself is not bound by the customer-facing deadline.
    await expect(
      rescheduleAppointment({
        businessId: fixture.business.id,
        appointmentId: appointment.id,
        newStartsAt: nextWeekdayAt(11),
        actor,
      }),
    ).resolves.toBeTruthy();
  });

  it('refuses once the reschedule limit is reached', async () => {
    await BusinessSettings.update(
      { maxReschedulesPerAppointment: 1 },
      { where: { businessId: fixture.business.id } },
    );
    const { appointment } = await book(nextWeekdayAt(10));

    await rescheduleAppointment({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      newStartsAt: nextWeekdayAt(11),
      actor,
    });

    await expect(
      rescheduleAppointment({
        businessId: fixture.business.id,
        appointmentId: appointment.id,
        newStartsAt: nextWeekdayAt(12),
        actor,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.POLICY_VIOLATION });
  });

  it('rejects a cross-tenant appointment id', async () => {
    const other = await createWorkspace();
    const { appointment } = await book(nextWeekdayAt(10));

    await expect(
      rescheduleAppointment({
        businessId: other.business.id,
        appointmentId: appointment.id,
        newStartsAt: nextWeekdayAt(11),
        actor,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('cancel', () => {
  it('releases the slot and stops pending reminders', async () => {
    const startsAt = nextWeekdayAt(10);
    const { appointment } = await book(startsAt);

    const remindersBefore = await Notification.count({
      where: { appointmentId: appointment.id, type: 'APPOINTMENT_REMINDER', status: 'PENDING' },
    });
    expect(remindersBefore).toBeGreaterThan(0);

    const cancelled = await cancelAppointment({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      reason: 'Customer could not attend',
      actor,
    });

    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancellationReason).toBe('Customer could not attend');

    // Reservation released but retained for audit.
    const reservations = await AppointmentStaff.findAll({
      where: { appointmentId: appointment.id },
    });
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!.isBlocking).toBe(false);

    const remindersAfter = await Notification.count({
      where: { appointmentId: appointment.id, type: 'APPOINTMENT_REMINDER', status: 'PENDING' },
    });
    expect(remindersAfter).toBe(0);

    // The slot is bookable again.
    await expect(book(startsAt, 'next@meetflow.test')).resolves.toBeTruthy();
  });

  it('increments the customer cancellation counter', async () => {
    const { appointment, customer } = await book(nextWeekdayAt(10));
    await cancelAppointment({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      actor,
    });
    const refreshed = await Customer.findByPk(customer.id);
    expect(refreshed!.cancelledCount).toBe(1);
  });

  it('refuses to cancel an already-cancelled appointment', async () => {
    const { appointment } = await book(nextWeekdayAt(10));
    await cancelAppointment({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      actor,
    });

    await expect(
      cancelAppointment({ businessId: fixture.business.id, appointmentId: appointment.id, actor }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE_TRANSITION });
  });

  it('cancels one attendee without ending the whole group session', async () => {
    const group = await createWorkspace({ serviceCapacity: 5, serviceDurationMinutes: 60 });
    const startsAt = nextWeekdayAt(10);

    const makeBooking = (email: string) =>
      createBooking({
        businessId: group.business.id,
        serviceId: group.service.id,
        staffProfileId: group.staffProfile.id,
        locationId: null,
        startsAt,
        timezone: 'UTC',
        customer: { firstName: 'A', lastName: 'B', email },
        source: 'PUBLIC',
        actor: { type: 'CUSTOMER', label: email },
      });

    const first = await makeBooking('a@meetflow.test');
    await makeBooking('b@meetflow.test');

    const stillRunning = await cancelAppointment({
      businessId: group.business.id,
      appointmentId: first.appointment.id,
      participantId: first.participant.id,
      actor: { type: 'CUSTOMER' },
    });

    expect(stillRunning.status).not.toBe('CANCELLED');
    expect(stillRunning.bookedCount).toBe(1);

    const participants = await AppointmentParticipant.findAll({
      where: { appointmentId: first.appointment.id, status: { [Op.ne]: 'CANCELLED' } },
    });
    expect(participants).toHaveLength(1);
  });
});

describe('completion and no-show', () => {
  it('completes an appointment and counts it for the customer', async () => {
    const { appointment, customer } = await book(nextWeekdayAt(10));

    const completed = await completeAppointment({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      actor,
    });
    expect(completed.status).toBe('COMPLETED');
    expect(completed.completedAt).toBeInstanceOf(Date);

    const refreshed = await Customer.findByPk(customer.id);
    expect(refreshed!.completedCount).toBe(1);

    const participants = await AppointmentParticipant.findAll({
      where: { appointmentId: appointment.id },
    });
    expect(participants[0]!.status).toBe('ATTENDED');

    // A completed appointment releases the calendar.
    const reservation = await AppointmentStaff.findOne({
      where: { appointmentId: appointment.id },
    });
    expect(reservation!.isBlocking).toBe(false);
  });

  it('refuses a no-show before the grace period has elapsed', async () => {
    // A future appointment cannot possibly be a no-show yet.
    const { appointment } = await book(nextWeekdayAt(10));

    await expect(
      markNoShow({ businessId: fixture.business.id, appointmentId: appointment.id, actor }),
    ).rejects.toMatchObject({ code: ErrorCode.POLICY_VIOLATION });
  });

  it('allows a no-show once the grace period has passed', async () => {
    const { appointment, customer } = await book(nextWeekdayAt(10));

    // Move the appointment into the past to simulate elapsed time, and drop the
    // grace period to zero. The buffer columns must move with it — the
    // `appointments_buffer_check` constraint enforces that they always bracket
    // the appointment window.
    const past = new Date(Date.now() - 60 * 60_000);
    const pastEnd = new Date(past.getTime() + 30 * 60_000);
    await Appointment.update(
      { startsAt: past, endsAt: pastEnd, bufferStartAt: past, bufferEndAt: pastEnd },
      { where: { id: appointment.id } },
    );
    await BusinessSettings.update(
      { noShowGraceMinutes: 0 },
      { where: { businessId: fixture.business.id } },
    );

    const marked = await markNoShow({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      actor,
    });
    expect(marked.status).toBe('NO_SHOW');

    const refreshed = await Customer.findByPk(customer.id);
    expect(refreshed!.noShowCount).toBe(1);
  });

  it('records a check-in without changing the status', async () => {
    const { appointment } = await book(nextWeekdayAt(10));
    const checked = await checkInAppointment({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      actor,
    });
    expect(checked.checkedInAt).toBeInstanceOf(Date);
    expect(checked.status).toBe('CONFIRMED');
  });

  it('refuses an illegal transition out of a terminal state', async () => {
    const { appointment } = await book(nextWeekdayAt(10));
    await completeAppointment({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      actor,
    });

    await expect(
      cancelAppointment({ businessId: fixture.business.id, appointmentId: appointment.id, actor }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE_TRANSITION });
  });
});
