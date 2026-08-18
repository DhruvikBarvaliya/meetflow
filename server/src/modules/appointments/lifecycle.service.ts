/**
 * Appointment lifecycle: reschedule, cancel, approve, reject, check-in,
 * complete and no-show.
 *
 * Three principles run through all of it:
 *
 *  1. **History is never overwritten.** A reschedule keeps the appointment's
 *     identity (so the customer's management link never breaks) and records the
 *     move in `reschedule_history`; every status change appends to
 *     `appointment_status_history`. Nothing is silently mutated away.
 *
 *  2. **Reservations are re-claimed, never slid.** Moving an appointment
 *     re-runs the reservation it made at booking time against the new window:
 *     the staff row is deleted and re-inserted so the exclusion constraint has
 *     to re-check it, and resources go back through the same capacity-counting
 *     path a first booking uses. Sliding the rows with a bare UPDATE would look
 *     equivalent and is not — a shared resource (capacity > 1) has no exclusion
 *     constraint behind it, so an UPDATE that skips the count is guarded by
 *     nothing. Cancelling, by contrast, releases reservations by clearing the
 *     blocking flag rather than deleting the row, which frees the calendar
 *     while keeping the assignment auditable.
 *
 *  3. **Nothing outlives the appointment it describes.** A queued reminder is a
 *     promise about one specific hour, carrying a payload frozen when it was
 *     written. The moment that hour stops being true — the appointment moves,
 *     or reaches a terminal state — the promise is withdrawn in the same
 *     transaction as the change that broke it, and a reschedule queues fresh
 *     reminders for the new time.
 */
import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import { sequelize } from '../../config/database';
import { env } from '../../config/env';
import { createLogger } from '../../config/logger';
import {
  Appointment,
  AppointmentParticipant,
  AppointmentResource,
  AppointmentStaff,
  AppointmentStatusHistory,
  Business,
  BusinessSettings,
  Customer,
  Location,
  Notification,
  RescheduleHistory,
  Resource,
  Service,
  ServiceResourceRequirement,
  StaffProfile,
} from '../../database/models';
import {
  ACTIVE_APPOINTMENT_STATUSES,
  TERMINAL_APPOINTMENT_STATUSES,
  type AppointmentStatus,
} from '../../database/models/Appointment';
import { verifySlot } from '../../scheduling/availability.service';
import { emitAppointmentEvent, emitToWorkspace, SocketEvents } from '../../sockets';
import {
  InvalidStateTransitionError,
  NotFoundError,
  PolicyViolationError,
  ResourceUnavailableError,
  SlotUnavailableError,
} from '../../utils/errors';
import { addMinutes, differenceInMinutes, formatForHumans } from '../../utils/time';
import { AuditActions, recordAudit } from '../audit/audit.service';
import { enqueueNotification } from '../notifications/notification.service';
import { evaluateWaitlistForSlot } from '../waitlist/waitlist.matcher';
import { publishAppointmentWebhook } from '../webhooks/webhooks.service';
import { WebhookEvents, type WebhookEvent } from '../webhooks/webhooks.validation';

const log = createLogger('lifecycle');

export interface LifecycleActor {
  type: 'CUSTOMER' | 'STAFF' | 'OWNER' | 'ADMIN' | 'SYSTEM';
  userId?: string | null;
  customerId?: string | null;
  label?: string | null;
}

