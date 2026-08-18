/**
 * The waitlist matcher — what happens the moment a slot frees up.
 *
 * Four rules define correctness here, and each one is load-bearing:
 *
 *  1. **One offer per opening.** The whole evaluation runs under a Redis lock
 *     keyed on (business, service), so two slots freeing at the same instant
 *     cannot hand the same customer two holds, or two customers the same slot.
 *     A live hold on the opening is also re-checked inside the lock, because a
 *     previous evaluation's hold outlives the lock that created it.
 *  2. **Fairness is FIFO within priority.** Candidates are ordered exactly like
 *     `waitlist_eligibility_idx` (priority, then arrival), and only the *first*
 *     eligible entry is served. Offering an opening to everybody who matches
 *     would turn a waitlist into a race.
 *  3. **The entry's own clock decides.** "Weekday afternoons" is a statement
 *     about the customer's calendar, so the slot is re-read in the entry's zone
 *     before it is compared against the stored window. The SQL pre-filter is
 *     deliberately one day wider than the UTC date on both sides — no zone is
 *     further than a day from UTC — and the exact test happens in memory.
 *  4. **Nothing is booked behind the customer's back** unless the workspace has
 *     explicitly turned `waitlistAutoBook` on. The default is an offer with a
 *     time-limited hold, which the customer claims.
 */
import { Op, type Transaction } from 'sequelize';
import { sequelize } from '../../config/database';
import { env } from '../../config/env';
import { createLogger } from '../../config/logger';
import { RedisKeys, withLock } from '../../config/redis';
import {
  Business,
  BusinessSettings,
  Customer,
  Service,
  StaffProfile,
  WaitlistEntry,
} from '../../database/models';
import { emitToWorkspace, SocketEvents } from '../../sockets';
import { NotFoundError, isAppError } from '../../utils/errors';
import {
  addDaysToDate,
  addMinutes,
  dayOfWeekForDate,
  formatForHumans,
  minutesOfDayInZone,
  toIsoDateInZone,
} from '../../utils/time';
import { createBooking } from '../appointments/booking.service';
import { AuditActions, recordAudit } from '../audit/audit.service';
import type { RequestMetadata } from '../auth/auth.service';
import { enqueueNotification } from '../notifications/notification.service';

const log = createLogger('waitlist-matcher');

/**
 * Comfortably longer than a booking's own slot lock (10s), which the auto-book
 * path takes while holding this one, and still inside the 15s ceiling the key
 * registry sets for advisory locks.
 */
const EVALUATION_LOCK_TTL_MS = 15_000;

/** The opening that just became bookable. */
export interface WaitlistSlot {
  businessId: string;
  serviceId: string;
  staffProfileId: string;
  startsAt: Date;
  endsAt: Date;
}

/** Who is making the offer — the matcher, or a staff member re-sending one. */
export interface WaitlistOfferActor {
  actorType: 'USER' | 'SYSTEM';
  userId: string | null;
  label: string;
}

export interface WaitlistOfferInput {
  entry: WaitlistEntry;
  startsAt: Date;
  /** Carried into the real-time event so a dashboard can draw the opening. */
  endsAt: Date | null;
  holdMinutes: number;
  actor: WaitlistOfferActor;
  metadata: RequestMetadata;
  now?: Date;
}

const SYSTEM_ACTOR: WaitlistOfferActor = {
  actorType: 'SYSTEM',
  userId: null,
  label: 'waitlist matcher',
};

// ---------------------------------------------------------------------------
// Offering a slot
// ---------------------------------------------------------------------------

/**
 * Places a hold on `startsAt` for `entry` and tells the customer about it.
 *
 * Shared by the matcher and by the manual `POST /:id/notify`, so an offer sent
 * by hand and one sent by the engine leave identical state behind: the same
 * hold, the same audit line, the same message and the same event.
 *
 * The row change, the audit line and the outbox row are one transaction — an
 * offer the customer was never sent must not leave a hold blocking everybody
 * else, and a hold that rolled back must not leave a claim link in an inbox.
 */
