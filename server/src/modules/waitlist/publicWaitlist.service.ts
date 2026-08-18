/**
 * The public waitlist surface — the customer's own two ends of a waitlist.
 *
 * A waitlist is a promise to come back to somebody, and until this file existed
 * MeetFlow could not keep it. The matcher placed a hold and emailed a claim
 * link; there was nothing at the other end of that link, so the offer lapsed,
 * the opening went unfilled and the customer heard nothing more. Joining had
 * the same shape of gap: the specification frames it as something a customer
 * does, and the only way in was a member of staff typing them in.
 *
 * Every rule the public booking surface holds is held here too, because this is
 * the same kind of code — anonymous callers reaching tenant data:
 *
 *  1. **The tenant never comes from the caller.** Joining resolves it from the
 *     booking link's slug, exactly as booking does. Claiming resolves it from
 *     the entry the `wlt_…` handle names. No function here accepts a workspace
 *     identifier, and none can be persuaded to use a different one.
 *  2. **The handle is the authorisation, so it is treated as a bearer token.**
 *     Twenty-six random characters name one entry and grant exactly what the
 *     person holding it is owed: to see the offer made to them, and to accept
 *     it. Nothing else about the workspace is reachable through it, and what
 *     comes back carries opaque identifiers and a given name — never an email
 *     or a phone number, which a forwarded offer would hand on with the link.
 *  3. **Nothing is reimplemented.** A claim is a conversion, so it runs through
 *     `convertWaitlistEntry` and therefore `createBooking`: the slot is
 *     re-verified from live data, the exclusion constraints still have the last
 *     word, the same idempotency key defeats a double submit, and the customer
 *     gets the same confirmation as any other booking. A join runs through
 *     `createWaitlistEntry`, so the tenant checks, the window coherence rules
 *     and the one-live-entry index all apply unchanged. The appointment a claim
 *     produces is described by publicBooking's own view, so a confirmation and
 *     the manage page cannot drift apart.
 *  4. **A refusal says what to do next.** An offer already claimed, a hold that
 *     lapsed, an entry that was never offered anything and one that was
 *     withdrawn are four different situations for the person reading the page.
 *     A bare "conflict" would leave all four of them holding a dead link for
 *     the second time.
 */
import { createLogger } from '../../config/logger';
import type { WaitlistEntry } from '../../database/models';
import {
  Appointment,
  Business,
  BusinessSettings,
  Customer,
  Service,
  StaffProfile,
} from '../../database/models';
import type { WaitlistStatus } from '../../database/models/WaitlistEntry';
import { ConflictError, ErrorCode, NotFoundError, ValidationError } from '../../utils/errors';
import { newCustomerPublicId } from '../../utils/ids';
import type { RequestMetadata } from '../auth/auth.service';
import {
  getPublicAppointment,
  getPublicConfig,
  type PublicAppointmentView,
  type PublicBookingConfig,
  type ResolvedBookingLink,
} from '../publicBooking/publicBooking.service';
import { waitlistOfferUrl } from './waitlist.links';
import type { JoinWaitlistBody } from './publicWaitlist.validation';
import {
  convertWaitlistEntry,
  createWaitlistEntry,
  loadWaitlistEntryByPublicId,
  releaseLapsedHold,
} from './waitlist.service';

const log = createLogger('public-waitlist');

/**
 * The place in the queue a public join takes — the same default the management
 * schema applies.
 *
 * Not accepted from the request and not derived from anything the caller
 * controls: priority is the workspace's dial for "see this person first", and a
 * customer able to set their own would jump every queue they joined.
 */
const PUBLIC_JOIN_PRIORITY = 100;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/** The opening being held, when there is one. */
export interface PublicWaitlistOffer {
  startsAt: Date;
  /**
   * The service's own duration. The provider is only chosen when the offer is
   * claimed — an entry with no staff preference is matched against whichever
   * diary freed the slot — so a per-provider override cannot be known yet, and
   * the service's duration is what the offer honestly advertises.
   */
  durationMinutes: number;
  holdExpiresAt: Date;
  /** True once the hold has lapsed: shown rather than hidden, so the page can say so. */
  expired: boolean;
}

