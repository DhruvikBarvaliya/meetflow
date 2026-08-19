/**
 * Evidence for the two lifecycle movements that used to leave none.
 *
 * Delete these and MeetFlow silently loses the record of arrival and start.
 * Check-in writes `checked_in_at` and the IN_PROGRESS sweep writes a status —
 * both used to do it with a bare `update()`, so neither appeared in
 * `appointment_status_history` or `audit_logs`. A workspace disputing "they
 * never turned up" against "they were here at 10:05", or asked when a visit
 * actually began, would have had a column with one value in it and nothing to
 * say who put it there or when. These tests fail the moment either path stops
 * being audited, or the sweep goes back to updating rows behind the state
 * machine's back.
 */
import { Op } from 'sequelize';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Appointment, AppointmentStatusHistory, AuditLog } from '../../src/database/models';
import { advanceInProgress } from '../../src/jobs/processors/maintenance.processor';
import { createBooking } from '../../src/modules/appointments/booking.service';
import {
  cancelAppointment,
  checkInAppointment,
} from '../../src/modules/appointments/lifecycle.service';
import { AuditActions } from '../../src/modules/audit/audit.service';
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

async function book(startsAt: Date): Promise<Appointment> {
  const result = await createBooking({
    businessId: fixture.business.id,
    serviceId: fixture.service.id,
    staffProfileId: fixture.staffProfile.id,
    locationId: null,
    startsAt,
    timezone: 'UTC',
    customer: {
      firstName: 'Ada',
      lastName: 'Customer',
      email: 'evidence@meetflow.test',
    },
    source: 'PUBLIC',
    actor: { type: 'CUSTOMER', label: 'evidence@meetflow.test' },
  });
  return result.appointment;
}

/**
 * The history rows that record an arrival, oldest first. Filtered in memory
 * rather than with a JSONB predicate so the assertions stay about the rows
 * being written, not about how a JSON path is queried.
 */
async function arrivalRows(appointmentId: string): Promise<AppointmentStatusHistory[]> {
  const rows = await AppointmentStatusHistory.findAll({
    where: { appointmentId },
    order: [['createdAt', 'ASC']],
  });
  return rows.filter((row) => row.metadata.event === 'checked_in');
}

/**
 * Drags an appointment onto the clock the sweep looks at: started, not yet
 * ended. The buffer columns move with it because `appointments_buffer_check`
 * insists they bracket the appointment window.
 */
async function makeCurrent(appointment: Appointment): Promise<void> {
  const startsAt = new Date(Date.now() - 10 * 60_000);
  const endsAt = new Date(Date.now() + 20 * 60_000);
  await Appointment.update(
    { startsAt, endsAt, bufferStartAt: startsAt, bufferEndAt: endsAt },
    { where: { id: appointment.id } },
  );
}

