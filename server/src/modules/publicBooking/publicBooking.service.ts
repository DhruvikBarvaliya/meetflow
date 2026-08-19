/**
 * The public booking surface.
 *
 * This is the most exposed code in MeetFlow: every caller is anonymous, and the
 * only thing standing between them and a workspace's data is the slug they
 * typed. Five rules hold without exception.
 *
 *  1. **The tenant comes from the slug, never from the caller.** A booking link
 *     is resolved to an active, unexpired, undeleted row belonging to an ACTIVE
 *     workspace, and `businessId` is read off that row. No function here accepts
 *     a workspace identifier, and no caller can influence which one is used
 *     beyond choosing a published link.
 *
 *  2. **Only what the link publishes may be booked.** A slug does not open the
 *     whole workspace: the offering (services, providers, locations) is derived
 *     from the link's own type and targets, and every id the caller sends is
 *     checked against it. A service that exists but is not offered here answers
 *     404, exactly like one that does not exist, so the endpoint cannot be used
 *     to enumerate a catalogue.
 *
 *  3. **Only opaque identifiers go out.** Appointments, customers, participants,
 *     businesses and memberships are addressed publicly by their `*_…` handles;
 *     their UUIDs never leave this module. Service, staff and location ids are
 *     the exception, because the booking form has to name what it is booking.
 *
 *  4. **Nothing is reimplemented.** Slot search, booking, rescheduling and
 *     cancellation all run through the same services the authenticated API uses,
 *     so the public path cannot drift from — or be laxer than — the internal
 *     one. Those services own the audit trail for the mutations they perform:
 *     `createBooking` writes APPOINTMENT_CREATED, `rescheduleAppointment` writes
 *     APPOINTMENT_RESCHEDULED and `cancelAppointment` writes
 *     APPOINTMENT_CANCELLED. This module deliberately adds no second row per
 *     event — it passes the customer actor and the request metadata down so
 *     those rows are attributable to the IP and request that caused them.
 *
 *  5. **Redis is an accelerator, never an authority.** The published
 *     configuration is cached per slug, but the link's own expiry and cap are
 *     re-read from PostgreSQL on every request, and slot eligibility is always
 *     recomputed inside the booking transaction.
 */
import { Op } from 'sequelize';
import { env } from '../../config/env';
import { createLogger } from '../../config/logger';
import { RedisKeys, cacheGet, cacheSet } from '../../config/redis';
import {
  type Appointment,
  BookingLink,
  BookingLinkService,
  Business,
  BusinessSettings,
  Customer,
  Location,
  Service,
  ServiceLocation,
  ServiceStaff,
  StaffProfile,
  TeamMember,
} from '../../database/models';
import { ACTIVE_APPOINTMENT_STATUSES } from '../../database/models/Appointment';
import type { BookingLinkType } from '../../database/models/BookingLink';
import type { LocationType } from '../../database/models/Location';
import { searchAvailability, type AvailableSlot } from '../../scheduling/availability.service';
import {
  ConflictError,
  ErrorCode,
  NotFoundError,
  SlotUnavailableError,
  ValidationError,
  type ErrorDetail,
} from '../../utils/errors';
import { differenceInMinutes, toIsoDateInZone } from '../../utils/time';
import type { PublicBookingContext } from '../auth/context';
import type { RequestMetadata } from '../auth/auth.service';
import { createBooking } from '../appointments/booking.service';
import {
  cancelAppointment,
  loadAppointmentByPublicId,
  rescheduleAppointment,
  type LifecycleActor,
} from '../appointments/lifecycle.service';
import { customQuestionSchema, type CustomQuestion } from '../bookingLinks/bookingLinks.validation';
import type {
  CancelPublicAppointmentBody,
  CreatePublicBookingBody,
  PublicAvailabilityQuery,
  ReschedulePublicAppointmentBody,
} from './publicBooking.validation';

const log = createLogger('public-booking');

/** Longest single free-text answer accepted into `appointments.answers`. */
const MAX_ANSWER_LENGTH = 2000;

/** Ceiling on a MULTI_SELECT answer; the question itself allows 50 options. */
const MAX_SELECTED_OPTIONS = 50;

/**
 * Idempotency keys live in one platform-wide namespace — the unique index is on
 * (scope, key), not (scope, business_id, key). A short or guessable key could
 * therefore be claimed by an unrelated caller and turn somebody's legitimate
 * retry into a conflict, so the surface only accepts keys with real entropy.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{16,200}$/;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface PublicServiceSummary {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  priceAmount: number;
  currency: string;
  capacity: number;
  requiresApproval: boolean;
}

export interface PublicStaffSummary {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface PublicLocationSummary {
  id: string;
  name: string;
  type: LocationType;
  timezone: string;
  /** Single-line address, or null for a location with nothing to show. */
  address: string | null;
}