export async function offerSlotToEntry(input: WaitlistOfferInput): Promise<WaitlistEntry> {
  const { entry } = input;
  const now = input.now ?? new Date();
  const holdExpiresAt = addMinutes(now, input.holdMinutes);

  const [business, service, customer] = await Promise.all([
    Business.findByPk(entry.businessId, { attributes: ['id', 'name', 'slug'] }),
    Service.findByPk(entry.serviceId, { attributes: ['id', 'name'] }),
    Customer.findByPk(entry.customerId, {
      attributes: ['id', 'firstName', 'lastName', 'email'],
    }),
  ]);
  if (!business) throw new NotFoundError('Workspace');
  if (!service) throw new NotFoundError('Service');
  if (!customer) throw new NotFoundError('Customer');

  await sequelize.transaction(async (transaction) => {
    await entry.update(
      {
        status: 'NOTIFIED',
        notifiedAt: now,
        heldSlotStartsAt: input.startsAt,
        holdExpiresAt,
        notificationCount: entry.notificationCount + 1,
      },
      { transaction },
    );

    await recordAudit(
      {
        businessId: entry.businessId,
        actorType: input.actor.actorType,
        actorUserId: input.actor.userId,
        actorLabel: input.actor.label,
        action: AuditActions.WAITLIST_NOTIFIED,
        entityType: 'waitlist_entry',
        entityId: entry.id,
        requestId: input.metadata.requestId,
        ipAddress: input.metadata.ipAddress,
        userAgent: input.metadata.userAgent,
        metadata: {
          startsAt: input.startsAt,
          holdExpiresAt,
          notificationCount: entry.notificationCount,
          notifyChannel: entry.notifyChannel,
        },
      },
      { transaction },
    );

    // NONE is a standing "do not contact me": the hold is still placed so the
    // front desk can phone, but nothing is sent.
    if (entry.notifyChannel !== 'NONE') {
      await enqueueOffer(
        { entry, business, service, customer, startsAt: input.startsAt, holdExpiresAt },
        transaction,
      );
    }
  });

  emitToWorkspace(entry.businessId, SocketEvents.waitlistSlotAvailable, {
    waitlistEntryId: entry.id,
    publicId: entry.publicId,
    serviceId: entry.serviceId,
    customerId: entry.customerId,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    holdExpiresAt,
    notificationCount: entry.notificationCount,
    autoBooked: false,
  });

  log.info(
    {
      businessId: entry.businessId,
      waitlistEntryId: entry.id,
      startsAt: input.startsAt,
      holdExpiresAt,
    },
    'waitlist slot offered',
  );

  return entry;
}