describe('check-in', () => {
  it('records arrival in the history and the audit trail', async () => {
    const appointment = await book(nextWeekdayAt(10));

    const checked = await checkInAppointment({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      actor,
      metadata: { requestId: 'req-check-in', ipAddress: '203.0.113.7', userAgent: null },
    });

    expect(checked.checkedInAt).toBeInstanceOf(Date);
    // Arrival is not a status change, and recording it must not become one:
    // the sweep is what promotes a checked-in appointment to IN_PROGRESS.
    expect(checked.status).toBe('CONFIRMED');

    const history = await AppointmentStatusHistory.findAll({
      where: { appointmentId: appointment.id },
      order: [['createdAt', 'ASC']],
    });
    const arrival = history.find((row) => row.metadata.event === 'checked_in');
    expect(arrival).toBeDefined();
    // From and to match on purpose: the appointment stood still while
    // something happened to it.
    expect(arrival!.fromStatus).toBe('CONFIRMED');
    expect(arrival!.toStatus).toBe('CONFIRMED');
    expect(arrival!.actorType).toBe('OWNER');

    const audit = await AuditLog.findOne({
      where: { entityId: appointment.id, action: AuditActions.APPOINTMENT_CHECKED_IN },
    });
    expect(audit).not.toBeNull();
    // The disputable part: who said so, from where, and in which request.
    expect(audit!.requestId).toBe('req-check-in');
    expect(audit!.ipAddress).toBe('203.0.113.7');
    expect(audit!.metadata.checkedInAt).toBeDefined();
  });

  it('keeps the arrival time it corrected when checked in twice', async () => {
    const appointment = await book(nextWeekdayAt(10));

    const first = await checkInAppointment({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      actor,
    });
    const firstArrival = first.checkedInAt!;

    const second = await checkInAppointment({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      actor,
      reason: 'Front desk corrected the arrival time.',
    });

    // The column carries the correction; the history still knows what it
    // replaced, which is the whole reason the row is written.
    expect(second.checkedInAt!.getTime()).toBeGreaterThanOrEqual(firstArrival.getTime());

    const arrivals = await arrivalRows(appointment.id);
    expect(arrivals).toHaveLength(2);
    expect(new Date(arrivals[1]!.metadata.previousCheckedInAt as string).getTime()).toBe(
      firstArrival.getTime(),
    );
  });

  it('refuses to record arrival for an appointment that is over', async () => {
    const appointment = await book(nextWeekdayAt(10));
    await cancelAppointment({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      actor,
    });

    await expect(
      checkInAppointment({
        businessId: fixture.business.id,
        appointmentId: appointment.id,
        actor,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE_TRANSITION });

    // And the refusal left nothing behind: no arrival, no row claiming one.
    const refreshed = await Appointment.findByPk(appointment.id);
    expect(refreshed!.checkedInAt).toBeNull();
    expect(await arrivalRows(appointment.id)).toHaveLength(0);
  });
});

describe('the IN_PROGRESS sweep', () => {
  it('audits the promotion it makes', async () => {
    const appointment = await book(nextWeekdayAt(10));
    await checkInAppointment({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      actor,
    });
    await makeCurrent(appointment);

    expect(await advanceInProgress()).toBe(1);

    const refreshed = await Appointment.findByPk(appointment.id);
    expect(refreshed!.status).toBe('IN_PROGRESS');
    expect(refreshed!.startedAt).toBeInstanceOf(Date);

    const promotion = await AppointmentStatusHistory.findOne({
      where: { appointmentId: appointment.id, toStatus: 'IN_PROGRESS' },
    });
    expect(promotion).not.toBeNull();
    expect(promotion!.fromStatus).toBe('CONFIRMED');
    // A job moved it, and the timeline has to say so rather than attribute the
    // move to whoever happens to be looking at the diary.
    expect(promotion!.actorType).toBe('SYSTEM');

    const audit = await AuditLog.findOne({
      where: { entityId: appointment.id, action: AuditActions.APPOINTMENT_STARTED },
    });
    expect(audit).not.toBeNull();
    expect(audit!.metadata).toMatchObject({ from: 'CONFIRMED', to: 'IN_PROGRESS' });
  });

  it('leaves an appointment nobody checked into alone', async () => {
    const appointment = await book(nextWeekdayAt(10));
    await makeCurrent(appointment);

    expect(await advanceInProgress()).toBe(0);

    const refreshed = await Appointment.findByPk(appointment.id);
    expect(refreshed!.status).toBe('CONFIRMED');
  });

  it('finishes the batch when one appointment cannot be advanced', async () => {
    const first = await book(nextWeekdayAt(10));
    const second = await book(nextWeekdayAt(11));

    for (const appointment of [first, second]) {
      await checkInAppointment({
        businessId: fixture.business.id,
        appointmentId: appointment.id,
        actor,
      });
      await makeCurrent(appointment);
    }

    // The state the batch selects and the state it writes are separated by real
    // time: a row can be cancelled, completed or moved in between, and its
    // transaction then fails. One such row must not cost every appointment
    // behind it in the batch its promotion, which is why the sweep catches per
    // appointment rather than around the loop.
    Appointment.addHook('beforeUpdate', 'evidence-fail-first', (instance: Appointment) => {
      if (instance.id === first.id) throw new Error('simulated write failure');
    });

    let advanced: number;
    try {
      advanced = await advanceInProgress();
    } finally {
      Appointment.removeHook('beforeUpdate', 'evidence-fail-first');
    }

    expect(advanced).toBe(1);

    const rows = await Appointment.findAll({
      where: { id: { [Op.in]: [first.id, second.id] } },
      order: [['startsAt', 'ASC']],
    });
    expect(rows.map((row) => row.status)).toEqual(['CONFIRMED', 'IN_PROGRESS']);
  });
});
