/**
 * Waitlist entries — a customer's standing request for a slot that does not
 * exist yet.
 *
 * Four rules shape every function here:
 *
 *  1. `businessId` is always the first parameter and always comes from the
 *     caller's proven membership. Another workspace's entry, and one that was
 *     never created, produce the same 404 — a 403 would confirm the id is real
 *     and turn these endpoints into an existence oracle.
 *  2. Every referenced row (customer, service, provider, location) is resolved
 *     under the same tenant filter, so a body cannot reach across tenants by
 *     naming a foreign id.
 *  3. The matcher owns `status`, `notifiedAt`, `notificationCount`,
 *     `heldSlotStartsAt`, `holdExpiresAt` and `convertedAppointmentId`. Nothing
 *     a client sends can write them; the only transitions this file performs
 *     are the deliberate ones behind `DELETE`, `/notify` and `/convert`.
 *  4. An entry is never hard-deleted. CANCELLED and EXPIRED are terminal states
 *     that stay visible, so a customer can always be told why they were never
 *     called.
 */
import { UniqueConstraintError, type Transaction } from 'sequelize';
import { sequelize } from '../../config/database';
import { createLogger } from '../../config/logger';
import {
  Appointment,
  Business,
  BusinessSettings,
  Customer,
  Location,
  Service,
  StaffProfile,
  WaitlistEntry,
} from '../../database/models';
import { searchAvailability } from '../../scheduling/availability.service';
import {
  ConflictError,
  ErrorCode,
  NotFoundError,
  PolicyViolationError,
  SlotUnavailableError,
  ValidationError,
} from '../../utils/errors';
import { newWaitlistPublicId } from '../../utils/ids';
import { isValidTimezone, toIsoDateInZone } from '../../utils/time';
import { createBooking } from '../appointments/booking.service';
import { AuditActions, recordAudit } from '../audit/audit.service';
import type { RequestMetadata } from '../auth/auth.service';
import { enqueueNotification } from '../notifications/notification.service';
import { offerSlotToEntry } from './waitlist.matcher';
import type {
  CreateWaitlistEntryBody,
  ListWaitlistQuery,
  UpdateWaitlistEntryBody,
} from './waitlist.validation';

const log = createLogger('waitlist');

/** The states an entry can still be worked on from. Everything else is terminal. */
const LIVE_STATUSES = ['ACTIVE', 'NOTIFIED'] as const;

const CUSTOMER_ATTRIBUTES = [
  'id',
  'publicId',
  'firstName',
  'lastName',
  'email',
  'phone',
  'timezone',
] as const;
const SERVICE_ATTRIBUTES = ['id', 'name', 'slug', 'durationMinutes'] as const;
const STAFF_ATTRIBUTES = ['id', 'displayName'] as const;
const LOCATION_ATTRIBUTES = ['id', 'name', 'timezone'] as const;
const APPOINTMENT_ATTRIBUTES = ['id', 'publicId', 'status', 'startsAt', 'endsAt'] as const;

/** Joined into every read so a row is readable without a second call. */
const ENTRY_INCLUDES = [
  { model: Customer, as: 'customer', attributes: [...CUSTOMER_ATTRIBUTES] },
  { model: Service, as: 'service', attributes: [...SERVICE_ATTRIBUTES] },
  { model: StaffProfile, as: 'staffProfile', attributes: [...STAFF_ATTRIBUTES] },
  { model: Location, as: 'location', attributes: [...LOCATION_ATTRIBUTES] },
  { model: Appointment, as: 'convertedAppointment', attributes: [...APPOINTMENT_ATTRIBUTES] },
];

export interface WaitlistActor {
  userId: string;
  email: string;
  /**
   * How a booking made by converting an entry is attributed. Resolved at the
   * HTTP boundary from the caller's role, exactly as the appointments module
   * does, so the service never needs to know how roles are stored.
   */
  type: 'OWNER' | 'STAFF';
}

export interface WaitlistPage {
  rows: WaitlistEntry[];
  totalItems: number;
}

