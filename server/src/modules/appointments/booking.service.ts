/**
 * Booking confirmation.
 *
 * This is the most safety-critical path in MeetFlow, and it is defended in
 * layers rather than by any single check:
 *
 *   1. **Idempotency** — a durable record keyed on (scope, key) means a retried
 *      or double-submitted request returns the original appointment instead of
 *      creating a second one.
 *   2. **Advisory lock** — a short Redis lock on the exact slot removes most
 *      contention before it reaches PostgreSQL. It is an optimisation only;
 *      losing it changes nothing about correctness.
 *   3. **Re-validation** — eligibility is recomputed from live data inside the
 *      request, never trusted from the availability response the client saw.
 *   4. **Database exclusion constraints** — the final, unavoidable authority.
 *      Two transactions that both believe a slot is free cannot both commit:
 *      `appointment_staff_no_overlap` rejects the loser with SQLSTATE 23P01,
 *      which surfaces as a clean 409 SLOT_UNAVAILABLE.
 *   5. **Row locks** for group capacity, which an exclusion constraint cannot
 *      express ("at most N" is not "no overlap").
 *
 * Nothing is announced before it is durable: the real-time event and the
 * webhook fan-out happen only after the transaction has committed.
 */
import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import { sequelize } from '../../config/database';
import { env } from '../../config/env';
import { createLogger } from '../../config/logger';
import { RedisKeys, withLock } from '../../config/redis';
import {
  Appointment,
  AppointmentParticipant,
  AppointmentResource,
  AppointmentStaff,
  AppointmentStatusHistory,
  BookingLink,
  Business,
  BusinessSettings,
  Customer,
  IdempotencyKey,
  Location,
  Resource,
  Service,
  ServiceResourceRequirement,
  StaffProfile,
} from '../../database/models';
import { ACTIVE_APPOINTMENT_STATUSES } from '../../database/models/Appointment';
import {
  ConflictError,
  ErrorCode,
  NotFoundError,
  PolicyViolationError,
  ResourceUnavailableError,
  SlotUnavailableError,
  ValidationError,
} from '../../utils/errors';
import {
  canonicalHash,
  newAppointmentPublicId,
  newCustomerPublicId,
  newParticipantPublicId,
} from '../../utils/ids';
import {
  addMinutes,
  formatForHumans,
  isValidTimezone,
  startOfDayInZone,
  endOfDayInZone,
  toIsoDateInZone,
} from '../../utils/time';
import { emitAppointmentEvent, emitToWorkspace, SocketEvents } from '../../sockets';
import { AuditActions, recordAudit } from '../audit/audit.service';
import { enqueueNotification } from '../notifications/notification.service';
import { publishAppointmentWebhook } from '../webhooks/webhooks.service';
import { WebhookEvents } from '../webhooks/webhooks.validation';
import {
  getPolicyFor,
  verifySlot,
  type EffectivePolicy,
} from '../../scheduling/availability.service';

const log = createLogger('booking');

export const BOOKING_IDEMPOTENCY_SCOPE = 'appointment.create';

export interface BookingActor {
  type: 'CUSTOMER' | 'STAFF' | 'OWNER' | 'ADMIN' | 'SYSTEM';
  userId?: string | null;
  label?: string | null;
}

export interface CreateBookingInput {
  businessId: string;
  serviceId: string;
  staffProfileId: string;
  locationId?: string | null;
  startsAt: Date;
  /** The customer's own timezone, echoed back in confirmations. */
  timezone: string;
  customer: {
    id?: string | null;
    firstName: string;
    lastName?: string | null;
    email: string;
    phone?: string | null;
  };
  bookingLinkId?: string | null;
  source: 'PUBLIC' | 'STAFF' | 'OWNER' | 'ADMIN' | 'API' | 'WAITLIST';
  customerNotes?: string | null;
  internalNotes?: string | null;
  answers?: Record<string, unknown>;
  idempotencyKey?: string | null;
  actor: BookingActor;
  requestMetadata?: {
    ipAddress?: string | null;
    userAgent?: string | null;
    requestId?: string | null;
  };
}