async function enqueueOffer(
  context: {
    entry: WaitlistEntry;
    business: Business;
    service: Service;
    customer: Customer;
    startsAt: Date;
    holdExpiresAt: Date;
  },
  transaction: Transaction,
): Promise<void> {
  const { entry, business, service, customer } = context;

  await enqueueNotification(
    {
      businessId: business.id,
      type: 'WAITLIST_SLOT_AVAILABLE',
      // SMS has neither a template nor a provider yet (see
      // notification.processor.ts), so an SMS-preferring customer is still
      // written to by email rather than dropped from an offer they are owed.
      channel: 'EMAIL',
      recipientType: 'CUSTOMER',
      recipientCustomerId: customer.id,
      recipientAddress: customer.email,
      waitlistEntryId: entry.id,
      payload: {
        customerName: customer.fullName,
        businessName: business.name,
        serviceName: service.name,
        startsAtLocal: formatForHumans(context.startsAt, entry.timezone),
        timezone: entry.timezone,
        holdExpiresAtLocal: formatForHumans(context.holdExpiresAt, entry.timezone),
        claimUrl: `${env.PUBLIC_APP_URL}/waitlist/${entry.publicId}/claim`,
      },
      // Keyed on the offer, not the entry: a retried evaluation must not send a
      // second copy, while a deliberate re-offer (which bumps the counter) must.
      dedupeKey: `waitlist-offer:${entry.id}:${context.startsAt.toISOString()}:${entry.notificationCount}`,
    },
    { transaction },
  );
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Offers a freed slot to the first waitlisted customer who can take it.
 *
 * Returns the entry that was served — notified, or converted when the workspace
 * auto-books — or null when nobody matched, the opening is already spoken for,
 * or the waitlist is switched off.
 */
export async function evaluateWaitlistForSlot(input: WaitlistSlot): Promise<WaitlistEntry | null> {
  return withLock(
    RedisKeys.waitlistEvaluationLock(input.businessId, input.serviceId),
    EVALUATION_LOCK_TTL_MS,
    () => evaluate(input),
  );
}

async function evaluate(input: WaitlistSlot): Promise<WaitlistEntry | null> {
  const now = new Date();

  const [settings] = await BusinessSettings.findOrCreate({
    where: { businessId: input.businessId },
    defaults: { businessId: input.businessId },
  });
  if (!settings.waitlistEnabled) return null;

  // A live hold on this opening survives the lock that created it, so it is the
  // hold — not the lock — that stops the same time being offered twice. The
  // test ignores which provider freed the slot: telling two customers about the
  // same clock time for the same service is the failure worth avoiding.
  const alreadyHeld = await WaitlistEntry.count({
    where: {
      businessId: input.businessId,
      serviceId: input.serviceId,
      status: 'NOTIFIED',
      heldSlotStartsAt: input.startsAt,
      holdExpiresAt: { [Op.gt]: now },
    },
  });
  if (alreadyHeld > 0) return null;

  const staffProfile = await StaffProfile.findOne({
    where: { id: input.staffProfileId, businessId: input.businessId },
    attributes: ['id', 'defaultLocationId'],
  });
  if (!staffProfile) {
    // Reached only if the caller passed a provider from another tenant or a
    // deleted one. Refusing to match is safer than guessing whose diary this is.
    log.warn(
      { businessId: input.businessId, staffProfileId: input.staffProfileId },
      'waitlist evaluation skipped — provider does not belong to this workspace',
    );
    return null;
  }

  // The location a booking for this slot would land in: `createBooking` falls
  // back to the provider's default when no location is named, so this is the
  // value a location preference has to agree with.
  const slotLocationId = staffProfile.defaultLocationId;

  const candidates = await findCandidates(input, slotLocationId, now);
  const eligible = candidates.find((entry) => matchesWindow(entry, input.startsAt));
  if (!eligible) return null;

  if (settings.waitlistAutoBook) {
    return autoBook(eligible, input);
  }

  return offerSlotToEntry({
    entry: eligible,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    holdMinutes: settings.waitlistHoldMinutes,
    actor: SYSTEM_ACTOR,
    metadata: {},
    now,
  });
}

/**
 * The entries worth testing in memory, ordered by fairness.
 *
 * Everything expressible in SQL is filtered here so the exact zone-aware test
 * runs over a handful of rows: the tenant, the service, ACTIVE status, the
 * staff and location preferences, the entry's own expiry, and a date bracket
 * one day either side of the slot's UTC date — the widest any zone can shift a
 * calendar date.
 */
async function findCandidates(
  input: WaitlistSlot,
  slotLocationId: string | null,
  now: Date,
): Promise<WaitlistEntry[]> {
  const utcDate = toIsoDateInZone(input.startsAt, 'UTC');

  return WaitlistEntry.findAll({
    where: {
      businessId: input.businessId,
      serviceId: input.serviceId,
      status: 'ACTIVE',
      earliestDate: { [Op.lte]: addDaysToDate(utcDate, 1) },
      latestDate: { [Op.gte]: addDaysToDate(utcDate, -1) },
      [Op.and]: [
        {
          [Op.or]: [
            { staffProfileId: { [Op.is]: null } },
            { staffProfileId: input.staffProfileId },
          ],
        },
        // With no default location on the provider there is nothing a stated
        // preference could be shown to match, so only "no preference" qualifies.
        slotLocationId
          ? { [Op.or]: [{ locationId: { [Op.is]: null } }, { locationId: slotLocationId }] }
          : { locationId: { [Op.is]: null } },
        { [Op.or]: [{ expiresAt: { [Op.is]: null } }, { expiresAt: { [Op.gt]: now } }] },
      ],
    },
    // Exactly `waitlist_eligibility_idx`: priority first, then arrival order, so
    // two customers of equal priority are served in the order they asked.
    order: [
      ['priority', 'ASC'],
      ['createdAt', 'ASC'],
    ],
  });
}

/** The zone-aware half of eligibility: date, time of day and weekday. */
function matchesWindow(entry: WaitlistEntry, startsAt: Date): boolean {
  const localDate = toIsoDateInZone(startsAt, entry.timezone);
  // Both sides are `YYYY-MM-DD`, where lexicographic and chronological order
  // are the same thing.
  if (localDate < entry.earliestDate || localDate > entry.latestDate) return false;

  const localMinute = minutesOfDayInZone(startsAt, entry.timezone);
  if (localMinute < entry.earliestMinute || localMinute > entry.latestMinute) return false;

  return entry.acceptsAnyWeekday || entry.daysOfWeek.includes(dayOfWeekForDate(localDate));
}

// ---------------------------------------------------------------------------
// Auto-booking
// ---------------------------------------------------------------------------

/**
 * Books the opening outright, for workspaces that have opted into it.
 *
 * The idempotency key is derived from the entry and the slot, so an evaluation
 * retried after a crash replays the original appointment instead of creating a
 * second one.
 */
async function autoBook(entry: WaitlistEntry, input: WaitlistSlot): Promise<WaitlistEntry | null> {
  const customer = await Customer.findOne({
    where: { id: entry.customerId, businessId: entry.businessId },
  });
  if (!customer) throw new NotFoundError('Customer');

  let appointmentId: string;
  try {
    const result = await createBooking({
      businessId: entry.businessId,
      serviceId: entry.serviceId,
      staffProfileId: input.staffProfileId,
      locationId: entry.locationId,
      startsAt: input.startsAt,
      timezone: entry.timezone,
      customer: {
        id: customer.id,
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email,
        phone: customer.phone,
      },
      source: 'WAITLIST',
      actor: { type: 'SYSTEM', userId: null, label: SYSTEM_ACTOR.label },
      idempotencyKey: `waitlist:${entry.id}:${input.startsAt.toISOString()}`,
    });
    appointmentId = result.appointment.id;
  } catch (error) {
    // The opening went away between being freed and being claimed. That is an
    // ordinary race, not a fault: there is simply nothing left to offer.
    if (isAppError(error) && error.statusCode === 409) {
      log.info(
        { businessId: entry.businessId, waitlistEntryId: entry.id, err: error },
        'waitlist auto-book lost the slot',
      );
      return null;
    }
    throw error;
  }

  await sequelize.transaction(async (transaction) => {
    // `notifiedAt` and `notificationCount` are left alone on purpose: no offer
    // was made. The customer received a booking confirmation instead, which
    // `createBooking` has already queued.
    await entry.update(
      {
        status: 'CONVERTED',
        convertedAppointmentId: appointmentId,
        heldSlotStartsAt: input.startsAt,
        holdExpiresAt: null,
      },
      { transaction },
    );

    await recordAudit(
      {
        businessId: entry.businessId,
        actorType: 'SYSTEM',
        actorLabel: SYSTEM_ACTOR.label,
        action: AuditActions.WAITLIST_CONVERTED,
        entityType: 'waitlist_entry',
        entityId: entry.id,
        metadata: {
          appointmentId,
          startsAt: input.startsAt,
          staffProfileId: input.staffProfileId,
          autoBooked: true,
        },
      },
      { transaction },
    );
  });

  emitToWorkspace(entry.businessId, SocketEvents.waitlistSlotAvailable, {
    waitlistEntryId: entry.id,
    publicId: entry.publicId,
    serviceId: entry.serviceId,
    customerId: entry.customerId,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    holdExpiresAt: null,
    notificationCount: entry.notificationCount,
    autoBooked: true,
    appointmentId,
  });

  log.info(
    { businessId: entry.businessId, waitlistEntryId: entry.id, appointmentId },
    'waitlist entry auto-booked',
  );

  return entry;
}