export interface WaitlistConversion {
  entry: WaitlistEntry;
  appointment: Appointment;
}

// ---------------------------------------------------------------------------
// Lookups and guards
// ---------------------------------------------------------------------------

/**
 * The one place an entry is loaded by id. Scoped by `businessId` so a foreign
 * id and a nonexistent id produce the same answer.
 */
async function findEntryOrThrow(
  businessId: string,
  entryId: string,
  transaction?: Transaction,
): Promise<WaitlistEntry> {
  const entry = await WaitlistEntry.findOne({
    where: { id: entryId, businessId },
    transaction,
  });
  if (!entry) throw new NotFoundError('Waitlist entry');
  return entry;
}

/** Reloads an entry with its relations, for the shape the API returns. */
async function loadEntryDetail(businessId: string, entryId: string): Promise<WaitlistEntry> {
  const entry = await WaitlistEntry.findOne({
    where: { id: entryId, businessId },
    include: ENTRY_INCLUDES,
  });
  if (!entry) throw new NotFoundError('Waitlist entry');
  return entry;
}

function assertLive(entry: WaitlistEntry): void {
  if (!(LIVE_STATUSES as readonly string[]).includes(entry.status)) {
    throw new ConflictError(
      `This waitlist entry is ${entry.status.toLowerCase()} and can no longer be changed.`,
      ErrorCode.INVALID_STATE_TRANSITION,
      { status: entry.status },
    );
  }
}

function assertTimezone(zone: string): void {
  if (!isValidTimezone(zone)) {
    throw new ValidationError('Invalid timezone.', [
      {
        field: 'timezone',
        message: 'Must be an IANA timezone identifier such as Asia/Kolkata, not a UTC offset.',
      },
    ]);
  }
}

/**
 * The merged window must still describe a real span of time.
 *
 * Checked here rather than only in the schema because a PATCH may carry one
 * half of a pair — raising `earliestMinute` above an untouched `latestMinute`
 * would otherwise reach the column CHECK and surface as a database error.
 */
function assertWindowCoherent(window: {
  earliestDate: string;
  latestDate: string;
  earliestMinute: number;
  latestMinute: number;
}): void {
  if (window.latestDate < window.earliestDate) {
    throw new ValidationError('The waitlist window is inside out.', [
      { field: 'latestDate', message: 'The end of the window cannot precede its start.' },
    ]);
  }
  if (window.latestMinute <= window.earliestMinute) {
    throw new ValidationError('The daily window is inside out.', [
      { field: 'latestMinute', message: 'The end of the daily window must be after its start.' },
    ]);
  }
}

/** Every referenced row must live in this tenant, or it is a 404 like any other. */
async function assertTargetsInBusiness(
  businessId: string,
  targets: { staffProfileId?: string | null; locationId?: string | null },
  transaction: Transaction,
): Promise<void> {
  if (targets.staffProfileId) {
    const staffProfile = await StaffProfile.findOne({
      where: { id: targets.staffProfileId, businessId },
      attributes: ['id'],
      transaction,
    });
    if (!staffProfile) throw new NotFoundError('Staff profile');
  }

  if (targets.locationId) {
    const location = await Location.findOne({
      where: { id: targets.locationId, businessId },
      attributes: ['id'],
      transaction,
    });
    if (!location) throw new NotFoundError('Location');
  }
}

/** The workspace's hold length, creating the settings row if it is missing. */
async function holdMinutesFor(businessId: string): Promise<number> {
  const [settings] = await BusinessSettings.findOrCreate({
    where: { businessId },
    defaults: { businessId },
  });
  return settings.waitlistHoldMinutes;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listWaitlistEntries(
  businessId: string,
  query: ListWaitlistQuery,
): Promise<WaitlistPage> {
  const { rows, count } = await WaitlistEntry.findAndCountAll({
    where: {
      businessId,
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.serviceId !== undefined ? { serviceId: query.serviceId } : {}),
    },
    include: ENTRY_INCLUDES,
    // The queue as the matcher sees it, so the list and the engine agree on who
    // is next: priority first, then arrival order.
    order: [
      ['priority', 'ASC'],
      ['createdAt', 'ASC'],
    ],
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
    // The includes are all belongsTo, so no row is multiplied and COUNT stays
    // truthful without the (much slower) distinct sub-select.
    distinct: false,
  });

  return { rows, totalItems: count };
}