export interface PublicPolicySummary {
  timezone: string;
  minNoticeMinutes: number;
  maxHorizonDays: number;
  cancellationDeadlineMinutes: number;
  rescheduleDeadlineMinutes: number;
  maxReschedulesPerAppointment: number;
  allowCustomerCancel: boolean;
  allowCustomerReschedule: boolean;
  requiresApproval: boolean;
}

/**
 * Everything the public booking page needs to render itself.
 *
 * Every field is JSON-primitive on purpose: this object is cached in Redis, so
 * a value that does not survive a `JSON.parse(JSON.stringify(x))` round trip
 * would make a cache hit differ from a cache miss. `expiresAt` is therefore an
 * ISO string rather than a Date.
 *
 * Deliberately absent: the workspace id, the link id, and the link's booking
 * counters. A customer needs none of them, and `bookingCount` against
 * `maxBookingsTotal` would publish how a campaign is performing.
 */
export interface PublicBookingConfig {
  link: {
    slug: string;
    name: string;
    description: string | null;
    type: BookingLinkType;
    allowStaffSelection: boolean;
    expiresAt: string | null;
    branding: Record<string, unknown>;
  };
  business: {
    name: string;
    description: string | null;
    logoUrl: string | null;
    websiteUrl: string | null;
    timezone: string;
    currency: string;
    locale: string;
    supportEmail: string | null;
    supportPhone: string | null;
  };
  services: PublicServiceSummary[];
  locations: PublicLocationSummary[];
  staff: PublicStaffSummary[];
  questions: CustomQuestion[];
  policy: PublicPolicySummary;
}

export interface PublicSlot {
  startsAt: Date;
  endsAt: Date;
  staffProfileId: string;
  staffName: string;
  locationId: string | null;
  durationMinutes: number;
  priceAmount: number;
  currency: string;
  remainingCapacity?: number;
}

export interface PublicAvailabilityResult {
  slots: PublicSlot[];
  timezone: string;
  /** True when the search hit its slot ceiling; narrow the date range. */
  truncated: boolean;
  service: {
    durationMinutes: number;
    priceAmount: number;
    currency: string;
    capacity: number;
    minNoticeMinutes: number;
    maxHorizonDays: number;
    requiresApproval: boolean;
  };
}

export interface PublicAppointmentView {
  publicId: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  timezone: string;
  priceAmount: number;
  currency: string;
  title: string | null;
  customerNotes: string | null;
  answers: Record<string, unknown>;
  requiresApproval: boolean;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  rescheduleCount: number;
  service: { id: string; name: string; description: string | null } | null;
  staff: PublicStaffSummary | null;
  location: (PublicLocationSummary & { virtualMeetingUrl: string | null }) | null;
  business: {
    name: string;
    logoUrl: string | null;
    timezone: string;
    supportEmail: string | null;
    supportPhone: string | null;
  };
  /** The booker, by given name only — never their contact details. */
  customer: { firstName: string; lastName: string | null } | null;
  policy: {
    canCancel: boolean;
    canReschedule: boolean;
    cancellationDeadlineMinutes: number;
    rescheduleDeadlineMinutes: number;
    remainingReschedules: number;
  };
  manageUrl: string;
}

export interface PublicBookingConfirmation {
  appointment: {
    publicId: string;
    status: string;
    startsAt: Date;
    endsAt: Date;
    durationMinutes: number;
    timezone: string;
    priceAmount: number;
    currency: string;
    title: string | null;
    requiresApproval: boolean;
    serviceId: string;
    staffProfileId: string | null;
    locationId: string | null;
  };
  /** Opaque handle for this person's place, meaningful on group sessions. */
  participantPublicId: string;
  manageUrl: string;
  /** True when an idempotency key replayed an earlier, identical request. */
  replayed: boolean;
}

/** A booking link proven to be open, together with its workspace. */
export interface ResolvedBookingLink {
  link: BookingLink;
  business: Business;
}

// ---------------------------------------------------------------------------
// Link resolution — the only place a tenant enters this module
// ---------------------------------------------------------------------------

/**
 * Turns a slug into a tenant.
 *
 * A link that does not exist, was soft-deleted, was deactivated, or belongs to
 * a workspace that is not ACTIVE all answer the same 404: the public surface
 * must not report which of those is the case, or it becomes a way to discover
 * retired campaigns and suspended businesses.
 *
 * Expiry and the total cap are checked separately, because those two *are*
 * worth telling the customer: they typed a real address that has closed, and a
 * bare "not found" would send them hunting for a typo that is not there.
 */