export interface BookingResult {
  appointment: Appointment;
  participant: AppointmentParticipant;
  customer: Customer;
  /** True when an existing idempotent result was replayed. */
  replayed: boolean;
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

interface IdempotencyOutcome {
  replay: { status: number; body: Record<string, unknown> } | null;
  record: IdempotencyKey | null;
}

/**
 * Claims an idempotency key, or reports that this request has been seen.
 *
 * The unique index on (scope, key) is what makes the claim atomic: two
 * simultaneous retries race to INSERT and exactly one wins.
 */
async function claimIdempotencyKey(
  scope: string,
  key: string,
  businessId: string,
  requestHash: string,
): Promise<IdempotencyOutcome> {
  const expiresAt = new Date(Date.now() + env.IDEMPOTENCY_TTL_SECONDS * 1000);

  try {
    const record = await IdempotencyKey.create({
      scope,
      key,
      businessId,
      requestHash,
      status: 'IN_PROGRESS',
      responseStatus: null,
      responseBody: null,
      resourceType: null,
      resourceId: null,
      completedAt: null,
      expiresAt,
    });
    return { replay: null, record };
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'SequelizeUniqueConstraintError') throw error;
  }

  const existing = await IdempotencyKey.findOne({ where: { scope, key } });
  if (!existing) {
    // The row was created and removed between our INSERT and this SELECT;
    // treating it as a fresh attempt is safe because the caller will retry.
    throw new ConflictError('Please retry this request.', ErrorCode.CONFLICT);
  }

  if (existing.requestHash !== requestHash) {
    // Same key, different payload. This is a client bug, and silently serving
    // the first result would hide a real booking the caller thinks they made.
    throw new ConflictError(
      'This idempotency key has already been used with a different request body.',
      ErrorCode.IDEMPOTENCY_KEY_REUSED,
    );
  }

  if (existing.status === 'COMPLETED' && existing.responseBody) {
    return {
      replay: {
        status: existing.responseStatus ?? 200,
        body: existing.responseBody as Record<string, unknown>,
      },
      record: existing,
    };
  }

  if (existing.status === 'IN_PROGRESS') {
    throw new ConflictError(
      'An identical booking is already being processed. Please wait a moment and check your appointments.',
      ErrorCode.IDEMPOTENCY_IN_PROGRESS,
    );
  }

  // A previous attempt failed; let this one try again under the same key.
  await existing.update({ status: 'IN_PROGRESS', lockedAt: new Date() });
  return { replay: null, record: existing };
}

// ---------------------------------------------------------------------------
// Policy checks
// ---------------------------------------------------------------------------