export async function getWaitlistEntry(
  businessId: string,
  entryId: string,
): Promise<WaitlistEntry> {
  return loadEntryDetail(businessId, entryId);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createWaitlistEntry(
  businessId: string,
  input: CreateWaitlistEntryBody,
  actor: WaitlistActor,
  metadata: RequestMetadata,
): Promise<WaitlistEntry> {
  if (input.timezone !== undefined) assertTimezone(input.timezone);

  const entry = await sequelize.transaction(async (transaction) => {
    const business = await Business.findByPk(businessId, {
      attributes: ['id', 'name'],
      transaction,
    });
    if (!business) throw new NotFoundError('Workspace');

    const customer = await Customer.findOne({
      where: { id: input.customerId, businessId },
      transaction,
    });
    if (!customer) throw new NotFoundError('Customer');
    if (!customer.isBookable) {
      throw new PolicyViolationError('This customer cannot join a waitlist.', {
        status: customer.status,
      });
    }

    // Inactive services are invisible to booking and availability alike, so a
    // waitlist against one could never be matched.
    const service = await Service.findOne({
      where: { id: input.serviceId, businessId, isActive: true },
      transaction,
    });
    if (!service) throw new NotFoundError('Service');

    await assertTargetsInBusiness(
      businessId,
      { staffProfileId: input.staffProfileId, locationId: input.locationId },
      transaction,
    );

    // A window with no zone follows the customer's own clock. Falling through
    // to the column default would make it UTC, which is wrong everywhere but
    // one meridian and invisible until the wrong slots start being offered.
    const timezone = input.timezone ?? customer.timezone;
    assertTimezone(timezone);
    assertWindowCoherent({
      earliestDate: input.earliestDate,
      latestDate: input.latestDate,
      earliestMinute: input.earliestMinute,
      latestMinute: input.latestMinute,
    });

    const created = await insertEntry(
      {
        businessId,
        customerId: customer.id,
        serviceId: service.id,
        timezone,
        input,
      },
      transaction,
    );

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.WAITLIST_CREATED,
        entityType: 'waitlist_entry',
        entityId: created.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          publicId: created.publicId,
          customerId: customer.id,
          serviceId: service.id,
          earliestDate: created.earliestDate,
          latestDate: created.latestDate,
          timezone,
          priority: created.priority,
        },
      },
      { transaction },
    );

    if (created.notifyChannel !== 'NONE') {
      await enqueueNotification(
        {
          businessId,
          type: 'WAITLIST_CONFIRMED',
          // SMS has neither a template nor a provider yet (see
          // notification.processor.ts), so the acknowledgement goes by email.
          channel: 'EMAIL',
          recipientType: 'CUSTOMER',
          recipientCustomerId: customer.id,
          recipientAddress: customer.email,
          waitlistEntryId: created.id,
          payload: {
            customerName: customer.fullName,
            businessName: business.name,
            serviceName: service.name,
            earliestDate: created.earliestDate,
            latestDate: created.latestDate,
            timezone,
          },
          // One acknowledgement per entry, however the request is retried.
          dedupeKey: `waitlist-confirmed:${created.id}`,
        },
        { transaction },
      );
    }

    log.info(
      { businessId, waitlistEntryId: created.id, serviceId: service.id },
      'waitlist entry created',
    );
    return created;
  });

  return loadEntryDetail(businessId, entry.id);
}

/**
 * The INSERT, with the duplicate rule left to the database.
 *
 * `waitlist_active_unique` allows one live entry per (workspace, customer,
 * service). A SELECT-then-INSERT pre-check cannot enforce that — two concurrent
 * requests would both read "no duplicate" — so the constraint is the only
 * authority, and catching it here turns the loser into a 409 the client can act
 * on rather than a 500.
 */
