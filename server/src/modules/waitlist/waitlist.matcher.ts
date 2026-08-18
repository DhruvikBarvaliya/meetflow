/**
 * The waitlist matcher — what happens the moment a slot frees up.
 *
 * Four rules define correctness here, and each one is load-bearing:
 *
 *  1. **One offer per opening, and the database is what says so.** The partial
 *     unique index `waitlist_live_offer_unique` — on (business, service,
 *     opening) among NOTIFIED rows — is the authority. Two evaluations that
 *     both believe an opening is free cannot both write a hold on it; the loser
 *     is told the opening is spoken for instead of making a second promise. The
 *     Redis lock keyed on (business, service) sits over the top as a fast path
 *     and nothing more, and it has to be that way round: `acquireLock` proceeds
 *     *unlocked* when Redis is unreachable, so protection resting on it alone
 *     would quietly switch itself off during exactly the incident it was meant
 *     to survive. Lapsed holds are released inline before an opening is offered,
 *     because an index predicate cannot read a clock and a dead hold would
 *     otherwise keep a live one out.
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
import { Op, UniqueConstraintError, type Transaction } from 'sequelize';
import { sequelize } from '../../config/database';
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
import { ConflictError, ErrorCode, NotFoundError, isAppError } from '../../utils/errors';
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
import { waitlistOfferUrl } from './waitlist.links';

const log = createLogger('waitlist-matcher');

/**
 * Comfortably longer than a booking's own slot lock (10s), which the auto-book
 * path takes while holding this one, and still inside the 15s ceiling the key
 * registry sets for advisory locks.
 */
const EVALUATION_LOCK_TTL_MS = 15_000;

/** The index that decides who owns an opening. See the migration for why. */
const LIVE_OFFER_INDEX = 'waitlist_live_offer_unique';

/**
 * True when a write was refused because somebody else already holds this
 * opening.
 *
 * Named precisely rather than treating every unique violation the same way:
 * `waitlist_public_id_unique` and the notification outbox's `dedupe_key` index
 * can both fire on this path, and reporting either of those as "already
 * offered" would hide a real fault behind a plausible-looking race.
 */
function isLiveOfferCollision(error: unknown): boolean {
  if (!(error instanceof UniqueConstraintError)) return false;
  const constraint = (error as { parent?: { constraint?: string } }).parent?.constraint;
  return constraint === LIVE_OFFER_INDEX;
}

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
 *
 * Throws a 409 when the opening is already held by another entry. That verdict
 * comes from `waitlist_live_offer_unique` rather than from anything this
 * process checked, which is why it is trustworthy under concurrency: see rule 1
 * in the file header.
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
    // The write the unique index guards. A rejection here means another entry
    // took this opening between the fast-path check and this statement, and
    // rethrowing rolls the whole transaction back — which is the point: an
    // offer that did not happen must not leave an audit line or an email
    // claiming it did. No savepoint is needed the way `enqueueNotification`
    // needs one, because nothing continues after this failure.
    try {
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
    } catch (error) {
      if (isLiveOfferCollision(error)) {
        throw new ConflictError(
          'That opening has just been offered to somebody else.',
          ErrorCode.CONFLICT,
          { startsAt: input.startsAt },
        );
      }
      throw error;
    }

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
        // Resolves to `GET /public/waitlist/:publicId`, which renders the offer
        // and posts the claim. The template promises the customer somewhere to
        // go; this is the only line that makes that promise true.
        claimUrl: waitlistOfferUrl(entry.publicId),
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

/**
 * Hands a slot the lifecycle has just freed to the waitlist, without making the
 * caller wait for it.
 *
 * Exported as its own function so every way a slot can be freed reaches the
 * waitlist the same way. A cancellation is only the most obvious of them: a
 * rejection frees a slot the customer was still hoping for, and a reschedule
 * frees the time the appointment moved *away* from. Each of those is one call
 * to this, and the reason it exists is that the "fire it, log it, never let it
 * fail the caller" handling below is exactly what gets forgotten when the third
 * call site is written by hand.
 *
 * Deliberately not awaited into the caller's result. The change that freed the
 * slot has already committed and already succeeded for the person who made it;
 * an offer that cannot be sent must not turn their cancellation into a 500. A
 * failure is logged, the entry stays ACTIVE, and the next opening picks it up.
 */
export function offerFreedSlot(input: WaitlistSlot, context: { reason: string }): void {
  void evaluateWaitlistForSlot(input)
    .then((entry) => {
      if (entry) {
        log.info(
          {
            businessId: input.businessId,
            waitlistEntryId: entry.id,
            startsAt: input.startsAt,
            reason: context.reason,
          },
          'freed slot offered to a waitlisted customer',
        );
      }
    })
    .catch((error: unknown) => {
      log.error(
        {
          err: error,
          businessId: input.businessId,
          startsAt: input.startsAt,
          reason: context.reason,
        },
        'waitlist evaluation failed for a freed slot',
      );
    });
}

async function evaluate(input: WaitlistSlot): Promise<WaitlistEntry | null> {
  const now = new Date();

  const [settings] = await BusinessSettings.findOrCreate({
    where: { businessId: input.businessId },
    defaults: { businessId: input.businessId },
  });
  if (!settings.waitlistEnabled) return null;

  // A lapsed hold still occupies its opening as far as the unique index is
  // concerned, so it is released here rather than left to the maintenance
  // sweep: one customer who ignored their email must not keep an opening
  // unofferable until the sweep next runs. A NOTIFIED row with no expiry at all
  // is released too — nothing writes one, and if anything ever does it must not
  // wedge the slot for good.
  await WaitlistEntry.update(
    { status: 'ACTIVE', holdExpiresAt: null, heldSlotStartsAt: null },
    {
      where: {
        businessId: input.businessId,
        serviceId: input.serviceId,
        status: 'NOTIFIED',
        heldSlotStartsAt: input.startsAt,
        [Op.or]: [{ holdExpiresAt: { [Op.is]: null } }, { holdExpiresAt: { [Op.lte]: now } }],
      },
    },
  );

  // A fast path, and only that. A live hold on this opening usually means there
  // is nothing to do, and one cheap count says so before any candidate is
  // loaded and tested. It cannot be the guarantee — this read and the write
  // below are separate statements with a gap between them, which is what
  // `waitlist_live_offer_unique` closes. The test ignores which provider freed
  // the slot: telling two customers about the same clock time for the same
  // service is the failure worth avoiding.
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

  try {
    return await offerSlotToEntry({
      entry: eligible,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      holdMinutes: settings.waitlistHoldMinutes,
      actor: SYSTEM_ACTOR,
      metadata: {},
      now,
    });
  } catch (error) {
    // The index refused the hold: a concurrent evaluation offered this exact
    // opening first. An ordinary race, handled the way `autoBook` handles
    // losing the slot — there is simply nothing left to offer.
    if (isAppError(error) && error.statusCode === 409) {
      log.info(
        {
          businessId: input.businessId,
          waitlistEntryId: eligible.id,
          startsAt: input.startsAt,
        },
        'waitlist offer lost the opening to a concurrent evaluation',
      );
      return null;
    }
    throw error;
  }
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