/** Enforces per-customer and per-staff daily booking caps. */
async function assertBookingLimits(
  input: {
    businessId: string;
    businessTimezone: string;
    customerId: string | null;
    staffProfileId: string;
    serviceId: string;
    startsAt: Date;
  },
  policy: EffectivePolicy,
  transaction: Transaction,
): Promise<void> {
  const date = toIsoDateInZone(input.startsAt, input.businessTimezone);
  const dayStart = startOfDayInZone(date, input.businessTimezone);
  const dayEnd = endOfDayInZone(date, input.businessTimezone);

  if (policy.maxBookingsPerCustomerPerDay && input.customerId) {
    const count = await Appointment.count({
      where: {
        businessId: input.businessId,
        customerId: input.customerId,
        status: { [Op.in]: [...ACTIVE_APPOINTMENT_STATUSES] },
        startsAt: { [Op.gte]: dayStart, [Op.lt]: dayEnd },
      },
      transaction,
    });
    if (count >= policy.maxBookingsPerCustomerPerDay) {
      throw new PolicyViolationError(
        `You already have the maximum of ${policy.maxBookingsPerCustomerPerDay} booking(s) on that day.`,
        { limit: policy.maxBookingsPerCustomerPerDay, date },
      );
    }
  }

  if (policy.maxBookingsPerStaffPerDay) {
    const count = await Appointment.count({
      where: {
        businessId: input.businessId,
        staffProfileId: input.staffProfileId,
        status: { [Op.in]: [...ACTIVE_APPOINTMENT_STATUSES] },
        startsAt: { [Op.gte]: dayStart, [Op.lt]: dayEnd },
      },
      transaction,
    });
    if (count >= policy.maxBookingsPerStaffPerDay) {
      throw new PolicyViolationError('That provider is fully booked on the requested day.', {
        limit: policy.maxBookingsPerStaffPerDay,
        date,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Resource reservation
// ---------------------------------------------------------------------------

/**
 * Reserves everything a service requires.
 *
 * Single-capacity resources rely on the exclusion constraint. Shared resources
 * (capacity > 1) cannot — "at most N overlapping" is not expressible as an
 * exclusion — so those are counted under a row lock on the resource itself,
 * which serialises competing bookings for that resource.
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
): Promise<AppointmentResource[]> {
  const requirements = await ServiceResourceRequirement.findAll({
    where: { serviceId: input.serviceId },
    transaction,
  });
  if (requirements.length === 0) return [];

  const reserved: AppointmentResource[] = [];

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
        // leave the surrounding booking transaction usable so the next
        // candidate can be tried. Without it, PostgreSQL aborts the whole
        // transaction on the first constraint violation.
        const reservation = await sequelize.transaction({ transaction }, async (savepoint) =>
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
        reserved.push(reservation);
        remaining -= 1;
      } catch (error) {
        // Lost the race for this specific resource; try the next candidate
        // rather than failing the whole booking.
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
      // Optional requirement: proceed without it rather than block the booking.
      log.debug(
        { serviceId: input.serviceId, requirementId: requirement.id, shortfall: remaining },
        'optional resource requirement not fully satisfied',
      );
    }
  }

  return reserved;
}

// ---------------------------------------------------------------------------
// Customer resolution
// ---------------------------------------------------------------------------

async function resolveCustomer(
  input: CreateBookingInput,
  transaction: Transaction,
): Promise<Customer> {
  if (input.customer.id) {
    const existing = await Customer.findOne({
      where: { id: input.customer.id, businessId: input.businessId },
      transaction,
    });
    if (!existing) throw new NotFoundError('Customer');
    if (existing.status === 'BLOCKED') {
      throw new PolicyViolationError('This customer cannot make new bookings.');
    }
    return existing;
  }

  const email = input.customer.email.trim().toLowerCase();
  const existing = await Customer.findOne({
    where: { businessId: input.businessId, email },
    transaction,
  });
  if (existing) {
    if (existing.status === 'BLOCKED') {
      throw new PolicyViolationError('This customer cannot make new bookings.');
    }
    return existing;
  }

  return Customer.create(
    {
      businessId: input.businessId,
      publicId: newCustomerPublicId(),
      userId: null,
      firstName: input.customer.firstName.trim(),
      lastName: input.customer.lastName?.trim() ?? null,
      email,
      phone: input.customer.phone?.trim() ?? null,
      timezone: input.timezone,
      notes: null,
      preferredStaffProfileId: null,
      preferredLocationId: null,
      firstAppointmentAt: null,
      lastAppointmentAt: null,
    },
    { transaction },
  );
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

/** True for PostgreSQL SQLSTATE 23P01 — an exclusion constraint rejection. */
function isExclusionViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'SequelizeExclusionConstraintError') return true;
  const original = (error as { original?: { code?: string } }).original;
  return original?.code === '23P01';
}

/**
 * Turns a database-level overlap rejection into a domain error.
 *
 * Done here rather than only in the HTTP error handler so every caller —
 * background jobs, waitlist conversion, the socket layer — sees the same
 * meaningful failure instead of a raw Sequelize error.
 */
function translateBookingConflict(error: unknown): unknown {
  if (!isExclusionViolation(error)) return error;
  const constraint = (error as { original?: { constraint?: string }; constraint?: string }).original
    ?.constraint;

  if (constraint === 'appointment_resources_no_overlap') {
    return new ResourceUnavailableError(
      'A room or piece of equipment required for this booking was just reserved.',
      { conflict: 'resource' },
    );
  }
  return new SlotUnavailableError('That time was just taken. Please pick another slot.', {
    conflict: 'staff',
  });
}

/**
 * An existing session for this exact service, provider and start time that
 * still has a free place. Only meaningful for capacity > 1 services.
 */
async function findJoinableAppointment(input: CreateBookingInput): Promise<Appointment | null> {
  const existing = await Appointment.findOne({
    where: {
      businessId: input.businessId,
      serviceId: input.serviceId,
      staffProfileId: input.staffProfileId,
      startsAt: input.startsAt,
      status: { [Op.in]: [...ACTIVE_APPOINTMENT_STATUSES] },
    },
  });
  if (!existing) return null;
  // A full session is not joinable, but the caller still needs to know it
  // exists so it does not try to create a second one on top of it.
  return existing;
}

export async function createBooking(input: CreateBookingInput): Promise<BookingResult> {
  if (!isValidTimezone(input.timezone)) {
    throw new ValidationError('Invalid timezone.', [
      { field: 'timezone', message: 'Must be an IANA timezone identifier.' },
    ]);
  }

  const business = await Business.findByPk(input.businessId);
  if (!business || business.status !== 'ACTIVE') throw new NotFoundError('Workspace');

  // Loaded up front because `capacity` decides whether this is a "create a new
  // appointment" or a "join an existing session" booking, and the two follow
  // different validation paths.
  const service = await Service.findOne({
    where: { id: input.serviceId, businessId: input.businessId, isActive: true },
  });
  if (!service) throw new NotFoundError('Service');

  // --- Idempotency claim -------------------------------------------------
  const requestHash = canonicalHash({
    businessId: input.businessId,
    serviceId: input.serviceId,
    staffProfileId: input.staffProfileId,
    locationId: input.locationId ?? null,
    startsAt: input.startsAt.toISOString(),
    email: input.customer.email.trim().toLowerCase(),
  });

  let idempotencyRecord: IdempotencyKey | null = null;
  if (input.idempotencyKey) {
    const outcome = await claimIdempotencyKey(
      BOOKING_IDEMPOTENCY_SCOPE,
      input.idempotencyKey,
      input.businessId,
      requestHash,
    );
    if (outcome.replay) {
      const appointmentId = (outcome.record?.resourceId ?? null) as string | null;
      const appointment = appointmentId ? await Appointment.findByPk(appointmentId) : null;
      if (appointment) {
        const participant = await AppointmentParticipant.findOne({
          where: { appointmentId: appointment.id },
        });
        const customer = appointment.customerId
          ? await Customer.findByPk(appointment.customerId)
          : null;
        if (participant && customer) {
          log.info({ idempotencyKey: input.idempotencyKey }, 'replaying idempotent booking');
          return { appointment, participant, customer, replayed: true };
        }
      }
    }
    idempotencyRecord = outcome.record;
  }

  const lockKey = RedisKeys.appointmentSlotLock(
    input.businessId,
    input.staffProfileId,
    input.startsAt.toISOString(),
  );

  const attemptBooking = async (): Promise<BookingResult> => {
    // A group session that already exists and still has room is joined, not
    // rebooked. Slot verification is skipped for that path on purpose: the
    // session holds its own staff reservation, so re-verifying would find that
    // reservation and refuse to let anyone join the class. The notice and
    // horizon checks go with it — the session cleared both when it was created,
    // and turning a later policy change into "you may not join a class that is
    // already in the diary" would punish the wrong person.
    const joinable = service.capacity > 1 ? await findJoinableAppointment(input) : null;

    let policy: EffectivePolicy;
    if (joinable) {
      policy = await getPolicyFor({
        businessId: input.businessId,
        serviceId: input.serviceId,
        staffProfileId: input.staffProfileId,
      });
    } else {
      const verdict = await verifySlot({
        businessId: input.businessId,
        businessTimezone: business.timezone,
        serviceId: input.serviceId,
        staffProfileId: input.staffProfileId,
        locationId: input.locationId ?? null,
        startsAt: input.startsAt,
        // The caller's own zone, which is also the zone their availability
        // search ran in. The booking horizon is counted in calendar days, so
        // confirmation has to read the date exactly as the search did or the
        // furthest slot on offer could be refused the moment it is booked.
        timezone: input.timezone,
      });
      if (!verdict.ok) {
        throw new SlotUnavailableError(verdict.reason ?? 'That time is no longer available.');
      }
      policy = verdict.policy;
    }

    const endsAt = addMinutes(input.startsAt, policy.durationMinutes);
    const bufferStartAt = addMinutes(input.startsAt, -policy.preBufferMinutes);
    const bufferEndAt = addMinutes(endsAt, policy.postBufferMinutes);

    return withLock(lockKey, 10_000, async () =>
      sequelize.transaction(async (transaction) => {
        const service = await Service.findOne({
          where: { id: input.serviceId, businessId: input.businessId },
          transaction,
        });
        if (!service) throw new NotFoundError('Service');

        const staffProfile = await StaffProfile.findOne({
          where: { id: input.staffProfileId, businessId: input.businessId },
          transaction,
        });
        if (!staffProfile) throw new NotFoundError('Staff member');

        const customer = await resolveCustomer(input, transaction);

        await assertBookingLimits(
          {
            businessId: input.businessId,
            businessTimezone: business.timezone,
            customerId: customer.id,
            staffProfileId: input.staffProfileId,
            serviceId: input.serviceId,
            startsAt: input.startsAt,
          },
          policy,
          transaction,
        );

        const requiresApproval = policy.requiresApproval;
        const initialStatus = requiresApproval ? 'PENDING' : 'CONFIRMED';

        // --- Group services: join an existing class if one has room --------
        let appointment: Appointment | null = null;
        let joinedExisting = false;

        if (service.capacity > 1) {
          const existing = await Appointment.findOne({
            where: {
              businessId: input.businessId,
              serviceId: service.id,
              staffProfileId: input.staffProfileId,
              startsAt: input.startsAt,
              status: { [Op.in]: [...ACTIVE_APPOINTMENT_STATUSES] },
            },
            transaction,
            // Serialises capacity increments: two customers claiming the last
            // place cannot both read `bookedCount` before either writes.
            lock: transaction.LOCK.UPDATE,
          });

          if (existing) {
            if (existing.bookedCount >= existing.capacity) {
              throw new ConflictError('That session is now full.', ErrorCode.CAPACITY_EXCEEDED, {
                capacity: existing.capacity,
              });
            }
            const alreadyBooked = await AppointmentParticipant.findOne({
              where: {
                appointmentId: existing.id,
                customerId: customer.id,
                status: { [Op.ne]: 'CANCELLED' },
              },
              transaction,
            });
            if (alreadyBooked) {
              throw new ConflictError(
                'You already have a place in that session.',
                ErrorCode.ALREADY_EXISTS,
              );
            }
            appointment = existing;
            joinedExisting = true;
          }
        }

        if (!appointment) {
          appointment = await Appointment.create(
            {
              publicId: newAppointmentPublicId(),
              businessId: input.businessId,
              serviceId: service.id,
              locationId: input.locationId ?? staffProfile.defaultLocationId ?? null,
              staffProfileId: input.staffProfileId,
              teamId: null,
              customerId: customer.id,
              bookingLinkId: input.bookingLinkId ?? null,
              status: initialStatus,
              startsAt: input.startsAt,
              endsAt,
              bufferStartAt,
              bufferEndAt,
              durationMinutes: policy.durationMinutes,
              preBufferMinutes: policy.preBufferMinutes,
              postBufferMinutes: policy.postBufferMinutes,
              timezone: input.timezone,
              capacity: service.capacity,
              bookedCount: 0,
              priceAmount: policy.priceAmount,
              currency: policy.currency,
              source: input.source,
              title: service.name,
              customerNotes: input.customerNotes ?? null,
              internalNotes: input.internalNotes ?? null,
              answers: input.answers ?? {},
              requiresApproval,
              confirmedAt: requiresApproval ? null : new Date(),
              cancellationReason: null,
              cancelledByType: null,
              cancelledByUserId: null,
              rescheduledFromId: null,
              idempotencyKey: input.idempotencyKey ?? null,
              createdByUserId: input.actor.userId ?? null,
              checkedInAt: null,
              startedAt: null,
              completedAt: null,
              cancelledAt: null,
              noShowAt: null,
            },
            { transaction },
          );

          // The staff reservation is what the exclusion constraint guards. If
          // another transaction committed the same slot first, this INSERT
          // fails with 23P01 and the whole booking rolls back.
          await AppointmentStaff.create(
            {
              appointmentId: appointment.id,
              staffProfileId: input.staffProfileId,
              role: 'PRIMARY',
              startsAt: bufferStartAt,
              endsAt: bufferEndAt,
              isBlocking: true,
            },
            { transaction },
          );

          await reserveResources(
            {
              businessId: input.businessId,
              serviceId: service.id,
              locationId: appointment.locationId,
              appointmentId: appointment.id,
              bufferStartAt,
              bufferEndAt,
            },
            transaction,
          );
        }

        const participant = await AppointmentParticipant.create(
          {
            appointmentId: appointment.id,
            customerId: customer.id,
            publicId: newParticipantPublicId(),
            role: joinedExisting ? 'ATTENDEE' : 'ORGANIZER',
            status: 'BOOKED',
            answers: input.answers ?? {},
            cancelledAt: null,
          },
          { transaction },
        );

        await appointment.update({ bookedCount: appointment.bookedCount + 1 }, { transaction });

        await AppointmentStatusHistory.create(
          {
            appointmentId: appointment.id,
            businessId: input.businessId,
            fromStatus: joinedExisting ? appointment.status : null,
            toStatus: appointment.status,
            actorType: input.actor.type,
            actorUserId: input.actor.userId ?? null,
            actorLabel: input.actor.label ?? customer.email,
            reason: joinedExisting ? 'Joined an existing session.' : 'Booking created.',
            metadata: { source: input.source },
          },
          { transaction },
        );

        // Round-robin fairness cursor. Advisory only — it is recomputed from
        // appointments if it is ever lost.
        await staffProfile.update({ lastAssignedAt: new Date() }, { transaction });

        await customer.update(
          {
            totalBookings: customer.totalBookings + 1,
            firstAppointmentAt: customer.firstAppointmentAt ?? input.startsAt,
            lastAppointmentAt:
              !customer.lastAppointmentAt || input.startsAt > customer.lastAppointmentAt
                ? input.startsAt
                : customer.lastAppointmentAt,
          },
          { transaction },
        );

        if (input.bookingLinkId) {
          await BookingLink.increment('bookingCount', {
            by: 1,
            where: { id: input.bookingLinkId, businessId: input.businessId },
            transaction,
          });
        }

        await recordAudit(
          {
            businessId: input.businessId,
            actorType: input.actor.type === 'CUSTOMER' ? 'CUSTOMER' : 'USER',
            actorUserId: input.actor.userId ?? null,
            actorCustomerId: input.actor.type === 'CUSTOMER' ? customer.id : null,
            actorLabel: input.actor.label ?? customer.email,
            action: AuditActions.APPOINTMENT_CREATED,
            entityType: 'appointment',
            entityId: appointment.id,
            requestId: input.requestMetadata?.requestId,
            ipAddress: input.requestMetadata?.ipAddress,
            userAgent: input.requestMetadata?.userAgent,
            metadata: {
              publicId: appointment.publicId,
              serviceId: service.id,
              staffProfileId: input.staffProfileId,
              startsAt: appointment.startsAt,
              source: input.source,
              joinedExisting,
            },
          },
          { transaction },
        );

        await enqueueBookingNotifications(
          { appointment, customer, service, staffProfile, business, policy },
          transaction,
        );

        // Subscribers learn about a booking on exactly the terms the customer
        // does: the delivery rows are written inside this transaction, so a
        // rollback — including the lost create-race retried above — takes them
        // with it, and the queue is only touched after the commit.
        await publishAppointmentWebhook(WebhookEvents.APPOINTMENT_CREATED, appointment, {
          transaction,
          // A group session announces one event per attendee who joins it, as
          // the socket layer does; the participant is what tells a subscriber
          // which of the two it just heard about.
          extra: { joinedExisting, participantId: participant.id },
        });

        if (idempotencyRecord) {
          await idempotencyRecord.update(
            {
              status: 'COMPLETED',
              responseStatus: 201,
              responseBody: { appointmentId: appointment.id, publicId: appointment.publicId },
              resourceType: 'appointment',
              resourceId: appointment.id,
              completedAt: new Date(),
            },
            { transaction },
          );
        }

        return { appointment, participant, customer, replayed: false };
      }),
    );
  };

  let result: BookingResult;
  try {
    try {
      result = await attemptBooking();
    } catch (error) {
      // Create-or-join race on a group service: two customers found no session
      // and both tried to create one. The exclusion constraint rejected this
      // transaction, which means the session now exists — retry once and the
      // second attempt joins it. Single-capacity services never retry: for them
      // a lost race genuinely means the slot is gone.
      if (service.capacity > 1 && isExclusionViolation(error)) {
        log.debug(
          { serviceId: service.id, startsAt: input.startsAt },
          'lost the create race for a group session — retrying as a join',
        );
        result = await attemptBooking();
      } else {
        throw error;
      }
    }

    // --- Announce only after the commit ------------------------------------
    emitAppointmentEvent(
      SocketEvents.appointmentCreated,
      {
        businessId: result.appointment.businessId,
        staffProfileId: result.appointment.staffProfileId,
        appointmentId: result.appointment.id,
      },
      {
        appointmentId: result.appointment.id,
        publicId: result.appointment.publicId,
        status: result.appointment.status,
        startsAt: result.appointment.startsAt,
        endsAt: result.appointment.endsAt,
        serviceId: result.appointment.serviceId,
        staffProfileId: result.appointment.staffProfileId,
        customerName: `${result.customer.firstName} ${result.customer.lastName ?? ''}`.trim(),
      },
    );
    emitToWorkspace(result.appointment.businessId, SocketEvents.dashboardMetricsUpdated, {
      reason: 'appointment.created',
    });

    log.info(
      {
        appointmentId: result.appointment.id,
        businessId: result.appointment.businessId,
        startsAt: result.appointment.startsAt,
      },
      'appointment booked',
    );

    return result;
  } catch (error) {
    if (idempotencyRecord) {
      await idempotencyRecord
        .update({ status: 'FAILED', completedAt: new Date() })
        .catch(() => undefined);
    }
    throw translateBookingConflict(error);
  }
}

/**
 * Writes the confirmation and reminder rows into the notification outbox.
 *
 * Inside the booking transaction on purpose: a rolled-back booking must not
 * leave a confirmation behind, and a committed one must not lose its reminders.
 */
async function enqueueBookingNotifications(
  context: {
    appointment: Appointment;
    customer: Customer;
    service: Service;
    staffProfile: StaffProfile;
    business: Business;
    policy: EffectivePolicy;
  },
  transaction: Transaction,
): Promise<void> {
  const { appointment, customer, service, staffProfile, business } = context;

  const location = appointment.locationId
    ? await Location.findByPk(appointment.locationId, { transaction })
    : null;

  const manageUrl = `${env.PUBLIC_APP_URL}/appointments/${appointment.publicId}`;
  const payload = {
    customerName: `${customer.firstName} ${customer.lastName ?? ''}`.trim(),
    businessName: business.name,
    serviceName: service.name,
    staffName: staffProfile.displayName,
    locationName: location?.name ?? 'Online',
    startsAtLocal: formatForHumans(appointment.startsAt, customer.timezone || appointment.timezone),
    timezone: customer.timezone || appointment.timezone,
    durationMinutes: appointment.durationMinutes,
    manageUrl,
    bookingUrl: `${env.PUBLIC_APP_URL}/b/${business.slug}`,
    dashboardUrl: `${env.PUBLIC_APP_URL}/app/schedule`,
  };

  await enqueueNotification(
    {
      businessId: business.id,
      type: appointment.status === 'PENDING' ? 'BOOKING_PENDING_APPROVAL' : 'BOOKING_CONFIRMATION',
      recipientType: 'CUSTOMER',
      recipientCustomerId: customer.id,
      recipientAddress: customer.email,
      appointmentId: appointment.id,
      payload,
      // One confirmation per appointment, whatever retries happen upstream.
      dedupeKey: `confirm:${appointment.id}:${customer.id}`,
    },
    { transaction },
  );

  // Reminders are notifications scheduled in the future. Offsets that already
  // fall in the past are skipped rather than sent immediately.
  const offsets = await getReminderOffsets(business.id, transaction);
  for (const offsetMinutes of offsets) {
    const scheduledFor = addMinutes(appointment.startsAt, -offsetMinutes);
    if (scheduledFor.getTime() <= Date.now()) continue;

    await enqueueNotification(
      {
        businessId: business.id,
        type: 'APPOINTMENT_REMINDER',
        recipientType: 'CUSTOMER',
        recipientCustomerId: customer.id,
        recipientAddress: customer.email,
        appointmentId: appointment.id,
        payload,
        scheduledFor,
        dedupeKey: `remind:${appointment.id}:${customer.id}:${offsetMinutes}`,
      },
      { transaction },
    );
  }

  // Tell the provider, so a staff member who is not watching the dashboard
  // still learns about a new booking.
  const staffUser = await StaffProfile.findByPk(staffProfile.id, {
    include: [{ association: 'user', attributes: ['id', 'email'] }],
    transaction,
  });
  const user = staffUser?.get('user') as { id: string; email: string } | undefined;
  if (user?.email) {
    await enqueueNotification(
      {
        businessId: business.id,
        type: 'STAFF_ASSIGNED',
        recipientType: 'STAFF',
        recipientUserId: user.id,
        recipientAddress: user.email,
        appointmentId: appointment.id,
        payload,
        dedupeKey: `staff-assigned:${appointment.id}:${user.id}`,
      },
      { transaction },
    );
  }
}

/** Reminder offsets configured for the workspace, furthest-out first. */
async function getReminderOffsets(businessId: string, transaction: Transaction): Promise<number[]> {
  const settings = await BusinessSettings.findByPk(businessId, { transaction });
  return settings?.reminderOffsetsMinutes ?? [1440, 60];
}