export async function resolveBookingLink(slug: string): Promise<ResolvedBookingLink> {
  const link = await BookingLink.findOne({
    where: { slug, isActive: true },
    include: [{ model: Business, as: 'business', required: true, where: { status: 'ACTIVE' } }],
  });
  if (!link) throw new NotFoundError('Booking link');

  if (link.isExpired) {
    throw new ConflictError(
      'This booking link has expired and is no longer accepting bookings.',
      ErrorCode.BOOKING_WINDOW_CLOSED,
      { reason: 'expired' },
    );
  }
  if (link.isExhausted) {
    throw new ConflictError(
      'This booking link has taken all the bookings it was set up for.',
      ErrorCode.BOOKING_WINDOW_CLOSED,
      { reason: 'exhausted' },
    );
  }

  return { link, business: link.get('business') as Business };
}

export function toPublicBookingContext(resolved: ResolvedBookingLink): PublicBookingContext {
  return {
    businessId: resolved.business.id,
    businessTimezone: resolved.business.timezone,
    bookingLinkId: resolved.link.id,
    slug: resolved.link.slug,
    requiresApproval: resolved.link.requiresApproval,
  };
}

/**
 * Workspace booking policy, without writing to the database.
 *
 * Every other caller uses `findOrCreate`, which is right on an authenticated
 * path. Here an unbuilt instance carries the same column defaults, so an
 * anonymous GET cannot insert rows into a workspace it merely looked at.
 */
async function settingsFor(businessId: string): Promise<BusinessSettings> {
  return (await BusinessSettings.findByPk(businessId)) ?? BusinessSettings.build({ businessId });
}

/** PUBLIC_APP_URL may or may not carry a trailing slash. */
function publicUrl(path: string): string {
  return `${env.PUBLIC_APP_URL.replace(/\/+$/, '')}${path}`;
}

function manageUrlFor(appointmentPublicId: string): string {
  return publicUrl(`/appointments/${appointmentPublicId}`);
}

// ---------------------------------------------------------------------------
// What a link actually offers
// ---------------------------------------------------------------------------

/**
 * Services, always re-checked against the tenant and the two public flags.
 *
 * `isActive && isPublic` is the gate a service must pass to appear on a booking
 * page at all — a service can be retired entirely, or stay live while being
 * sold only through staff booking.
 */
async function servicesByIds(businessId: string, ids: readonly string[]): Promise<Service[]> {
  if (ids.length === 0) return [];
  return Service.findAll({
    where: { id: { [Op.in]: [...ids] }, businessId, isActive: true, isPublic: true },
    order: [
      ['sortOrder', 'ASC'],
      ['name', 'ASC'],
    ],
  });
}

async function staffByIds(businessId: string, ids: readonly string[]): Promise<StaffProfile[]> {
  if (ids.length === 0) return [];
  return StaffProfile.findAll({
    where: { id: { [Op.in]: [...ids] }, businessId, isActive: true, isBookable: true },
    order: [
      ['sortOrder', 'ASC'],
      ['displayName', 'ASC'],
    ],
  });
}

/**
 * `team_members` carries no business_id. It is only ever reached through a team
 * named on a link already proven to belong to the tenant, and every profile it
 * yields is re-checked against that same businessId by `staffByIds`.
 */
async function teamStaffIds(teamId: string): Promise<string[]> {
  const members = await TeamMember.findAll({
    where: { teamId, isActive: true },
    attributes: ['staffProfileId'],
  });
  return members.map((member) => member.staffProfileId);
}

async function servicesForStaff(businessId: string, staffIds: string[]): Promise<Service[]> {
  if (staffIds.length === 0) return [];
  const assignments = await ServiceStaff.findAll({
    where: { staffProfileId: { [Op.in]: staffIds }, isActive: true },
    attributes: ['serviceId'],
  });
  return servicesByIds(businessId, [...new Set(assignments.map((row) => row.serviceId))]);
}

/**
 * The catalogue a CATALOG link publishes.
 *
 * Curated rows win and keep their operator-chosen order. A link with no rows at
 * all is the *whole* public catalogue — that is what CATALOG means, and it is
 * the only reading under which such a link renders a usable page rather than an
 * empty one. The distinction is drawn on whether any pairing rows exist, not on
 * whether they resolved: a curated link whose services all went private must
 * show nothing, never silently fall back to publishing everything.
 */