export interface PublicWaitlistView {
  publicId: string;
  status: WaitlistStatus;
  /** True exactly when `POST /claim` would be accepted. */
  claimable: boolean;
  offer: PublicWaitlistOffer | null;
  timezone: string;
  window: {
    earliestDate: string;
    latestDate: string;
    earliestMinute: number;
    latestMinute: number;
    daysOfWeek: number[];
  };
  service: { name: string; description: string | null; durationMinutes: number } | null;
  /** The provider they asked for, when they asked for one. */
  staffName: string | null;
  business: {
    name: string;
    logoUrl: string | null;
    timezone: string;
    supportEmail: string | null;
    supportPhone: string | null;
  };
  /** The person waiting, by given name only — never their contact details. */
  customer: { firstName: string; lastName: string | null } | null;
  /** Present once the offer has been claimed, described as the manage page describes it. */
  appointment: PublicAppointmentView | null;
  offerUrl: string;
}

export interface PublicWaitlistClaim {
  waitlist: PublicWaitlistView;
  appointment: PublicAppointmentView;
}

// ---------------------------------------------------------------------------
// Workspace policy
// ---------------------------------------------------------------------------

/**
 * Workspace settings, without writing to the database.
 *
 * Every authenticated caller uses `findOrCreate`, which is right on that side.
 * Here an unbuilt instance carries the same column defaults, so an anonymous
 * request cannot insert rows into a workspace it merely looked at.
 */