export interface LifecycleMetadata {
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/**
 * Legal status transitions.
 *
 * Encoded as data rather than scattered `if` statements so the state machine
 * can be read — and tested — in one place.
 */
const ALLOWED_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  PENDING: ['CONFIRMED', 'RESCHEDULED', 'CANCELLED', 'REJECTED'],
  CONFIRMED: ['RESCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
  RESCHEDULED: ['RESCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED', 'NO_SHOW'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
  REJECTED: [],
};

function assertTransition(from: AppointmentStatus, to: AppointmentStatus): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}

/** Tenant-scoped fetch. A foreign id is indistinguishable from a missing one. */
async function loadAppointment(
  businessId: string,
  appointmentId: string,
  transaction?: Transaction,
  lock = false,
): Promise<Appointment> {
  const appointment = await Appointment.findOne({
    where: { id: appointmentId, businessId },
    transaction,
    ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!appointment) throw new NotFoundError('Appointment');
  return appointment;
}

export async function loadAppointmentByPublicId(publicId: string): Promise<Appointment> {
  const appointment = await Appointment.findOne({ where: { publicId } });
  if (!appointment) throw new NotFoundError('Appointment');
  return appointment;
}

async function settingsFor(
  businessId: string,
  transaction?: Transaction,
): Promise<BusinessSettings> {
  const [settings] = await BusinessSettings.findOrCreate({
    where: { businessId },
    defaults: { businessId },
    transaction,
  });
  return settings;
}

async function appendHistory(
  appointment: Appointment,
  from: AppointmentStatus | null,
  to: AppointmentStatus,
  actor: LifecycleActor,
  reason: string | null,
  metadata: Record<string, unknown>,
  transaction: Transaction,
): Promise<void> {
  await AppointmentStatusHistory.create(
    {
      appointmentId: appointment.id,
      businessId: appointment.businessId,
      fromStatus: from,
      toStatus: to,
      actorType: actor.type,
      actorUserId: actor.userId ?? null,
      actorLabel: actor.label ?? null,
      reason,
      metadata,
    },
    { transaction },
  );
}

/** Notification payload shared by every lifecycle email. */
async function buildPayload(
  appointment: Appointment,
  transaction?: Transaction,
): Promise<{ payload: Record<string, unknown>; customer: Customer | null; business: Business }> {
  const [business, service, staffProfile, location, customer] = await Promise.all([
    Business.findByPk(appointment.businessId, { transaction }),
    Service.findByPk(appointment.serviceId, { transaction }),
    appointment.staffProfileId
      ? StaffProfile.findByPk(appointment.staffProfileId, { transaction })
      : Promise.resolve(null),
    appointment.locationId
      ? Location.findByPk(appointment.locationId, { transaction })
      : Promise.resolve(null),
    appointment.customerId
      ? Customer.findByPk(appointment.customerId, { transaction })
      : Promise.resolve(null),
  ]);

  if (!business) throw new NotFoundError('Workspace');
  const zone = customer?.timezone || appointment.timezone;

  return {
    business,
    customer,
    payload: {
      customerName: customer ? `${customer.firstName} ${customer.lastName ?? ''}`.trim() : 'there',
      businessName: business.name,
      serviceName: service?.name ?? 'your appointment',
      staffName: staffProfile?.displayName ?? 'our team',
      locationName: location?.name ?? 'Online',
      startsAtLocal: formatForHumans(appointment.startsAt, zone),
      timezone: zone,
      durationMinutes: appointment.durationMinutes,
      manageUrl: `${env.PUBLIC_APP_URL}/appointments/${appointment.publicId}`,
      bookingUrl: `${env.PUBLIC_APP_URL}/b/${business.slug}`,
      dashboardUrl: `${env.PUBLIC_APP_URL}/app/schedule`,
      reason: appointment.cancellationReason ?? '',
    },
  };
}

// ---------------------------------------------------------------------------
// Queued messages that a change makes untrue
// ---------------------------------------------------------------------------

/**
 * Which undelivered messages a move into `status` invalidates.
 *
 * A reminder only means anything before the appointment starts, so every
 * terminal state withdraws it — including COMPLETED, where an un-sent reminder
 * whose `scheduled_for` has quietly gone past would still be picked up by the
 * delivery sweep and remind someone about a visit they have already had.
 *
 * A follow-up is the mirror image: it is *meant* to arrive afterwards, so it
 * survives COMPLETED and is withdrawn only when the appointment never happened.
 */
function staleMessageTypes(status: AppointmentStatus): string[] {
  return status === 'COMPLETED'
    ? ['APPOINTMENT_REMINDER']
    : ['APPOINTMENT_REMINDER', 'APPOINTMENT_FOLLOW_UP'];
}

/**
 * Withdraws the outbox rows that are no longer true.
 *
 * CANCELLED rather than deleted: the outbox is the delivery record, and "we
 * promised this and then withdrew it" is a different fact from "we never
 * promised it". Only PENDING rows are touched — anything already PROCESSING or
 * SENT has left, and rewriting its status would falsify the record.
 *
 * Always called inside the caller's transaction, so a rolled-back change cannot
 * silence a reminder that is still due.
 */
async function withdrawStaleMessages(
  appointmentId: string,
  status: AppointmentStatus,
  transaction: Transaction,
): Promise<void> {
  await Notification.update(
    { status: 'CANCELLED' },
    {
      where: {
        appointmentId,
        status: 'PENDING',
        type: { [Op.in]: staleMessageTypes(status) },
      },
      transaction,
    },
  );
}

// ---------------------------------------------------------------------------
// Resource reservation
// ---------------------------------------------------------------------------

/**
 * Claims every resource a service requires for one window.
 *
 * Deliberately the same algorithm as `reserveResources` in booking.service.ts —
 * row lock on the candidates, count of live overlaps against capacity, a
 * SAVEPOINT per attempt — because a reschedule has to be exactly as hard to
 * oversubscribe as a first booking. Single-capacity resources end up protected
 * by the `appointment_resources_no_overlap` exclusion constraint whatever the
 * application does; shared ones (capacity > 1) have no such constraint, because
 * "at most N overlapping" is not expressible as an exclusion, so for those the
 * count taken under the row lock is the only thing between two transactions and
 * a double claim. The two copies must change together; the only reason this is
 * not one function is that booking.service.ts keeps its copy private.
 */
async function reserveResources(
  input: {
    businessId: string;
    serviceId: string;
    locationId: string | null;
    appointmentId: string;
    bufferStartAt: Date;
    bufferEndAt: Date;
  },
  transaction: Transaction,
): Promise<void> {
  const requirements = await ServiceResourceRequirement.findAll({
    where: { serviceId: input.serviceId },
    transaction,
  });
  if (requirements.length === 0) return;

  for (const requirement of requirements) {
    const candidates = await Resource.findAll({
      where: {
        businessId: input.businessId,
        isActive: true,
        ...(requirement.resourceId ? { id: requirement.resourceId } : {}),
        ...(requirement.resourceType ? { type: requirement.resourceType } : {}),
        // A resource pinned to a location can only serve that location.
        ...(input.locationId
          ? { [Op.or]: [{ locationId: input.locationId }, { locationId: { [Op.is]: null } }] }
          : {}),
      },
      order: [['name', 'ASC']],
      transaction,
      // Serialises selection of the same shared resource across transactions.
      lock: transaction.LOCK.UPDATE,
    });

    let remaining = requirement.quantity;

    for (const resource of candidates) {
      if (remaining === 0) break;

      const overlapping = await AppointmentResource.count({
        where: {
          resourceId: resource.id,
          isActive: true,
          startsAt: { [Op.lt]: input.bufferEndAt },
          endsAt: { [Op.gt]: input.bufferStartAt },
        },
        transaction,
      });
      if (overlapping >= resource.capacity) continue;

      try {
        // SAVEPOINT, not a bare INSERT: losing the race for one resource must
        // leave the surrounding transaction usable so the next candidate can be
        // tried. Without it, PostgreSQL aborts the whole transaction on the
        // first constraint violation.
        await sequelize.transaction({ transaction }, async (savepoint) =>
          AppointmentResource.create(
            {
              appointmentId: input.appointmentId,
              resourceId: resource.id,
              quantity: 1,
              startsAt: input.bufferStartAt,
              endsAt: input.bufferEndAt,
              isExclusive: resource.capacity === 1,
              isActive: true,
            },
            { transaction: savepoint },
          ),
        );
        remaining -= 1;
      } catch (error) {
        // Lost the race for this specific resource; try the next candidate
        // rather than failing the whole move.
        if (
          error instanceof Error &&
          (error.name === 'SequelizeExclusionConstraintError' ||
            error.name === 'SequelizeUniqueConstraintError')
        ) {
          continue;
        }
        throw error;
      }
    }

    if (remaining > 0) {
      if (requirement.isRequired) {
        throw new ResourceUnavailableError(
          'A room or piece of equipment this service needs is not available at that time.',
          { requirement: requirement.resourceType ?? requirement.resourceId, shortfall: remaining },
        );
      }
      // Optional requirement: proceed without it rather than block the move.
      log.debug(
        { serviceId: input.serviceId, requirementId: requirement.id, shortfall: remaining },
        'optional resource requirement not fully satisfied',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Reschedule
// ---------------------------------------------------------------------------

export interface RescheduleInput {
  businessId: string;
  appointmentId: string;
  newStartsAt: Date;
  newStaffProfileId?: string | null;
  newLocationId?: string | null;
  reason?: string | null;
  actor: LifecycleActor;
  metadata?: LifecycleMetadata;
  /** Customer-initiated moves are subject to the deadline and the allow flag. */
  enforceCustomerPolicy?: boolean;
}

export async function rescheduleAppointment(input: RescheduleInput): Promise<Appointment> {
  const existing = await loadAppointment(input.businessId, input.appointmentId);

  if (TERMINAL_APPOINTMENT_STATUSES.includes(existing.status)) {
    throw new InvalidStateTransitionError(existing.status, 'RESCHEDULED');
  }

  const settings = await settingsFor(input.businessId);
  const business = await Business.findByPk(input.businessId);
  if (!business) throw new NotFoundError('Workspace');

  if (input.enforceCustomerPolicy) {
    if (!settings.allowCustomerReschedule) {
      throw new PolicyViolationError(
        'This business does not allow customers to reschedule online.',
      );
    }
    const noticeMinutes = differenceInMinutes(existing.startsAt, new Date());
    if (noticeMinutes < settings.rescheduleDeadlineMinutes) {
      throw new PolicyViolationError(
        `Appointments can only be moved more than ${settings.rescheduleDeadlineMinutes} minutes in advance.`,
        {
          deadlineMinutes: settings.rescheduleDeadlineMinutes,
          noticeMinutes: Math.floor(noticeMinutes),
        },
      );
    }
  }

  if (existing.rescheduleCount >= settings.maxReschedulesPerAppointment) {
    throw new PolicyViolationError(
      `This appointment has already been moved ${existing.rescheduleCount} time(s), which is the maximum.`,
      { maxReschedules: settings.maxReschedulesPerAppointment },
    );
  }

  const targetStaffId = input.newStaffProfileId ?? existing.staffProfileId;
  if (!targetStaffId) throw new PolicyViolationError('This appointment has no assigned provider.');

  // A group session cannot be moved from under its other attendees.
  if (existing.capacity > 1 && existing.bookedCount > 1) {
    throw new PolicyViolationError(
      'Sessions with several attendees must be rescheduled by the business, not from a single booking.',
    );
  }

  const verdict = await verifySlot({
    businessId: input.businessId,
    businessTimezone: business.timezone,
    serviceId: existing.serviceId,
    staffProfileId: targetStaffId,
    locationId: input.newLocationId ?? existing.locationId,
    startsAt: input.newStartsAt,
  });
  if (!verdict.ok) {
    throw new SlotUnavailableError(verdict.reason ?? 'That time is not available.');
  }

  const policy = verdict.policy;
  const previous = {
    startsAt: existing.startsAt,
    endsAt: existing.endsAt,
    staffProfileId: existing.staffProfileId,
    locationId: existing.locationId,
    status: existing.status,
  };

  const endsAt = addMinutes(input.newStartsAt, policy.durationMinutes);
  const bufferStartAt = addMinutes(input.newStartsAt, -policy.preBufferMinutes);
  const bufferEndAt = addMinutes(endsAt, policy.postBufferMinutes);

  const updated = await sequelize.transaction(async (transaction) => {
    const appointment = await loadAppointment(
      input.businessId,
      input.appointmentId,
      transaction,
      true,
    );

    assertTransition(appointment.status, 'RESCHEDULED');

    await appointment.update(
      {
        startsAt: input.newStartsAt,
        endsAt,
        bufferStartAt,
        bufferEndAt,
        durationMinutes: policy.durationMinutes,
        preBufferMinutes: policy.preBufferMinutes,
        postBufferMinutes: policy.postBufferMinutes,
        staffProfileId: targetStaffId,
        locationId: input.newLocationId ?? appointment.locationId,
        status: 'RESCHEDULED',
        rescheduleCount: appointment.rescheduleCount + 1,
      },
      { transaction },
    );

    // Move the reservation. The exclusion constraint re-checks the new window,
    // so a race with another booking still cannot double-book.
    await AppointmentStaff.destroy({
      where: { appointmentId: appointment.id },
      transaction,
    });
    await AppointmentStaff.create(
      {
        appointmentId: appointment.id,
        staffProfileId: targetStaffId,
        role: 'PRIMARY',
        startsAt: bufferStartAt,
        endsAt: bufferEndAt,
        isBlocking: true,
      },
      { transaction },
    );

    // Resource holds are released and re-claimed, not slid across. Sliding them
    // with an UPDATE never re-runs the capacity count, and a shared resource has
    // no exclusion constraint to catch what the count would have — so the new
    // window could be oversubscribed with nothing complaining. Deleting first is
    // what makes the swap atomic: within this transaction the old window is
    // already free, so an overlapping move does not conflict with itself and
    // `appointment_resources_unique (appointment_id, resource_id)` does not
    // reject re-claiming the very same room. If the new window cannot be
    // satisfied, `reserveResources` throws, the transaction rolls back, and the
    // appointment keeps both its original time and its original holds.
    await AppointmentResource.destroy({
      where: { appointmentId: appointment.id },
      transaction,
    });
    await reserveResources(
      {
        businessId: appointment.businessId,
        serviceId: appointment.serviceId,
        locationId: appointment.locationId,
        appointmentId: appointment.id,
        bufferStartAt,
        bufferEndAt,
      },
      transaction,
    );

    await RescheduleHistory.create(
      {
        appointmentId: appointment.id,
        businessId: appointment.businessId,
        previousStartsAt: previous.startsAt,
        previousEndsAt: previous.endsAt,
        newStartsAt: input.newStartsAt,
        newEndsAt: endsAt,
        previousStaffProfileId: previous.staffProfileId,
        newStaffProfileId: targetStaffId,
        previousLocationId: previous.locationId,
        newLocationId: appointment.locationId,
        reason: input.reason ?? null,
        actorType: input.actor.type,
        actorUserId: input.actor.userId ?? null,
        lateReschedule:
          differenceInMinutes(previous.startsAt, new Date()) < settings.rescheduleDeadlineMinutes,
      },
      { transaction },
    );

    await appendHistory(
      appointment,
      previous.status,
      'RESCHEDULED',
      input.actor,
      input.reason ?? null,
      { from: previous.startsAt, to: input.newStartsAt },
      transaction,
    );

    await recordAudit(
      {
        businessId: appointment.businessId,
        actorType: input.actor.type === 'CUSTOMER' ? 'CUSTOMER' : 'USER',
        actorUserId: input.actor.userId ?? null,
        actorCustomerId: input.actor.customerId ?? null,
        actorLabel: input.actor.label ?? null,
        action: AuditActions.APPOINTMENT_RESCHEDULED,
        entityType: 'appointment',
        entityId: appointment.id,
        requestId: input.metadata?.requestId,
        ipAddress: input.metadata?.ipAddress,
        metadata: { from: previous.startsAt, to: input.newStartsAt, reason: input.reason ?? null },
      },
      { transaction },
    );

    // Every reminder queued for the old time is now a lie twice over: its
    // `scheduled_for` counts down to an hour the appointment has left, and its
    // payload still spells out the old `startsAtLocal`. Withdraw them here and
    // queue replacements below — both inside this transaction, so a move that
    // rolls back cannot leave the customer with no reminder at all.
    await withdrawStaleMessages(appointment.id, 'RESCHEDULED', transaction);

    const { payload, customer } = await buildPayload(appointment, transaction);
    if (customer) {
      await enqueueNotification(
        {
          businessId: appointment.businessId,
          type: 'BOOKING_RESCHEDULED',
          recipientType: 'CUSTOMER',
          recipientCustomerId: customer.id,
          recipientAddress: customer.email,
          appointmentId: appointment.id,
          payload: {
            ...payload,
            previousStartsAtLocal: formatForHumans(previous.startsAt, customer.timezone),
          },
          // Keyed on the new time so each distinct move sends exactly once.
          dedupeKey: `reschedule:${appointment.id}:${input.newStartsAt.toISOString()}`,
        },
        { transaction },
      );

      // Fresh reminders for the new time, from the workspace's own offsets —
      // the same source booking reads, so a business that configured "three days
      // before" keeps getting three days before after a move. `payload` was
      // rebuilt from the already-updated appointment, so `startsAtLocal` reads
      // the new hour. Offsets that have already gone past are skipped rather
      // than fired immediately.
      for (const offsetMinutes of settings.reminderOffsetsMinutes) {
        const scheduledFor = addMinutes(input.newStartsAt, -offsetMinutes);
        if (scheduledFor.getTime() <= Date.now()) continue;

        await enqueueNotification(
          {
            businessId: appointment.businessId,
            type: 'APPOINTMENT_REMINDER',
            recipientType: 'CUSTOMER',
            recipientCustomerId: customer.id,
            recipientAddress: customer.email,
            appointmentId: appointment.id,
            payload,
            scheduledFor,
            // The booking-time key is `remind:<appointment>:<customer>:<offset>`
            // and it now belongs to the row we just cancelled. Reusing it would
            // hit the unique index on `dedupe_key`, which `enqueueNotification`
            // reads as "already queued" — leaving the customer with no reminder
            // whatsoever. The reschedule counter distinguishes every move, and
            // its extra segment can never collide with the booking-time form.
            dedupeKey: `remind:${appointment.id}:${customer.id}:r${appointment.rescheduleCount}:${offsetMinutes}`,
          },
          { transaction },
        );
      }
    }

    // Inside the transaction, like the outbox rows above and for the same
    // reason: a move that rolls back must not tell a subscriber the appointment
    // is somewhere it is not. The previous time travels with the event because
    // a subscriber's own calendar needs to know which entry to replace.
    await publishAppointmentWebhook(WebhookEvents.APPOINTMENT_RESCHEDULED, appointment, {
      transaction,
      extra: { previousStartsAt: previous.startsAt, previousEndsAt: previous.endsAt },
    });

    return appointment;
  });

  emitAppointmentEvent(
    SocketEvents.appointmentRescheduled,
    {
      businessId: updated.businessId,
      staffProfileId: updated.staffProfileId,
      appointmentId: updated.id,
    },
    {
      appointmentId: updated.id,
      publicId: updated.publicId,
      previousStartsAt: previous.startsAt,
      startsAt: updated.startsAt,
      endsAt: updated.endsAt,
      staffProfileId: updated.staffProfileId,
    },
  );
  // The provider losing the slot needs to know too, when the move reassigned it.
  if (previous.staffProfileId && previous.staffProfileId !== updated.staffProfileId) {
    emitAppointmentEvent(
      SocketEvents.appointmentUpdated,
      {
        businessId: updated.businessId,
        staffProfileId: previous.staffProfileId,
        appointmentId: updated.id,
      },
      { appointmentId: updated.id, reassignedTo: updated.staffProfileId },
    );
  }

  log.info({ appointmentId: updated.id, to: updated.startsAt }, 'appointment rescheduled');
  return updated;
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export interface CancelInput {
  businessId: string;
  appointmentId: string;
  reason?: string | null;
  actor: LifecycleActor;
  metadata?: LifecycleMetadata;
  enforceCustomerPolicy?: boolean;
  /** Cancel one attendee's place instead of the whole group session. */
  participantId?: string | null;
}

export async function cancelAppointment(input: CancelInput): Promise<Appointment> {
  const existing = await loadAppointment(input.businessId, input.appointmentId);
  if (TERMINAL_APPOINTMENT_STATUSES.includes(existing.status)) {
    throw new InvalidStateTransitionError(existing.status, 'CANCELLED');
  }

  const settings = await settingsFor(input.businessId);
  const noticeMinutes = differenceInMinutes(existing.startsAt, new Date());
  const isLate = noticeMinutes < settings.cancellationDeadlineMinutes;

  if (input.enforceCustomerPolicy) {
    if (!settings.allowCustomerCancel) {
      throw new PolicyViolationError('This business does not allow customers to cancel online.');
    }
    if (isLate) {
      throw new PolicyViolationError(
        `Appointments can only be cancelled more than ${settings.cancellationDeadlineMinutes} minutes in advance. Please contact the business.`,
        {
          deadlineMinutes: settings.cancellationDeadlineMinutes,
          noticeMinutes: Math.floor(noticeMinutes),
        },
      );
    }
  }

  const result = await sequelize.transaction(async (transaction) => {
    const appointment = await loadAppointment(
      input.businessId,
      input.appointmentId,
      transaction,
      true,
    );
    const previousStatus = appointment.status;

    // Group session: cancelling one attendee frees a place, it does not cancel
    // the class for everybody else.
    if (input.participantId && appointment.capacity > 1) {
      const participant = await AppointmentParticipant.findOne({
        where: { id: input.participantId, appointmentId: appointment.id },
        transaction,
      });
      if (!participant) throw new NotFoundError('Booking');
      if (participant.status !== 'CANCELLED') {
        await participant.update({ status: 'CANCELLED', cancelledAt: new Date() }, { transaction });
        await appointment.update(
          { bookedCount: Math.max(0, appointment.bookedCount - 1) },
          { transaction },
        );
      }

      // The session itself only ends when the last attendee leaves.
      if (appointment.bookedCount > 0) {
        await appendHistory(
          appointment,
          previousStatus,
          previousStatus,
          input.actor,
          input.reason ?? null,
          { participantCancelled: participant.id, remaining: appointment.bookedCount },
          transaction,
        );
        return { appointment, fullyCancelled: false };
      }
    }

    assertTransition(previousStatus, 'CANCELLED');

    await appointment.update(
      {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancellationReason: input.reason ?? null,
        cancelledByType: input.actor.type,
        cancelledByUserId: input.actor.userId ?? null,
        lateCancellation: isLate,
        bookedCount: 0,
      },
      { transaction },
    );

    // Release the calendar without destroying the assignment record.
    await AppointmentStaff.update(
      { isBlocking: false },
      { where: { appointmentId: appointment.id }, transaction },
    );
    await AppointmentResource.update(
      { isActive: false },
      { where: { appointmentId: appointment.id }, transaction },
    );
    await AppointmentParticipant.update(
      { status: 'CANCELLED', cancelledAt: new Date() },
      { where: { appointmentId: appointment.id, status: { [Op.ne]: 'CANCELLED' } }, transaction },
    );

    // Pending reminders for a cancelled appointment must not go out.
    await withdrawStaleMessages(appointment.id, 'CANCELLED', transaction);

    if (appointment.customerId) {
      const customer = await Customer.findByPk(appointment.customerId, { transaction });
      await customer?.update({ cancelledCount: customer.cancelledCount + 1 }, { transaction });
    }

    await appendHistory(
      appointment,
      previousStatus,
      'CANCELLED',
      input.actor,
      input.reason ?? null,
      { lateCancellation: isLate, noticeMinutes: Math.floor(noticeMinutes) },
      transaction,
    );

    await recordAudit(
      {
        businessId: appointment.businessId,
        actorType: input.actor.type === 'CUSTOMER' ? 'CUSTOMER' : 'USER',
        actorUserId: input.actor.userId ?? null,
        actorCustomerId: input.actor.customerId ?? null,
        actorLabel: input.actor.label ?? null,
        action: AuditActions.APPOINTMENT_CANCELLED,
        entityType: 'appointment',
        entityId: appointment.id,
        requestId: input.metadata?.requestId,
        ipAddress: input.metadata?.ipAddress,
        metadata: { reason: input.reason ?? null, lateCancellation: isLate },
      },
      { transaction },
    );

    const { payload, customer } = await buildPayload(appointment, transaction);
    if (customer) {
      await enqueueNotification(
        {
          businessId: appointment.businessId,
          type: 'BOOKING_CANCELLED',
          recipientType: 'CUSTOMER',
          recipientCustomerId: customer.id,
          recipientAddress: customer.email,
          appointmentId: appointment.id,
          payload: { ...payload, reason: input.reason ?? '' },
          dedupeKey: `cancel:${appointment.id}`,
        },
        { transaction },
      );
    }

    // Only the full cancellation is announced. One attendee leaving a group
    // session returns above without reaching here, and rightly so: the session
    // is still happening, so `appointment.cancelled` would be a lie to every
    // subscriber and to the other attendees' calendars.
    await publishAppointmentWebhook(WebhookEvents.APPOINTMENT_CANCELLED, appointment, {
      transaction,
      extra: { reason: input.reason ?? null, lateCancellation: isLate },
    });

    return { appointment, fullyCancelled: true };
  });

  emitAppointmentEvent(
    SocketEvents.appointmentCancelled,
    {
      businessId: result.appointment.businessId,
      staffProfileId: result.appointment.staffProfileId,
      appointmentId: result.appointment.id,
    },
    {
      appointmentId: result.appointment.id,
      publicId: result.appointment.publicId,
      startsAt: result.appointment.startsAt,
      fullyCancelled: result.fullyCancelled,
    },
  );
  emitToWorkspace(result.appointment.businessId, SocketEvents.dashboardMetricsUpdated, {
    reason: 'appointment.cancelled',
  });

  // A cancellation is the main way a slot frees up, so this is where the
  // waitlist gets its chance. Deliberately after the commit and deliberately
  // not awaited into the caller's result: the customer's cancellation has
  // already succeeded, and an offer that fails to send must not turn it into an
  // error. Failures are logged; the entry stays ACTIVE and is picked up by the
  // next opening.
  if (result.fullyCancelled && result.appointment.staffProfileId) {
    void evaluateWaitlistForSlot({
      businessId: result.appointment.businessId,
      serviceId: result.appointment.serviceId,
      staffProfileId: result.appointment.staffProfileId,
      startsAt: result.appointment.startsAt,
      endsAt: result.appointment.endsAt,
    })
      .then((entry) => {
        if (entry) {
          log.info(
            { appointmentId: result.appointment.id, waitlistEntryId: entry.id },
            'freed slot offered to a waitlisted customer',
          );
        }
      })
      .catch((error: unknown) => {
        log.error(
          { err: error, appointmentId: result.appointment.id },
          'waitlist evaluation failed for a freed slot',
        );
      });
  }

  log.info(
    { appointmentId: result.appointment.id, fullyCancelled: result.fullyCancelled },
    'appointment cancelled',
  );
  return result.appointment;
}

// ---------------------------------------------------------------------------
// Simple status transitions
// ---------------------------------------------------------------------------

interface TransitionInput {
  businessId: string;
  appointmentId: string;
  actor: LifecycleActor;
  metadata?: LifecycleMetadata;
  reason?: string | null;
}

async function transition(
  input: TransitionInput,
  to: AppointmentStatus,
  apply: (appointment: Appointment) => Record<string, unknown>,
  auditAction: string,
  socketEvent: (typeof SocketEvents)[keyof typeof SocketEvents],
  /**
   * Optional because not every transition is a subscribable event: approval and
   * rejection are internal moderation steps, and the webhook catalogue promises
   * five appointment events rather than "whatever the state machine does".
   */
  webhookEvent?: WebhookEvent,
): Promise<Appointment> {
  const updated = await sequelize.transaction(async (transaction) => {
    const appointment = await loadAppointment(
      input.businessId,
      input.appointmentId,
      transaction,
      true,
    );
    const from = appointment.status;
    assertTransition(from, to);

    await appointment.update({ status: to, ...apply(appointment) }, { transaction });

    // Terminal states release the calendar and withdraw what was still queued.
    // Rejection is the case that matters most here: a customer whose booking
    // was refused was, until this ran, still going to be reminded to turn up
    // for it.
    if (TERMINAL_APPOINTMENT_STATUSES.includes(to)) {
      await AppointmentStaff.update(
        { isBlocking: false },
        { where: { appointmentId: appointment.id }, transaction },
      );
      await AppointmentResource.update(
        { isActive: false },
        { where: { appointmentId: appointment.id }, transaction },
      );
      await withdrawStaleMessages(appointment.id, to, transaction);
    }

    await appendHistory(appointment, from, to, input.actor, input.reason ?? null, {}, transaction);

    await recordAudit(
      {
        businessId: appointment.businessId,
        actorType: input.actor.type === 'CUSTOMER' ? 'CUSTOMER' : 'USER',
        actorUserId: input.actor.userId ?? null,
        actorLabel: input.actor.label ?? null,
        action: auditAction,
        entityType: 'appointment',
        entityId: appointment.id,
        requestId: input.metadata?.requestId,
        ipAddress: input.metadata?.ipAddress,
        metadata: { from, to },
      },
      { transaction },
    );

    // Inside the transaction with the status change it announces; the socket
    // emission below is deliberately outside it, because a real-time nudge that
    // arrives twice is harmless and one that arrives early is not.
    if (webhookEvent) {
      await publishAppointmentWebhook(webhookEvent, appointment, { transaction });
    }

    return appointment;
  });

  emitAppointmentEvent(
    socketEvent,
    {
      businessId: updated.businessId,
      staffProfileId: updated.staffProfileId,
      appointmentId: updated.id,
    },
    { appointmentId: updated.id, publicId: updated.publicId, status: updated.status },
  );
  emitToWorkspace(updated.businessId, SocketEvents.dashboardMetricsUpdated, {
    reason: `appointment.${updated.status.toLowerCase()}`,
  });

  return updated;
}

/** Approve a booking that required review. */
export async function approveAppointment(input: TransitionInput): Promise<Appointment> {
  const updated = await transition(
    input,
    'CONFIRMED',
    () => ({ confirmedAt: new Date() }),
    AuditActions.APPOINTMENT_APPROVED,
    SocketEvents.appointmentUpdated,
  );

  const { payload, customer } = await buildPayload(updated);
  if (customer) {
    await enqueueNotification({
      businessId: updated.businessId,
      type: 'BOOKING_APPROVED',
      recipientType: 'CUSTOMER',
      recipientCustomerId: customer.id,
      recipientAddress: customer.email,
      appointmentId: updated.id,
      payload,
      dedupeKey: `approved:${updated.id}`,
    });
  }
  return updated;
}

export async function rejectAppointment(input: TransitionInput): Promise<Appointment> {
  const updated = await transition(
    input,
    'REJECTED',
    () => ({ cancelledAt: new Date(), cancellationReason: input.reason ?? null }),
    AuditActions.APPOINTMENT_REJECTED,
    SocketEvents.appointmentUpdated,
  );

  const { payload, customer } = await buildPayload(updated);
  if (customer) {
    await enqueueNotification({
      businessId: updated.businessId,
      type: 'BOOKING_REJECTED',
      recipientType: 'CUSTOMER',
      recipientCustomerId: customer.id,
      recipientAddress: customer.email,
      appointmentId: updated.id,
      payload: { ...payload, reason: input.reason ?? '' },
      dedupeKey: `rejected:${updated.id}`,
    });
  }
  return updated;
}

/** Records arrival. Does not change status; the sweep promotes to IN_PROGRESS. */
export async function checkInAppointment(input: TransitionInput): Promise<Appointment> {
  const appointment = await loadAppointment(input.businessId, input.appointmentId);
  if (!ACTIVE_APPOINTMENT_STATUSES.includes(appointment.status)) {
    throw new InvalidStateTransitionError(appointment.status, 'IN_PROGRESS');
  }
  await appointment.update({ checkedInAt: new Date() });

  emitAppointmentEvent(
    SocketEvents.appointmentUpdated,
    {
      businessId: appointment.businessId,
      staffProfileId: appointment.staffProfileId,
      appointmentId: appointment.id,
    },
    { appointmentId: appointment.id, checkedInAt: appointment.checkedInAt },
  );
  return appointment;
}

export async function completeAppointment(input: TransitionInput): Promise<Appointment> {
  const updated = await transition(
    input,
    'COMPLETED',
    () => ({ completedAt: new Date() }),
    AuditActions.APPOINTMENT_COMPLETED,
    SocketEvents.appointmentCompleted,
    WebhookEvents.APPOINTMENT_COMPLETED,
  );

  if (updated.customerId) {
    const customer = await Customer.findByPk(updated.customerId);
    await customer?.update({ completedCount: customer.completedCount + 1 });
  }
  await AppointmentParticipant.update(
    { status: 'ATTENDED' },
    { where: { appointmentId: updated.id, status: 'BOOKED' } },
  );

  return updated;
}

/**
 * Marks a no-show.
 *
 * Guarded by the configured grace period: a customer who is five minutes late
 * has not failed to attend, and marking them absent affects their record.
 */
export async function markNoShow(input: TransitionInput): Promise<Appointment> {
  const appointment = await loadAppointment(input.businessId, input.appointmentId);
  const settings = await settingsFor(input.businessId);
  const elapsed = differenceInMinutes(new Date(), appointment.startsAt);

  if (elapsed < settings.noShowGraceMinutes) {
    throw new PolicyViolationError(
      `An appointment can only be marked as a no-show ${settings.noShowGraceMinutes} minutes after its start time.`,
      {
        graceMinutes: settings.noShowGraceMinutes,
        minutesSinceStart: Math.floor(elapsed),
      },
    );
  }

  const updated = await transition(
    input,
    'NO_SHOW',
    () => ({ noShowAt: new Date() }),
    AuditActions.APPOINTMENT_NO_SHOW,
    SocketEvents.appointmentNoShow,
    WebhookEvents.APPOINTMENT_NO_SHOW,
  );

  if (updated.customerId) {
    const customer = await Customer.findByPk(updated.customerId);
    await customer?.update({ noShowCount: customer.noShowCount + 1 });
  }
  await AppointmentParticipant.update(
    { status: 'NO_SHOW' },
    { where: { appointmentId: updated.id, status: 'BOOKED' } },
  );

  return updated;
}