async function catalogueFor(link: BookingLink): Promise<Service[]> {
  const pairings = await BookingLinkService.findAll({
    where: { bookingLinkId: link.id },
    attributes: ['serviceId', 'sortOrder'],
    order: [
      ['sortOrder', 'ASC'],
      ['createdAt', 'ASC'],
    ],
  });

  if (pairings.length === 0) {
    return Service.findAll({
      where: { businessId: link.businessId, isActive: true, isPublic: true },
      order: [
        ['sortOrder', 'ASC'],
        ['name', 'ASC'],
      ],
    });
  }

  const position = new Map(pairings.map((row, index) => [row.serviceId, index]));
  const services = await servicesByIds(link.businessId, [...position.keys()]);
  return services.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
}

async function loadOfferedServices(link: BookingLink): Promise<Service[]> {
  // Read into a plainly-typed local first: the column is declared
  // `CreationOptional`, and the brand that carries rides along as an
  // intersection that stops the switch below from being seen as exhaustive.
  const type: BookingLinkType = link.type;

  switch (type) {
    case 'SINGLE_SERVICE':
      return link.serviceId ? servicesByIds(link.businessId, [link.serviceId]) : [];
    case 'STAFF':
      return link.staffProfileId ? servicesForStaff(link.businessId, [link.staffProfileId]) : [];
    case 'TEAM':
      return link.teamId ? servicesForStaff(link.businessId, await teamStaffIds(link.teamId)) : [];
    case 'CATALOG':
      return catalogueFor(link);
  }
}

async function loadOfferedStaff(link: BookingLink, serviceIds: string[]): Promise<StaffProfile[]> {
  if (link.staffProfileId) return staffByIds(link.businessId, [link.staffProfileId]);
  if (link.teamId) return staffByIds(link.businessId, await teamStaffIds(link.teamId));
  if (serviceIds.length === 0) return [];

  const assignments = await ServiceStaff.findAll({
    where: { serviceId: { [Op.in]: serviceIds }, isActive: true },
    attributes: ['staffProfileId'],
  });
  return staffByIds(link.businessId, [...new Set(assignments.map((row) => row.staffProfileId))]);
}

/**
 * Locations, honouring the "absence means everywhere" rule of
 * `service_locations`: a service with no rows of its own is offered at every
 * active site, so one such service on the page keeps every site on it.
 */
async function loadOfferedLocations(link: BookingLink, serviceIds: string[]): Promise<Location[]> {
  if (link.locationId) {
    return Location.findAll({
      where: { id: link.locationId, businessId: link.businessId, isActive: true },
    });
  }

  const active = await Location.findAll({
    where: { businessId: link.businessId, isActive: true },
    order: [
      ['sortOrder', 'ASC'],
      ['name', 'ASC'],
    ],
  });
  if (serviceIds.length === 0 || active.length === 0) return active;

  const restrictions = await ServiceLocation.findAll({
    where: { serviceId: { [Op.in]: serviceIds } },
    attributes: ['serviceId', 'locationId'],
  });
  if (restrictions.length === 0) return active;

  const restricted = new Set(restrictions.map((row) => row.serviceId));
  if (serviceIds.some((id) => !restricted.has(id))) return active;

  const allowed = new Set(restrictions.map((row) => row.locationId));
  return active.filter((location) => allowed.has(location.id));
}

/**
 * The link's own questions.
 *
 * Re-parsed with the schema that wrote them so the handlers get typed access.
 * A row that cannot be read is published as no questions rather than as a 500:
 * a misconfigured JSONB blob must not take the whole booking page down, and
 * refusing every submitted answer is the safe direction to fail in.
 */
function parseQuestions(link: BookingLink): CustomQuestion[] {
  const parsed = customQuestionSchema.array().safeParse(link.customQuestions);
  if (parsed.success) return parsed.data;
  log.warn(
    { bookingLinkId: link.id, slug: link.slug },
    'booking link carries unreadable custom questions — publishing none',
  );
  return [];
}

// ---------------------------------------------------------------------------
// Published configuration
// ---------------------------------------------------------------------------

/**
 * `requireApproval` is the two outer layers of the approval rule already ORed
 * together — the workspace setting and this link's flag. The service's own flag
 * is the third, and the page must advertise the same OR the booking path
 * applies at commit, or it promises instant confirmation and then hands back a
 * PENDING appointment.
 */
function toServiceSummary(service: Service, requireApproval: boolean): PublicServiceSummary {
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    durationMinutes: service.durationMinutes,
    priceAmount: service.priceAmount,
    currency: service.currency,
    capacity: service.capacity,
    requiresApproval: service.requiresApproval || requireApproval,
  };
}

function toStaffSummary(profile: StaffProfile): PublicStaffSummary {
  // Nothing here identifies the person beyond what they publish: no userId, no
  // membershipId, no email — those would tie a public page to a login.
  return { id: profile.id, displayName: profile.displayName, avatarUrl: profile.avatarUrl };
}