async function insertEntry(
  context: {
    businessId: string;
    customerId: string;
    serviceId: string;
    timezone: string;
    input: CreateWaitlistEntryBody;
  },
  transaction: Transaction,
): Promise<WaitlistEntry> {
  const { input } = context;

  try {
    return await WaitlistEntry.create(
      {
        publicId: newWaitlistPublicId(),
        businessId: context.businessId,
        customerId: context.customerId,
        serviceId: context.serviceId,
        staffProfileId: input.staffProfileId ?? null,
        locationId: input.locationId ?? null,
        earliestDate: input.earliestDate,
        latestDate: input.latestDate,
        earliestMinute: input.earliestMinute,
        latestMinute: input.latestMinute,
        daysOfWeek: input.daysOfWeek,
        timezone: context.timezone,
        status: 'ACTIVE',
        priority: input.priority,
        notifyChannel: input.notifyChannel,
        notifiedAt: null,
        notificationCount: 0,
        holdExpiresAt: null,
        heldSlotStartsAt: null,
        convertedAppointmentId: null,
        expiresAt: input.expiresAt ?? null,
        note: input.note ?? null,
      },
      { transaction },
    );
  } catch (error) {
    if (error instanceof UniqueConstraintError) {
      throw new ConflictError(
        'This customer is already on the waitlist for that service.',
        ErrorCode.ALREADY_EXISTS,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateWaitlistEntry(
  businessId: string,
  entryId: string,
  input: UpdateWaitlistEntryBody,
  actor: WaitlistActor,
  metadata: RequestMetadata,
): Promise<WaitlistEntry> {
  if (input.timezone !== undefined) assertTimezone(input.timezone);

  await sequelize.transaction(async (transaction) => {
    const entry = await findEntryOrThrow(businessId, entryId, transaction);
    assertLive(entry);

    await assertTargetsInBusiness(
      businessId,
      { staffProfileId: input.staffProfileId, locationId: input.locationId },
      transaction,
    );

    assertWindowCoherent({
      earliestDate: input.earliestDate ?? entry.earliestDate,
      latestDate: input.latestDate ?? entry.latestDate,
      earliestMinute: input.earliestMinute ?? entry.earliestMinute,
      latestMinute: input.latestMinute ?? entry.latestMinute,
    });

    // A hold was placed against the *old* criteria. If those criteria change,
    // the held opening may no longer be one this customer asked for — and it
    // would keep blocking everyone else until it lapsed. Releasing it puts the
    // entry back in the queue under its new terms.
    const releaseHold = entry.hasActiveHold && criteriaChanged(entry, input);

    const before = {
      earliestDate: entry.earliestDate,
      latestDate: entry.latestDate,
      earliestMinute: entry.earliestMinute,
      latestMinute: entry.latestMinute,
      daysOfWeek: entry.daysOfWeek,
      timezone: entry.timezone,
      staffProfileId: entry.staffProfileId,
      locationId: entry.locationId,
      priority: entry.priority,
      notifyChannel: entry.notifyChannel,
      status: entry.status,
    };

    await entry.update(
      {
        ...(input.staffProfileId !== undefined ? { staffProfileId: input.staffProfileId } : {}),
        ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
        ...(input.earliestDate !== undefined ? { earliestDate: input.earliestDate } : {}),
        ...(input.latestDate !== undefined ? { latestDate: input.latestDate } : {}),
        ...(input.earliestMinute !== undefined ? { earliestMinute: input.earliestMinute } : {}),
        ...(input.latestMinute !== undefined ? { latestMinute: input.latestMinute } : {}),
        ...(input.daysOfWeek !== undefined ? { daysOfWeek: input.daysOfWeek } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.notifyChannel !== undefined ? { notifyChannel: input.notifyChannel } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(releaseHold
          ? { status: 'ACTIVE' as const, holdExpiresAt: null, heldSlotStartsAt: null }
          : {}),
      },
      { transaction },
    );

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        // The catalogue has no `waitlist.updated` action and this module may not
        // add one. An edit is a restatement of the same standing request — which
        // is exactly what the partial unique index enforces — so it is recorded
        // under the same action, with the changed fields spelled out.
        action: AuditActions.WAITLIST_CREATED,
        entityType: 'waitlist_entry',
        entityId: entry.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          changed: Object.keys(input),
          holdReleased: releaseHold,
          before,
          after: {
            earliestDate: entry.earliestDate,
            latestDate: entry.latestDate,
            earliestMinute: entry.earliestMinute,
            latestMinute: entry.latestMinute,
            daysOfWeek: entry.daysOfWeek,
            timezone: entry.timezone,
            staffProfileId: entry.staffProfileId,
            locationId: entry.locationId,
            priority: entry.priority,
            notifyChannel: entry.notifyChannel,
            status: entry.status,
          },
        },
      },
      { transaction },
    );
  });

  return loadEntryDetail(businessId, entryId);
}

/** True when the patch alters anything the held opening was matched against. */
function criteriaChanged(entry: WaitlistEntry, input: UpdateWaitlistEntryBody): boolean {
  if (input.earliestDate !== undefined && input.earliestDate !== entry.earliestDate) return true;
  if (input.latestDate !== undefined && input.latestDate !== entry.latestDate) return true;
  if (input.earliestMinute !== undefined && input.earliestMinute !== entry.earliestMinute) {
    return true;
  }
  if (input.latestMinute !== undefined && input.latestMinute !== entry.latestMinute) return true;
  if (input.timezone !== undefined && input.timezone !== entry.timezone) return true;
  if (
    input.staffProfileId !== undefined &&
    (input.staffProfileId ?? null) !== entry.staffProfileId
  ) {
    return true;
  }
  if (input.locationId !== undefined && (input.locationId ?? null) !== entry.locationId) {
    return true;
  }
  if (input.daysOfWeek !== undefined) {
    const next = [...input.daysOfWeek].sort((a, b) => a - b).join(',');
    const current = [...entry.daysOfWeek].sort((a, b) => a - b).join(',');
    if (next !== current) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/**
 * Withdraws a request.
 *
 * Not a row delete: the model is not paranoid, and CANCELLED is a terminal
 * state the customer and the front desk both need to be able to read back.
 * Cancelling an already-cancelled entry is a no-op rather than an error, so a
 * repeated DELETE behaves the way a client expects.
 */
export async function cancelWaitlistEntry(
  businessId: string,
  entryId: string,
  actor: WaitlistActor,
  metadata: RequestMetadata,
): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    const entry = await findEntryOrThrow(businessId, entryId, transaction);
    if (entry.status === 'CANCELLED') return;
    assertLive(entry);

    const previousStatus = entry.status;
    await entry.update(
      {
        status: 'CANCELLED',
        holdExpiresAt: null,
        heldSlotStartsAt: null,
      },
      { transaction },
    );

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.WAITLIST_CANCELLED,
        entityType: 'waitlist_entry',
        entityId: entry.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          publicId: entry.publicId,
          previousStatus,
          releasedHold: previousStatus === 'NOTIFIED',
        },
      },
      { transaction },
    );

    log.info({ businessId, waitlistEntryId: entry.id }, 'waitlist entry cancelled');
  });
}