async function settingsFor(businessId: string): Promise<BusinessSettings> {
  return (await BusinessSettings.findByPk(businessId)) ?? BusinessSettings.build({ businessId });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/**
 * The appointment a claimed entry produced, as its holder's manage page shows
 * it.
 *
 * Built by publicBooking rather than here on purpose: claiming an opening
 * leaves the customer with an ordinary appointment, and describing it twice is
 * how two descriptions start disagreeing about what may still be cancelled.
 */
async function appointmentViewFor(entry: WaitlistEntry): Promise<PublicAppointmentView | null> {
  if (!entry.convertedAppointmentId) return null;

  const appointment = await Appointment.findOne({
    where: { id: entry.convertedAppointmentId, businessId: entry.businessId },
    attributes: ['id', 'publicId'],
  });
  // A workspace that deleted the appointment leaves the entry pointing at
  // nothing. The offer stays readable — it says CONVERTED — and the page simply
  // has no booking to draw.
  if (!appointment) return null;

  return getPublicAppointment(appointment.publicId);
}

async function toPublicView(entry: WaitlistEntry): Promise<PublicWaitlistView> {
  const businessId = entry.businessId;

  const [business, service, customer, staffProfile, appointment] = await Promise.all([
    Business.findByPk(businessId),
    Service.findOne({ where: { id: entry.serviceId, businessId } }),
    Customer.findOne({ where: { id: entry.customerId, businessId } }),
    entry.staffProfileId
      ? StaffProfile.findOne({ where: { id: entry.staffProfileId, businessId } })
      : Promise.resolve(null),
    appointmentViewFor(entry),
  ]);

  // A workspace that has been removed takes its waitlist with it, and says so
  // with the same 404 an unknown handle gets.
  if (!business) throw new NotFoundError('Waitlist entry');

  const heldSlotStartsAt = entry.heldSlotStartsAt;
  const holdExpiresAt = entry.holdExpiresAt;
  const offer: PublicWaitlistOffer | null =
    entry.status === 'NOTIFIED' && heldSlotStartsAt && holdExpiresAt
      ? {
          startsAt: heldSlotStartsAt,
          durationMinutes: service?.durationMinutes ?? 0,
          holdExpiresAt,
          expired: !entry.hasActiveHold,
        }
      : null;

  return {
    publicId: entry.publicId,
    status: entry.status,
    claimable: offer !== null && !offer.expired,
    offer,
    timezone: entry.timezone,
    window: {
      earliestDate: entry.earliestDate,
      latestDate: entry.latestDate,
      earliestMinute: entry.earliestMinute,
      latestMinute: entry.latestMinute,
      daysOfWeek: entry.daysOfWeek,
    },
    service: service
      ? {
          name: service.name,
          description: service.description,
          durationMinutes: service.durationMinutes,
        }
      : null,
    // The location is deliberately absent. An entry's `locationId` is a
    // preference, and the site is only settled when the booking is made, so
    // publishing the preference as if it were the venue would send somebody to
    // an address nobody promised them.
    staffName: staffProfile ? staffProfile.displayName : null,
    business: {
      name: business.name,
      logoUrl: business.logoUrl,
      timezone: business.timezone,
      supportEmail: business.supportEmail,
      supportPhone: business.supportPhone,
    },
    customer: customer ? { firstName: customer.firstName, lastName: customer.lastName } : null,
    appointment,
    offerUrl: waitlistOfferUrl(entry.publicId),
  };
}

export async function getPublicWaitlistEntry(publicId: string): Promise<PublicWaitlistView> {
  return toPublicView(await loadWaitlistEntryByPublicId(publicId));
}

// ---------------------------------------------------------------------------
// Joining from a booking link
// ---------------------------------------------------------------------------

/**
 * Refuses anything the link does not publish.
 *
 * The same check `createPublicBooking` makes, for the same reason: a slug does
 * not open the whole workspace. A real id this link does not offer answers 404
 * rather than 403, so the endpoint cannot be used to confirm which services,
 * providers or sites exist behind it. It matters at least as much here as it
 * does on the booking form, because an entry against a service a link never
 * published is a booking made by the back door — the matcher will eventually
 * book it.
 */
function assertPublished(
  config: PublicBookingConfig,
  requested: { serviceId: string; staffProfileId?: string; locationId?: string },
): void {
  if (!config.services.some((service) => service.id === requested.serviceId)) {
    throw new NotFoundError('Service');
  }

  if (requested.staffProfileId !== undefined) {
    if (!config.link.allowStaffSelection) {
      throw new ValidationError('This booking page assigns the provider for you.', [
        {
          field: 'staffProfileId',
          message: 'Leave the provider unset — the best available one is chosen automatically.',
        },
      ]);
    }
    if (!config.staff.some((member) => member.id === requested.staffProfileId)) {
      throw new NotFoundError('Staff member');
    }
  }

  if (
    requested.locationId !== undefined &&
    !config.locations.some((location) => location.id === requested.locationId)
  ) {
    throw new NotFoundError('Location');
  }
}

/**
 * The person joining, matched on the email they submitted.
 *
 * Creating a customer row from an anonymous request is exactly what booking
 * already does, and the same reasoning applies: the alternative is refusing a
 * waitlist request from anybody who has never been to this workspace before,
 * which is most of the people a waitlist exists for. A blocked customer is not
 * refused here but by `createWaitlistEntry`, which owns that rule for both
 * surfaces — and because this only ever matches an existing row, no blocked
 * person can slip through by re-registering under the same address.
 */
async function resolveCustomer(businessId: string, input: JoinWaitlistBody): Promise<Customer> {
  const email = input.customer.email;
  const existing = await Customer.findOne({ where: { businessId, email } });
  if (existing) return existing;

  return Customer.create({
    businessId,
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
  });
}

export async function joinWaitlistFromLink(
  resolved: ResolvedBookingLink,
  input: JoinWaitlistBody,
  metadata: RequestMetadata,
): Promise<PublicWaitlistView> {
  const businessId = resolved.business.id;
  const config = await getPublicConfig(resolved);
  assertPublished(config, input);

  // A workspace with the waitlist switched off would accept the request, never
  // evaluate it, and leave the customer waiting for an email no code will send.
  // Told plainly instead: this is a closed door, not a missing page.
  const settings = await settingsFor(businessId);
  if (!settings.waitlistEnabled) {
    throw new ConflictError(
      'This workspace is not keeping a waitlist at the moment.',
      ErrorCode.CONFLICT,
      { reason: 'waitlist_disabled' },
    );
  }

  const customer = await resolveCustomer(businessId, input);

  const entry = await createWaitlistEntry(
    businessId,
    {
      customerId: customer.id,
      serviceId: input.serviceId,
      // A link pinned to one provider or site narrows the request even when the
      // caller named neither, exactly as it narrows a booking.
      staffProfileId: input.staffProfileId ?? resolved.link.staffProfileId ?? null,
      locationId: input.locationId ?? resolved.link.locationId ?? null,
      earliestDate: input.earliestDate,
      latestDate: input.latestDate,
      earliestMinute: input.earliestMinute,
      latestMinute: input.latestMinute,
      daysOfWeek: input.daysOfWeek,
      timezone: input.timezone,
      priority: PUBLIC_JOIN_PRIORITY,
      // They reached this endpoint by typing an email address into a form; that
      // is the channel, and NONE would mean joining a list that cannot call you.
      notifyChannel: 'EMAIL',
      // `latestDate` already bounds how long this can sit in the queue. A
      // second, shorter expiry is a front-desk decision, not a customer's.
      expiresAt: null,
      note: input.note ?? null,
    },
    { type: 'CUSTOMER', customerId: customer.id, email: customer.email },
    metadata,
  );

  log.info(
    { businessId, slug: resolved.link.slug, waitlistEntryId: entry.id },
    'customer joined a waitlist from a booking link',
  );

  return toPublicView(entry);
}

// ---------------------------------------------------------------------------
// Claiming an offer
// ---------------------------------------------------------------------------

/**
 * The opening this entry may still be converted into, or a refusal saying why
 * not.
 *
 * Telling the four failures apart is most of the value of this endpoint: one
 * person has already booked, one waited too long, one was never offered
 * anything, and one withdrew. Each needs a different next step, and the offer
 * email gives them all the same URL to find it out from.
 */
async function assertClaimable(entry: WaitlistEntry): Promise<Date> {
  if (entry.status === 'CONVERTED') {
    const appointment = entry.convertedAppointmentId
      ? await Appointment.findOne({
          where: { id: entry.convertedAppointmentId, businessId: entry.businessId },
          attributes: ['id', 'publicId'],
        })
      : null;

    throw new ConflictError(
      'This opening has already been claimed, and the booking is confirmed.',
      ErrorCode.ALREADY_EXISTS,
      // Their own booking, named by its own opaque handle, so the page can send
      // them straight to it rather than leaving them at a dead end.
      appointment ? { appointmentPublicId: appointment.publicId } : {},
    );
  }

  if (entry.status !== 'ACTIVE' && entry.status !== 'NOTIFIED') {
    throw new ConflictError(
      `This waitlist request is ${entry.status.toLowerCase()} and can no longer be claimed.`,
      ErrorCode.INVALID_STATE_TRANSITION,
      { status: entry.status },
    );
  }

  const heldSlotStartsAt = entry.heldSlotStartsAt;
  if (entry.status !== 'NOTIFIED' || !heldSlotStartsAt) {
    throw new ConflictError(
      'No opening is being held for you at the moment. You are still on the waitlist, and ' +
        'we will email you as soon as one comes up.',
      ErrorCode.CONFLICT,
      { status: entry.status },
    );
  }

  if (!entry.hasActiveHold) {
    const holdExpiredAt = entry.holdExpiresAt;
    // Released rather than merely reported. The sweep would get to it
    // eventually, but the next customer in the queue should not have to wait
    // for a background job, and this one is genuinely still on the list.
    await releaseLapsedHold(entry);
    throw new ConflictError(
      'The hold on this opening has expired, so it has been offered on. You are still on ' +
        'the waitlist for the next one.',
      ErrorCode.BOOKING_WINDOW_CLOSED,
      { holdExpiredAt },
    );
  }

  return heldSlotStartsAt;
}

/**
 * Accepts the opening held for this entry and turns it into a real appointment.
 *
 * Neither two customers nor one customer double-clicking can end up with two
 * bookings. The conversion carries an idempotency key derived from the entry
 * and the opening, so a simultaneous second claim replays the first result or
 * is refused outright, and behind that the staff-overlap exclusion constraint
 * would refuse a second appointment in the same minutes regardless.
 */
export async function claimWaitlistOffer(
  publicId: string,
  metadata: RequestMetadata,
): Promise<PublicWaitlistClaim> {
  const entry = await loadWaitlistEntryByPublicId(publicId);
  const startsAt = await assertClaimable(entry);

  const customer = await Customer.findOne({
    where: { id: entry.customerId, businessId: entry.businessId },
    attributes: ['id', 'email'],
  });
  if (!customer) throw new NotFoundError('Customer');

  const conversion = await convertWaitlistEntry(
    entry.businessId,
    entry.id,
    startsAt,
    // The customer acting for themselves. `customerId` is read off the entry,
    // never off the request, so this cannot be pointed at anybody else.
    { type: 'CUSTOMER', customerId: customer.id, email: customer.email },
    metadata,
  );

  log.info(
    {
      businessId: entry.businessId,
      waitlistEntryId: entry.id,
      appointmentPublicId: conversion.appointment.publicId,
    },
    'waitlist offer claimed by the customer',
  );

  return {
    waitlist: await toPublicView(conversion.entry),
    appointment: await getPublicAppointment(conversion.appointment.publicId),
  };
}