function toLocationSummary(location: Location): PublicLocationSummary {
  // `virtualMeetingUrl` is deliberately absent: a room link published before
  // anyone books is an open door into every meeting held there.
  return {
    id: location.id,
    name: location.name,
    type: location.type,
    timezone: location.timezone,
    address: location.formattedAddress,
  };
}

async function buildConfig(link: BookingLink, business: Business): Promise<PublicBookingConfig> {
  const services = await loadOfferedServices(link);
  const serviceIds = services.map((service) => service.id);

  const [staff, locations, settings] = await Promise.all([
    loadOfferedStaff(link, serviceIds),
    loadOfferedLocations(link, serviceIds),
    settingsFor(business.id),
  ]);

  // Every layer that can ask for review, ORed the way the booking path ORs
  // them. Held in one binding so the service cards and the policy block below
  // cannot drift apart from each other.
  const requiresApproval = settings.requireApproval || link.requiresApproval;

  return {
    link: {
      slug: link.slug,
      name: link.name,
      description: link.description,
      type: link.type,
      allowStaffSelection: link.allowStaffSelection,
      expiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
      branding: link.branding,
    },
    business: {
      name: business.name,
      description: business.description,
      logoUrl: business.logoUrl,
      websiteUrl: business.websiteUrl,
      timezone: business.timezone,
      currency: business.currency,
      locale: business.locale,
      supportEmail: business.supportEmail,
      supportPhone: business.supportPhone,
    },
    services: services.map((service) => toServiceSummary(service, requiresApproval)),
    locations: locations.map(toLocationSummary),
    staff: staff.map(toStaffSummary),
    questions: parseQuestions(link),
    policy: {
      timezone: business.timezone,
      minNoticeMinutes: settings.minNoticeMinutes,
      maxHorizonDays: settings.maxHorizonDays,
      cancellationDeadlineMinutes: settings.cancellationDeadlineMinutes,
      rescheduleDeadlineMinutes: settings.rescheduleDeadlineMinutes,
      maxReschedulesPerAppointment: settings.maxReschedulesPerAppointment,
      allowCustomerCancel: settings.allowCustomerCancel,
      allowCustomerReschedule: settings.allowCustomerReschedule,
      requiresApproval,
    },
  };
}

/**
 * The published configuration, cached per slug.
 *
 * A booking page is read far more often than it changes — every customer who
 * opens it runs the same handful of catalogue queries — so the assembled
 * payload is cached. What is *not* cached is the link's own state: expiry and
 * the total cap were re-read from PostgreSQL by `resolveBookingLink` before
 * this is ever called, so a closed link can never be served from a warm cache.
 */
export async function getPublicConfig(resolved: ResolvedBookingLink): Promise<PublicBookingConfig> {
  const cacheKey = RedisKeys.bookingLinkConfig(resolved.link.slug);

  const cached = await cacheGet<PublicBookingConfig>(cacheKey);
  if (cached) return cached;

  const config = await buildConfig(resolved.link, resolved.business);
  await cacheSet(cacheKey, config, env.CACHE_BOOKING_LINK_TTL_SECONDS);
  return config;
}

/**
 * Refuses anything the link does not publish.
 *
 * This is the check that stops a slug from becoming a key to the whole
 * workspace. A real id that this link does not offer answers 404 rather than
 * 403, so the endpoint cannot be used to confirm which services, providers or
 * sites exist behind it.
 */