// ---------------------------------------------------------------------------
// Manual offer
// ---------------------------------------------------------------------------

/**
 * Re-sends the offer for the opening this entry currently holds, and extends
 * the hold from now.
 *
 * There has to be an opening to offer: an entry with no held slot has never
 * been matched, or its hold already lapsed and the maintenance sweep released
 * it. Inventing a time here would promise the customer something no part of the
 * system has checked is free.
 */
export async function notifyWaitlistEntry(
  businessId: string,
  entryId: string,
  actor: WaitlistActor,
  metadata: RequestMetadata,
): Promise<WaitlistEntry> {
  const entry = await findEntryOrThrow(businessId, entryId);
  assertLive(entry);

  const heldSlotStartsAt = entry.heldSlotStartsAt;
  if (!heldSlotStartsAt) {
    throw new ConflictError(
      'This entry is not holding an opening, so there is nothing to offer yet.',
      ErrorCode.CONFLICT,
      { status: entry.status },
    );
  }

  await offerSlotToEntry({
    entry,
    startsAt: heldSlotStartsAt,
    // The duration is not stored with the hold; the event carries the start,
    // which is what a dashboard needs to point at the opening.
    endsAt: null,
    holdMinutes: await holdMinutesFor(businessId),
    actor: { actorType: 'USER', userId: actor.userId, label: actor.email },
    metadata,
  });

  return loadEntryDetail(businessId, entryId);
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * Turns a waitlist request into a real appointment.
 *
 * The booking goes through `createBooking` like every other one, so the slot is
 * re-verified against live data, the exclusion constraints still have the final
 * word, and the customer gets the same confirmation as any other booking. This
 * function's own job is only to mark the request satisfied and point it at the
 * appointment that satisfied it.
 */
export async function convertWaitlistEntry(
  businessId: string,
  entryId: string,
  startsAt: Date,
  actor: WaitlistActor,
  metadata: RequestMetadata,
): Promise<WaitlistConversion> {
  const entry = await findEntryOrThrow(businessId, entryId);
  assertLive(entry);

  const business = await Business.findByPk(businessId, { attributes: ['id', 'timezone'] });
  if (!business) throw new NotFoundError('Workspace');

  const customer = await Customer.findOne({ where: { id: entry.customerId, businessId } });
  if (!customer) throw new NotFoundError('Customer');

  const staffProfileId =
    entry.staffProfileId ?? (await resolveProvider(entry, business.timezone, startsAt));

  const result = await createBooking({
    businessId,
    serviceId: entry.serviceId,
    staffProfileId,
    locationId: entry.locationId,
    startsAt,
    timezone: entry.timezone,
    customer: {
      id: customer.id,
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email,
      phone: customer.phone,
    },
    source: 'WAITLIST',
    actor: { type: actor.type, userId: actor.userId, label: actor.email },
    requestMetadata: metadata,
    // Keyed on the entry and the time, so a double-submitted conversion returns
    // the appointment it already made instead of booking the customer twice.
    idempotencyKey: `waitlist:${entry.id}:${startsAt.toISOString()}`,
  });

  await sequelize.transaction(async (transaction) => {
    await entry.update(
      {
        status: 'CONVERTED',
        convertedAppointmentId: result.appointment.id,
        heldSlotStartsAt: startsAt,
        holdExpiresAt: null,
      },
      { transaction },
    );

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.WAITLIST_CONVERTED,
        entityType: 'waitlist_entry',
        entityId: entry.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          appointmentId: result.appointment.id,
          appointmentPublicId: result.appointment.publicId,
          startsAt,
          staffProfileId,
          autoBooked: false,
        },
      },
      { transaction },
    );
  });

  log.info(
    { businessId, waitlistEntryId: entry.id, appointmentId: result.appointment.id },
    'waitlist entry converted',
  );

  return { entry: await loadEntryDetail(businessId, entryId), appointment: result.appointment };
}

/**
 * The provider for an entry that named no preference.
 *
 * Asking the availability engine rather than picking a name off the roster is
 * what makes this honest: the answer is a provider who is genuinely free for
 * this exact time, chosen by the same Smart Match ranking the booking screen
 * would have shown.
 */
async function resolveProvider(
  entry: WaitlistEntry,
  businessTimezone: string,
  startsAt: Date,
): Promise<string> {
  const date = toIsoDateInZone(startsAt, entry.timezone);

  const availability = await searchAvailability({
    businessId: entry.businessId,
    businessTimezone,
    serviceId: entry.serviceId,
    locationId: entry.locationId,
    fromDate: date,
    toDate: date,
    timezone: entry.timezone,
    customerId: entry.customerId,
  });

  const match = availability.slots.find((slot) => slot.startsAt.getTime() === startsAt.getTime());
  if (!match) {
    throw new SlotUnavailableError('Nobody is available for that time.', {
      startsAt,
      serviceId: entry.serviceId,
    });
  }
  return match.staffProfileId;
}