function assertOffered(
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

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** Strips a slot down to what a customer may see. */
function toPublicSlot(slot: AvailableSlot): PublicSlot {
  // `joinsAppointmentId` is an internal appointment UUID and must not survive
  // the trip: it identifies an existing group session and other people's
  // booking. Everything the client needs to book the slot is here without it.
  return {
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    staffProfileId: slot.staffProfileId,
    staffName: slot.staffName,
    locationId: slot.locationId,
    durationMinutes: slot.durationMinutes,
    priceAmount: slot.priceAmount,
    currency: slot.currency,
    ...(slot.remainingCapacity !== undefined ? { remainingCapacity: slot.remainingCapacity } : {}),
  };
}

export async function searchPublicAvailability(
  resolved: ResolvedBookingLink,
  query: PublicAvailabilityQuery,
): Promise<PublicAvailabilityResult> {
  const config = await getPublicConfig(resolved);
  assertOffered(config, query);

  const result = await searchAvailability({
    businessId: resolved.business.id,
    // Read from the freshly loaded row rather than the cached config: business
    // hours resolve against this zone, and scheduling must never run on a value
    // that could be two minutes stale.
    businessTimezone: resolved.business.timezone,
    serviceId: query.serviceId,
    // A link pinned to one provider or site narrows the search even when the
    // caller named neither.
    staffProfileId: query.staffProfileId ?? resolved.link.staffProfileId ?? null,
    locationId: query.locationId ?? resolved.link.locationId ?? null,
    fromDate: query.fromDate,
    toDate: query.toDate,
    timezone: query.timezone,
  });

  return {
    slots: result.slots.map(toPublicSlot),
    timezone: result.timezone,
    truncated: result.truncated,
    // A curated subset of the effective policy: what the form needs to render,
    // without publishing the workspace's internal load and throttling limits.
    service: {
      durationMinutes: result.policy.durationMinutes,
      priceAmount: result.policy.priceAmount,
      currency: result.policy.currency,
      capacity: result.policy.capacity,
      minNoticeMinutes: result.policy.minNoticeMinutes,
      maxHorizonDays: result.policy.maxHorizonDays,
      // The effective policy covers the service and the workspace; the link's
      // own flag is the layer it does not model, and it is ORed here exactly as
      // the booking path ORs it at commit.
      requiresApproval: result.policy.requiresApproval || resolved.link.requiresApproval,
    },
  };
}

// ---------------------------------------------------------------------------
// Booking form answers
// ---------------------------------------------------------------------------

/** Whether a submitted value is the right shape for the question that asked. */
function answerProblem(question: CustomQuestion, value: unknown): string | null {
  switch (question.type) {
    case 'NUMBER':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : `${question.label} must be a number.`;
    case 'CHECKBOX':
      return typeof value === 'boolean' ? null : `${question.label} must be true or false.`;
    case 'SELECT':
      return typeof value === 'string' && question.options.includes(value)
        ? null
        : `${question.label} must be one of the offered options.`;
    case 'MULTI_SELECT': {
      if (!Array.isArray(value)) return `${question.label} must be a list of options.`;
      if (value.length > MAX_SELECTED_OPTIONS) {
        return `${question.label} accepts at most ${MAX_SELECTED_OPTIONS} options.`;
      }
      const invalid = value.some(
        (item) => typeof item !== 'string' || !question.options.includes(item),
      );
      return invalid ? `${question.label} contains an option that is not offered.` : null;
    }
    default: {
      if (typeof value !== 'string') return `${question.label} must be text.`;
      return value.length > MAX_ANSWER_LENGTH
        ? `${question.label} must be ${MAX_ANSWER_LENGTH} characters or fewer.`
        : null;
    }
  }
}

/**
 * Checks the submitted answers against the questions this link actually asks,
 * and returns only those.
 *
 * `appointments.answers` is JSONB written straight from an anonymous request,
 * so it is filtered rather than merely validated: an unknown key is reported as
 * a client error *and* would be dropped, which keeps the column from becoming
 * unbounded attacker-controlled storage attached to a tenant's record.
 */
function validateAnswers(
  questions: CustomQuestion[],
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const details: ErrorDetail[] = [];
  const asked = new Set(questions.map((question) => question.key));
  const accepted: Record<string, unknown> = {};

  for (const key of Object.keys(answers)) {
    if (!asked.has(key)) {
      details.push({ field: `answers.${key}`, message: 'This booking form has no such question.' });
    }
  }

  for (const question of questions) {
    const value = answers[question.key];
    const empty =
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0);

    if (empty) {
      if (question.required) {
        details.push({
          field: `answers.${question.key}`,
          message: `${question.label} is required.`,
        });
      }
      continue;
    }

    const problem = answerProblem(question, value);
    if (problem) details.push({ field: `answers.${question.key}`, message: problem });
    else accepted[question.key] = value;
  }

  if (details.length > 0) {
    throw new ValidationError('Some answers on the booking form need attention.', details);
  }
  return accepted;
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

/**
 * Validates the optional `X-Idempotency-Key` header.
 *
 * Rejected rather than ignored when unusable: a client that believes it has
 * retry protection and does not is exactly how a customer ends up with two
 * appointments and two charges.
 */
export function readIdempotencyKey(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;

  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new ValidationError('The idempotency key cannot be used.', [
      {
        field: 'X-Idempotency-Key',
        message:
          'Use 16 to 200 characters from A-Z, a-z, 0-9, dot, colon, underscore or hyphen. ' +
          'A UUID is ideal — the key must be unguessable, not merely unique to you.',
      },
    ]);
  }
  return value;
}

/**
 * Finds the offered slot that starts at exactly this instant.
 *
 * Used only when the customer expressed no provider preference: rather than
 * reimplementing assignment, this re-runs the same search that produced the
 * times they were shown and takes the provider it attributes to that slot,
 * Smart Match ranking included. One calendar day is enough, because the day is
 * derived from the customer's own zone — the same zone that bounded the search
 * they picked the slot from.
 */
async function matchOfferedSlot(
  resolved: ResolvedBookingLink,
  input: CreatePublicBookingBody,
): Promise<AvailableSlot> {
  const date = toIsoDateInZone(input.startsAt, input.timezone);

  const result = await searchAvailability({
    businessId: resolved.business.id,
    businessTimezone: resolved.business.timezone,
    serviceId: input.serviceId,
    staffProfileId: null,
    locationId: input.locationId ?? resolved.link.locationId ?? null,
    fromDate: date,
    toDate: date,
    timezone: input.timezone,
  });

  const slot = result.slots.find(
    (candidate) => candidate.startsAt.getTime() === input.startsAt.getTime(),
  );
  if (!slot) {
    throw new SlotUnavailableError('That time is no longer available. Please pick another slot.');
  }
  return slot;
}

export async function createPublicBooking(
  resolved: ResolvedBookingLink,
  input: CreatePublicBookingBody,
  options: { idempotencyKey: string | null; metadata: RequestMetadata },
): Promise<PublicBookingConfirmation> {
  const config = await getPublicConfig(resolved);
  assertOffered(config, input);
  const answers = validateAnswers(config.questions, input.answers);

  // A link pinned to one provider books that provider whatever the form sent;
  // otherwise the customer's choice wins, and with no choice at all the
  // availability engine picks. `verifySlot` inside createBooking is the
  // authority either way — this only decides *who* is verified.
  const chosenStaffId = input.staffProfileId ?? resolved.link.staffProfileId ?? null;
  const matched = chosenStaffId === null ? await matchOfferedSlot(resolved, input) : null;
  const staffProfileId = chosenStaffId ?? matched?.staffProfileId;
  if (!staffProfileId) {
    throw new SlotUnavailableError('That time is no longer available. Please pick another slot.');
  }

  const result = await createBooking({
    businessId: resolved.business.id,
    serviceId: input.serviceId,
    staffProfileId,
    locationId: input.locationId ?? resolved.link.locationId ?? matched?.locationId ?? null,
    // The same two ids before Smart Match had a say in them. With no preference
    // expressed they are null, and stay null on a retry — which is what keeps a
    // retry that lands on a different provider a retry rather than a rejected
    // reuse of the idempotency key.
    requested: {
      staffProfileId: chosenStaffId,
      locationId: input.locationId ?? resolved.link.locationId ?? null,
    },
    startsAt: input.startsAt,
    timezone: input.timezone,
    customer: {
      firstName: input.customer.firstName,
      lastName: input.customer.lastName ?? null,
      email: input.customer.email,
      phone: input.customer.phone ?? null,
    },
    bookingLinkId: resolved.link.id,
    source: 'PUBLIC',
    customerNotes: input.customerNotes ?? null,
    answers,
    idempotencyKey: options.idempotencyKey,
    actor: { type: 'CUSTOMER', userId: null, label: input.customer.email },
    requestMetadata: options.metadata,
  });

  const { appointment, participant } = result;

  log.info(
    {
      slug: resolved.link.slug,
      appointmentPublicId: appointment.publicId,
      replayed: result.replayed,
    },
    'public booking confirmed',
  );

  return {
    appointment: {
      publicId: appointment.publicId,
      status: appointment.status,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      durationMinutes: appointment.durationMinutes,
      timezone: appointment.timezone,
      priceAmount: appointment.priceAmount,
      currency: appointment.currency,
      title: appointment.title,
      requiresApproval: appointment.requiresApproval,
      serviceId: appointment.serviceId,
      staffProfileId: appointment.staffProfileId,
      locationId: appointment.locationId,
    },
    participantPublicId: participant.publicId,
    manageUrl: manageUrlFor(appointment.publicId),
    replayed: result.replayed,
  };
}

// ---------------------------------------------------------------------------
// Managing one appointment
// ---------------------------------------------------------------------------

/**
 * Renders one appointment for the person holding its link.
 *
 * Everything loaded here is scoped to `appointment.businessId`, which came off
 * the appointment row itself — the caller supplied only an opaque handle and
 * has no way to point any of these lookups at another workspace.
 */
async function buildAppointmentView(appointment: Appointment): Promise<PublicAppointmentView> {
  const businessId = appointment.businessId;

  const [business, service, staffProfile, location, customer, settings] = await Promise.all([
    Business.findByPk(businessId),
    Service.findOne({ where: { id: appointment.serviceId, businessId } }),
    appointment.staffProfileId
      ? StaffProfile.findOne({ where: { id: appointment.staffProfileId, businessId } })
      : Promise.resolve(null),
    appointment.locationId
      ? Location.findOne({ where: { id: appointment.locationId, businessId } })
      : Promise.resolve(null),
    appointment.customerId
      ? Customer.findOne({ where: { id: appointment.customerId, businessId } })
      : Promise.resolve(null),
    settingsFor(businessId),
  ]);

  // A workspace that has been removed takes its appointments with it, and says
  // so with the same 404 an unknown handle gets.
  if (!business) throw new NotFoundError('Appointment');

  const isActive = ACTIVE_APPOINTMENT_STATUSES.includes(appointment.status);
  const noticeMinutes = differenceInMinutes(appointment.startsAt, new Date());
  const remainingReschedules = Math.max(
    0,
    settings.maxReschedulesPerAppointment - appointment.rescheduleCount,
  );

  return {
    publicId: appointment.publicId,
    status: appointment.status,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    durationMinutes: appointment.durationMinutes,
    timezone: appointment.timezone,
    priceAmount: appointment.priceAmount,
    currency: appointment.currency,
    title: appointment.title,
    customerNotes: appointment.customerNotes,
    answers: appointment.answers,
    requiresApproval: appointment.requiresApproval,
    confirmedAt: appointment.confirmedAt,
    cancelledAt: appointment.cancelledAt,
    cancellationReason: appointment.cancellationReason,
    rescheduleCount: appointment.rescheduleCount,
    service: service
      ? { id: service.id, name: service.name, description: service.description }
      : null,
    staff: staffProfile ? toStaffSummary(staffProfile) : null,
    location: location
      ? {
          ...toLocationSummary(location),
          // The room link is the one detail worth holding back until there is a
          // live booking to justify it, and worth withdrawing once there is not.
          virtualMeetingUrl: isActive ? location.virtualMeetingUrl : null,
        }
      : null,
    business: {
      name: business.name,
      logoUrl: business.logoUrl,
      timezone: business.timezone,
      supportEmail: business.supportEmail,
      supportPhone: business.supportPhone,
    },
    // Given name only. The handle in the URL behaves like a bearer token, so a
    // forwarded confirmation email must not hand on an email address or phone
    // number with it.
    customer: customer ? { firstName: customer.firstName, lastName: customer.lastName } : null,
    policy: {
      canCancel:
        isActive &&
        settings.allowCustomerCancel &&
        noticeMinutes >= settings.cancellationDeadlineMinutes,
      canReschedule:
        isActive &&
        settings.allowCustomerReschedule &&
        noticeMinutes >= settings.rescheduleDeadlineMinutes &&
        remainingReschedules > 0,
      cancellationDeadlineMinutes: settings.cancellationDeadlineMinutes,
      rescheduleDeadlineMinutes: settings.rescheduleDeadlineMinutes,
      remainingReschedules,
    },
    manageUrl: manageUrlFor(appointment.publicId),
  };
}

/**
 * The actor recorded against a customer-initiated change.
 *
 * The lifecycle service writes the audit row; giving it the customer id and
 * email here is what makes that row attributable to a person rather than to
 * "someone with the link".
 */
async function customerActorOf(appointment: Appointment): Promise<LifecycleActor> {
  const customer = appointment.customerId
    ? await Customer.findOne({
        where: { id: appointment.customerId, businessId: appointment.businessId },
        attributes: ['id', 'email'],
      })
    : null;

  return {
    type: 'CUSTOMER',
    userId: null,
    customerId: customer?.id ?? null,
    label: customer?.email ?? null,
  };
}

export async function getPublicAppointment(publicId: string): Promise<PublicAppointmentView> {
  return buildAppointmentView(await loadAppointmentByPublicId(publicId));
}

export async function reschedulePublicAppointment(
  publicId: string,
  input: ReschedulePublicAppointmentBody,
  metadata: RequestMetadata,
): Promise<PublicAppointmentView> {
  const appointment = await loadAppointmentByPublicId(publicId);

  const updated = await rescheduleAppointment({
    businessId: appointment.businessId,
    appointmentId: appointment.id,
    newStartsAt: input.startsAt,
    reason: input.reason ?? null,
    actor: await customerActorOf(appointment),
    metadata,
    // The notice deadline, the allow-customers switch and the reschedule cap
    // all apply: this request came from the customer, not from the business.
    enforceCustomerPolicy: true,
  });

  return buildAppointmentView(updated);
}

export async function cancelPublicAppointment(
  publicId: string,
  input: CancelPublicAppointmentBody,
  metadata: RequestMetadata,
): Promise<PublicAppointmentView> {
  const appointment = await loadAppointmentByPublicId(publicId);

  const cancelled = await cancelAppointment({
    businessId: appointment.businessId,
    appointmentId: appointment.id,
    reason: input.reason ?? null,
    actor: await customerActorOf(appointment),
    metadata,
    enforceCustomerPolicy: true,
  });

  return buildAppointmentView(cancelled);
}
