/**
 * Availability search.
 *
 * This is the bridge between stored *rules* and offered *times*. It loads the
 * relevant configuration, resolves every wall-clock rule to an instant in the
 * zone it was authored in, subtracts everything that blocks time, and hands the
 * result to the pure slot engine.
 *
 * Zone handling is the subtle part and is done deliberately:
 *   - business hours resolve in the **business** (or location) timezone;
 *   - staff working hours resolve in the **staff member's own** timezone;
 *   - the two are intersected as *instants*, never as clock readings.
 * A clinic open 09:00–17:00 in London staffed by someone working 09:00–17:00 in
 * Mumbai therefore correctly yields only the hours that genuinely overlap.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANT
 *
 *   A slot the search offers must never be refused at commit, and a slot the
 *   search hides must never be bookable.
 *
 * Both halves matter and they fail differently. Offering something that commit
 * refuses wastes the customer's time and reads as a broken product; hiding
 * something that is bookable quietly loses the business revenue it never learns
 * about. Every rule that can refuse a booking therefore has to be applied on
 * *both* paths, from the same source of truth:
 *
 *   - working hours, holidays, overrides and blackouts — resolved by
 *     `computeWorkingWindows`, which `searchAvailability` and `verifySlot` both
 *     call with the same inputs;
 *   - the booking horizon — `horizonDateInZone`, read in the same zone on both
 *     sides;
 *   - resource contention — the same arithmetic as `reserveResources` (see
 *     resourceEngine.ts), applied by the search so the room clash is not
 *     discovered as a 409 after the form is filled in;
 *   - daily booking caps — resolved into `EffectivePolicy` here, so the search
 *     hides capped days and `assertBookingLimits` refuses them at commit off
 *     the very same numbers.
 *
 * When a rule genuinely cannot live on both paths, the asymmetry is spelled out
 * where it is introduced, along with why it is safe.
 * ---------------------------------------------------------------------------
 */
import { Op } from 'sequelize';
import { env } from '../config/env';
import { createLogger } from '../config/logger';
import { ACTIVE_APPOINTMENT_STATUSES } from '../database/models/Appointment';
import {
  Appointment,
  AppointmentResource,
  AppointmentStaff,
  AvailabilityOverride,
  BlackoutPeriod,
  BusinessHours,
  BusinessSettings,
  Holiday,
  Location,
  Resource,
  Service,
  ServiceResourceRequirement,
  ServiceStaff,
  StaffAvailabilityRule,
  StaffProfile,
} from '../database/models';
import { NotFoundError, ValidationError } from '../utils/errors';
import {
  addDaysToDate,
  addMinutes,
  assertIsoDate,
  dayOfWeekForDate,
  eachDateInRange,
  daysBetween,
  endOfDayInZone,
  isValidTimezone,
  resolveWallClock,
  startOfDayInZone,
  subtractIntervals,
  toIsoDateInZone,
  type IsoDate,
} from '../utils/time';
import { computeResourceBusy, type ResourceDemand, type TimeSpan } from './resourceEngine';
import {
  generateSlots,
  isSlotBookable,
  type BusyInterval,
  type CandidateSlot,
  type RejectionReason,
  type WorkingWindow,
} from './slotEngine';
import { rankCandidates, type StaffCandidate } from './smartMatch';

const log = createLogger('availability');

// ---------------------------------------------------------------------------
// Effective policy resolution
// ---------------------------------------------------------------------------

/**
 * The scheduling rules that actually apply, after the
 * staff -> service -> business fallback chain.
 */
export interface EffectivePolicy {
  durationMinutes: number;
  preBufferMinutes: number;
  postBufferMinutes: number;
  slotIntervalMinutes: number;
  minNoticeMinutes: number;
  maxHorizonDays: number;
  capacity: number;
  requiresApproval: boolean;
  cancellationDeadlineMinutes: number;
  rescheduleDeadlineMinutes: number;
  maxReschedulesPerAppointment: number;
  allowCustomerCancel: boolean;
  allowCustomerReschedule: boolean;
  noShowGraceMinutes: number;
  maxBookingsPerCustomerPerDay: number | null;
  maxBookingsPerStaffPerDay: number | null;
  priceAmount: number;
  currency: string;
}

/** First non-null wins: staff override, then service override, then business. */
function firstDefined<T>(...values: Array<T | null | undefined>): T | undefined {
  for (const value of values) {
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

/**
 * The tighter of two ceilings, treating NULL as "no ceiling from this source".
 *
 * Unlike buffers or notice, where a staff value *replaces* the business value,
 * two daily caps are both limits on the same count: a workspace that allows
 * eight a day and a member who accepts four means four. Taking the first
 * non-null would let a generous workspace default silently raise a personal
 * cap.
 */
function tighterCap(...values: Array<number | null | undefined>): number | null {
  const caps = values.filter((value): value is number => value !== null && value !== undefined);
  return caps.length === 0 ? null : Math.min(...caps);
}

export function resolvePolicy(
  service: Service,
  settings: BusinessSettings,
  staffProfile?: StaffProfile | null,
  serviceStaff?: ServiceStaff | null,
): EffectivePolicy {
  return {
    // A senior provider may need longer for the same service.
    durationMinutes: serviceStaff?.durationMinutesOverride ?? service.durationMinutes,
    preBufferMinutes:
      firstDefined(staffProfile?.preBufferMinutes, service.preBufferMinutes) ??
      settings.defaultPreBufferMinutes,
    postBufferMinutes:
      firstDefined(staffProfile?.postBufferMinutes, service.postBufferMinutes) ??
      settings.defaultPostBufferMinutes,
    slotIntervalMinutes: service.slotIntervalMinutes ?? settings.slotIntervalMinutes,
    minNoticeMinutes:
      firstDefined(staffProfile?.minNoticeMinutes, service.minNoticeMinutes) ??
      settings.minNoticeMinutes,
    maxHorizonDays: service.maxHorizonDays ?? settings.maxHorizonDays,
    capacity: service.capacity,
    requiresApproval: service.requiresApproval || settings.requireApproval,
    cancellationDeadlineMinutes: settings.cancellationDeadlineMinutes,
    rescheduleDeadlineMinutes: settings.rescheduleDeadlineMinutes,
    maxReschedulesPerAppointment: settings.maxReschedulesPerAppointment,
    allowCustomerCancel: settings.allowCustomerCancel,
    allowCustomerReschedule: settings.allowCustomerReschedule,
    noShowGraceMinutes: settings.noShowGraceMinutes,
    maxBookingsPerCustomerPerDay:
      service.maxPerCustomerPerDay ?? settings.maxBookingsPerCustomerPerDay,
    // `staff_profiles.maxDailyAppointments` was, until now, only a *soft*
    // Smart Match factor: it pushed a near-capacity member down the ranking but
    // never stopped anyone booking them, so a member who had told the system
    // they take four a day was given a fifth without complaint. It is resolved
    // into the policy here rather than checked in the search, so it becomes a
    // hard gate on both paths at once — the search hides the capped day and
    // `assertBookingLimits` refuses it inside the booking transaction, off this
    // same number. Enforcing it in only one of the two would have broken the
    // invariant in one direction or the other. It stays a Smart Match factor as
    // well: spreading work out *before* anyone reaches their cap is a different
    // job from refusing the booking that would exceed it.
    maxBookingsPerStaffPerDay: tighterCap(
      staffProfile?.maxDailyAppointments,
      settings.maxBookingsPerStaffPerDay,
    ),
    priceAmount: serviceStaff?.priceAmountOverride ?? service.priceAmount,
    currency: service.currency,
  };
}

/**
 * The last calendar date the booking horizon reaches, seen from `zone`.
 *
 * The search clamp and the confirmation check both come through here instead of
 * each doing the arithmetic themselves. The horizon is a whole-day rule, so two
 * independent implementations could disagree about which day an instant belongs
 * to — and the moment they disagree the search offers a slot that confirmation
 * refuses, which is exactly the failure this helper exists to prevent.
 */
function horizonDateInZone(now: Date, maxHorizonDays: number, zone: string): IsoDate {
  return toIsoDateInZone(addMinutes(now, maxHorizonDays * 24 * 60), zone);
}

// ---------------------------------------------------------------------------
// Working windows
// ---------------------------------------------------------------------------

interface WindowSource {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  locationId: string | null;
}

/** A wall-clock rule resolved to instants, before any intersection. */
interface ResolvedWindow {
  start: Date;
  end: Date;
  locationId: string | null;
}

/** Resolves weekday wall-clock rules into instants for one calendar date. */
function resolveDayWindows(date: IsoDate, rules: WindowSource[], zone: string): ResolvedWindow[] {
  const dayOfWeek = dayOfWeekForDate(date);
  const windows: ResolvedWindow[] = [];

  for (const rule of rules) {
    if (rule.dayOfWeek !== dayOfWeek) continue;

    const start = resolveWallClock(date, rule.startMinute, zone);
    const end = resolveWallClock(date, rule.endMinute, zone);

    // A window whose start falls inside a DST spring-forward gap did not
    // happen. Dropping it is correct: offering 02:30 on a day when 02:30 does
    // not exist would produce an unbookable slot.
    if (start.resolution === 'skipped' && end.resolution === 'skipped') continue;
    if (end.instant <= start.instant) continue;

    windows.push({ start: start.instant, end: end.instant, locationId: rule.locationId });
  }
  return windows;
}

/** Intersection of two instant ranges, or null when they do not overlap. */
function intersect(
  a: { start: Date; end: Date },
  b: { start: Date; end: Date },
): { start: Date; end: Date } | null {
  const start = a.start > b.start ? a.start : b.start;
  const end = a.end < b.end ? a.end : b.end;
  return end > start ? { start, end } : null;
}

/**
 * Applies one date's exceptions to a set of resolved windows.
 *
 * `isAvailable = true` *replaces* the recurring windows for that date (working
 * an unusual Saturday, a branch opening specially for an event);
 * `isAvailable = false` subtracts from them, and a removal with no window at
 * all is a whole day gone — leave, sickness, a closure.
 *
 * Shared by both layers rather than written twice: opening hours and staff
 * hours obey identical exception semantics, and the only differences are which
 * rows apply and which zone the wall-clock minutes are read in. Two copies of
 * this is how the layers drifted apart in the first place.
 */
function applyOverrides(
  date: IsoDate,
  windows: ResolvedWindow[],
  overrides: AvailabilityOverride[],
  zone: string,
): ResolvedWindow[] {
  const forDate = overrides.filter((override) => String(override.date) === date);
  if (forDate.length === 0) return windows;

  const additions = forDate.filter((override) => override.isAvailable);
  const removals = forDate.filter((override) => !override.isAvailable);

  let result = windows;

  if (additions.length > 0) {
    result = additions
      .map((override) => {
        // A NULL window means the whole day; 1440 is midnight at the far end,
        // and `end_minute` may exceed it for a window running past midnight.
        const start = resolveWallClock(date, override.startMinute ?? 0, zone);
        const end = resolveWallClock(date, override.endMinute ?? 1440, zone);
        return end.instant > start.instant
          ? { start: start.instant, end: end.instant, locationId: override.locationId }
          : null;
      })
      .filter((window): window is ResolvedWindow => window !== null);
  }

  for (const removal of removals) {
    if (removal.startMinute === null || removal.endMinute === null) {
      result = []; // whole day off (leave, sickness, an unscheduled closure)
      break;
    }
    const from = resolveWallClock(date, removal.startMinute, zone).instant;
    const to = resolveWallClock(date, removal.endMinute, zone).instant;
    result = result.flatMap((window) => {
      if (to <= window.start || from >= window.end) return [window];
      const remaining: ResolvedWindow[] = [];
      if (from > window.start) remaining.push({ ...window, end: from });
      if (to < window.end) remaining.push({ ...window, start: to });
      return remaining;
    });
  }

  return result;
}

export interface WorkingWindowContext {
  businessId: string;
  businessTimezone: string;
  staffProfile: StaffProfile;
  /**
   * The location this search is for, already defaulted to the provider's own
   * (`input.locationId ?? profile.defaultLocationId`). It decides which
   * location-scoped configuration applies, so it must be the location the
   * appointment would actually be created at — booking resolves it the same
   * way, and anything else scopes holidays and overrides to a branch nobody is
   * being booked into.
   */
  locationId: string | null;
  /**
   * The calendar dates whose rules are resolved. Callers pad the range they
   * intend to *offer* by a day either side: a window belongs to the date it
   * starts on, so an overnight rule (22:00-02:00, stored as 1320-1560) puts
   * tomorrow's 00:30 inside today's window, and a zone difference between the
   * business and the customer can do the same at either end.
   */
  dates: IsoDate[];
  /** Preloaded so a multi-staff search issues one query, not one per person. */
  businessHours: BusinessHours[];
  holidays: Holiday[];
  staffRules: StaffAvailabilityRule[];
  /**
   * Every override for the business over `dates`, at any scope. Scoping is
   * resolved here rather than by the caller: this is the only place that knows
   * both the staff member and the location, and callers filtering it themselves
   * is precisely how LOCATION-scoped rows came to be dropped on both paths.
   */
  overrides: AvailabilityOverride[];
  locationTimezones: Map<string, string>;
}

/**
 * Computes the instants a staff member is genuinely available to be booked on
 * each requested date.
 *
 * Availability is an intersection, built in layers: when the business is open,
 * narrowed to when this person works, each layer carrying its own exceptions in
 * its own timezone.
 */
export function computeWorkingWindows(context: WorkingWindowContext): WorkingWindow[] {
  const staffZone = context.staffProfile.timezone || context.businessTimezone;
  const businessZone =
    (context.locationId ? context.locationTimezones.get(context.locationId) : undefined) ??
    context.businessTimezone;
  const result: WorkingWindow[] = [];

  const closedDates = new Set(
    context.holidays
      .filter((holiday) => holiday.closesBusiness && holiday.isActive)
      // A holiday closes the branch it is observed at. `location_id IS NULL`
      // means the whole workspace observes it; a row naming a location must not
      // reach past that location, or a bank holiday at one branch shuts every
      // other branch in the country along with it.
      .filter((holiday) => holiday.locationId === null || holiday.locationId === context.locationId)
      .flatMap((holiday) => {
        const iso = String(holiday.date);
        if (!holiday.isRecurringAnnually) return [iso];
        // A recurring holiday matches on month/day in every requested year.
        const [, month, day] = iso.split('-');
        return context.dates.filter((date) => date.slice(5) === `${month}-${day}`);
      }),
  );

  // Scope decides *what* an override modifies, not merely whether it applies.
  // A staff row changes when one person works; a business or location row
  // changes when the doors are open. Folding them all into the staff layer —
  // which is what this did — turns "the branch opens specially on Sunday" into
  // "everybody works Sunday", and reads business-wide rows in the staff
  // member's timezone rather than the workspace's.
  const openingOverrides = context.overrides.filter(
    (override) =>
      override.scope === 'BUSINESS' ||
      (override.scope === 'LOCATION' && override.locationId === context.locationId),
  );
  const staffOverrides = context.overrides.filter(
    (override) => override.scope === 'STAFF' && override.staffProfileId === context.staffProfile.id,
  );
  // RESOURCE-scoped rows are deliberately not here: they constrain rooms and
  // equipment, not people, and are applied against the resource pool instead
  // (see `resourceDemandsFor`). Treating them as staff leave would take a
  // provider off the diary because a room was being serviced.

  for (const date of context.dates) {
    if (closedDates.has(date)) continue;

    // 1. When is the business open? Location-specific rows, when present,
    //    replace the business-wide rows entirely for that location.
    const locationSpecific = context.businessHours.filter(
      (row) => row.locationId !== null && row.locationId === context.locationId && row.isActive,
    );
    const businessWide = context.businessHours.filter(
      (row) => row.locationId === null && row.isActive,
    );
    const applicableHours = locationSpecific.length > 0 ? locationSpecific : businessWide;

    const openWindows = applyOverrides(
      date,
      resolveDayWindows(
        date,
        applicableHours.map((row) => ({
          dayOfWeek: row.dayOfWeek,
          startMinute: row.startMinute,
          endMinute: row.endMinute,
          locationId: row.locationId,
        })),
        businessZone,
      ),
      openingOverrides,
      businessZone,
    );
    if (openWindows.length === 0) continue;

    // 2. When is this staff member working? Rules are authored in their zone.
    const activeRules = context.staffRules.filter((rule) => {
      if (!rule.isActive) return false;
      if (rule.effectiveFrom && date < String(rule.effectiveFrom)) return false;
      if (rule.effectiveTo && date > String(rule.effectiveTo)) return false;
      if (rule.locationId && context.locationId && rule.locationId !== context.locationId)
        return false;
      return true;
    });

    const staffWindows = applyOverrides(
      date,
      resolveDayWindows(
        date,
        activeRules.map((rule) => ({
          dayOfWeek: rule.dayOfWeek,
          startMinute: rule.startMinute,
          endMinute: rule.endMinute,
          locationId: rule.locationId,
        })),
        staffZone,
      ),
      staffOverrides,
      staffZone,
    );

    // 3. Bookable time is where the business is open AND the staff are working.
    for (const open of openWindows) {
      for (const working of staffWindows) {
        const overlap = intersect(open, working);
        if (overlap) {
          result.push({
            start: overlap.start,
            end: overlap.end,
            locationId: context.locationId ?? working.locationId ?? open.locationId,
          });
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/**
 * Everything needed to answer "can this service's rooms be found at time T?".
 *
 * Loaded once per search and shared across providers, because resource
 * contention is a property of the site and the service, not of the person.
 */
interface ResourceContext {
  businessTimezone: string;
  locationTimezones: Map<string, string>;
  requirements: ServiceResourceRequirement[];
  resources: Resource[];
  /** Reservations already held, over the queried window. */
  holds: AppointmentResource[];
  blackouts: BlackoutPeriod[];
  overrides: AvailabilityOverride[];
  /** The calendar dates the overrides were loaded for. */
  dates: IsoDate[];
  window: TimeSpan;
}

/**
 * When a single resource may not be used at all, ignoring what is booked in it.
 *
 * Blackouts and overrides are *configuration*, so they are honoured by the
 * search and by `verifySlot` alike: a room under maintenance is refused at
 * confirmation, not merely hidden. Reservations are the other half of the
 * story and are handled differently — see `resourceBusyFor`.
 */
function resourceUnavailableSpans(resource: Resource, context: ResourceContext): TimeSpan[] {
  // A resource's calendar day is read at the site it lives at; one that travels
  // with the appointment (`location_id IS NULL`) falls back to the workspace.
  const zone =
    (resource.locationId ? context.locationTimezones.get(resource.locationId) : undefined) ??
    context.businessTimezone;

  const spans: TimeSpan[] = context.blackouts
    .filter((blackout) => blackout.scope === 'RESOURCE' && blackout.resourceId === resource.id)
    .map((blackout) => ({ start: blackout.startsAt, end: blackout.endsAt }));

  const forResource = context.overrides.filter(
    (override) => override.scope === 'RESOURCE' && override.resourceId === resource.id,
  );

  for (const date of context.dates) {
    const onDate = forResource.filter((override) => String(override.date) === date);
    if (onDate.length === 0) continue;

    const dayStart = startOfDayInZone(date, zone);
    const dayEnd = endOfDayInZone(date, zone);

    const opened = onDate.filter((override) => override.isAvailable);
    if (opened.length > 0) {
      // An `is_available = true` row "replaces the usual rules for that day".
      // A resource has no recurring rules — its baseline is simply "available"
      // — so replacing that baseline with a window means the resource is
      // available *only* then, and the rest of the day is unavailable. Reading
      // it as a no-op would leave the row doing nothing at all, which is the
      // state this whole scope was in.
      spans.push(
        ...subtractIntervals(
          { start: dayStart, end: dayEnd },
          opened.map((override) => ({
            start: resolveWallClock(date, override.startMinute ?? 0, zone).instant,
            end: resolveWallClock(date, override.endMinute ?? 1440, zone).instant,
          })),
        ),
      );
    }

    for (const closed of onDate.filter((override) => !override.isAvailable)) {
      if (closed.startMinute === null || closed.endMinute === null) {
        spans.push({ start: dayStart, end: dayEnd });
        continue;
      }
      spans.push({
        start: resolveWallClock(date, closed.startMinute, zone).instant,
        end: resolveWallClock(date, closed.endMinute, zone).instant,
      });
    }
  }

  return spans;
}

/**
 * The candidate resources for one requirement at one location.
 *
 * Mirrors the `Resource.findAll` in `reserveResources` exactly, filter for
 * filter: a requirement names either one resource or a type, and a resource
 * pinned to a location can only serve that location while an unpinned one
 * travels. A search that considered a different candidate set from the one
 * booking reserves out of would hide bookable slots or offer unbookable ones.
 */
function candidatesFor(
  requirement: ServiceResourceRequirement,
  resources: Resource[],
  locationId: string | null,
): Resource[] {
  return resources.filter((resource) => {
    if (requirement.resourceId && resource.id !== requirement.resourceId) return false;
    if (requirement.resourceType && resource.type !== requirement.resourceType) return false;
    if (locationId && resource.locationId !== null && resource.locationId !== locationId) {
      return false;
    }
    return true;
  });
}

/**
 * Busy intervals arising from resource contention at one location.
 *
 * `reservations` decides whether the reservation half of the arithmetic is
 * applied. The search wants it; `verifySlot` deliberately does not, because it
 * is also the reschedule path and an appointment must not be blocked by the
 * room hold it already owns — the booking transaction re-checks that half under
 * a lock anyway, which is the only place it can be checked without a race.
 */
function resourceBusyFor(
  context: ResourceContext,
  locationId: string | null,
  options: { reservations: boolean } = { reservations: true },
): BusyInterval[] {
  if (context.requirements.length === 0) return [];

  const holdsByResource = new Map<string, TimeSpan[]>();
  if (options.reservations) {
    for (const hold of context.holds) {
      const list = holdsByResource.get(hold.resourceId) ?? [];
      // One span per *row*, not per unit on the row: `reserveResources` counts
      // rows against `capacity` and writes one row per resource it claims, so
      // reading `quantity` here would make a resource look busier than the
      // check that actually guards it.
      list.push({ start: hold.startsAt, end: hold.endsAt });
      holdsByResource.set(hold.resourceId, list);
    }
  }

  const unavailableByResource = new Map<string, TimeSpan[]>();
  const unavailableFor = (resource: Resource): TimeSpan[] => {
    const cached = unavailableByResource.get(resource.id);
    if (cached) return cached;
    const computed = resourceUnavailableSpans(resource, context);
    unavailableByResource.set(resource.id, computed);
    return computed;
  };

  const demands: ResourceDemand[] = context.requirements.map((requirement) => ({
    quantity: requirement.quantity,
    isRequired: requirement.isRequired,
    pool: candidatesFor(requirement, context.resources, locationId).map((resource) => ({
      resourceId: resource.id,
      capacity: resource.capacity,
      unavailable: unavailableFor(resource),
      reservations: holdsByResource.get(resource.id) ?? [],
    })),
  }));

  return computeResourceBusy(demands, context.window);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface AvailabilitySearchInput {
  businessId: string;
  businessTimezone: string;
  serviceId: string;
  staffProfileId?: string | null;
  teamId?: string | null;
  locationId?: string | null;
  fromDate: IsoDate;
  toDate: IsoDate;
  /** Customer's zone; used only to bound the search to their calendar days. */
  timezone: string;
  customerId?: string | null;
  limit?: number;
  explain?: boolean;
  now?: Date;
}

export interface AvailableSlot {
  startsAt: Date;
  endsAt: Date;
  staffProfileId: string;
  staffName: string;
  locationId: string | null;
  durationMinutes: number;
  priceAmount: number;
  currency: string;
  remainingCapacity?: number;
  joinsAppointmentId?: string;
  /** Populated in explain mode: why this provider was chosen for this time. */
  matchScore?: number;
  matchReason?: string;
}

export interface AvailabilitySearchResult {
  slots: AvailableSlot[];
  policy: EffectivePolicy;
  timezone: string;
  truncated: boolean;
  /** Providers considered, with their Smart Match scores, in explain mode. */
  candidates?: Array<{
    staffProfileId: string;
    displayName: string;
    score: number;
    reason: string;
  }>;
}

export async function searchAvailability(
  input: AvailabilitySearchInput,
): Promise<AvailabilitySearchResult> {
  const now = input.now ?? new Date();
  assertIsoDate(input.fromDate, 'fromDate');
  assertIsoDate(input.toDate, 'toDate');
  if (!isValidTimezone(input.timezone)) {
    throw new ValidationError('Invalid timezone.', [
      { field: 'timezone', message: 'Must be an IANA timezone identifier.' },
    ]);
  }

  const spanDays = daysBetween(input.fromDate, input.toDate);
  if (spanDays < 0) {
    throw new ValidationError('The end date must not precede the start date.');
  }
  if (spanDays + 1 > env.AVAILABILITY_MAX_RANGE_DAYS) {
    throw new ValidationError(
      `Availability can be queried for at most ${env.AVAILABILITY_MAX_RANGE_DAYS} days at a time.`,
      [{ field: 'toDate', message: `Requested ${spanDays + 1} days.` }],
    );
  }

  const service = await Service.findOne({
    where: { id: input.serviceId, businessId: input.businessId, isActive: true },
  });
  if (!service) throw new NotFoundError('Service');

  const [settings] = await BusinessSettings.findOrCreate({
    where: { businessId: input.businessId },
    defaults: { businessId: input.businessId },
  });

  // Candidate providers: assigned to the service, active and bookable.
  const assignments = await ServiceStaff.findAll({
    where: {
      serviceId: service.id,
      isActive: true,
      ...(input.staffProfileId ? { staffProfileId: input.staffProfileId } : {}),
    },
    include: [
      {
        model: StaffProfile,
        as: 'staffProfile',
        required: true,
        where: { businessId: input.businessId, isActive: true, isBookable: true },
      },
    ],
  });

  if (assignments.length === 0) {
    const basePolicy = resolvePolicy(service, settings);
    log.debug({ serviceId: service.id }, 'no bookable staff assigned to service');
    return { slots: [], policy: basePolicy, timezone: input.timezone, truncated: false };
  }

  const staffProfiles = assignments.map(
    (assignment) => assignment.get('staffProfile') as StaffProfile,
  );
  const staffIds = staffProfiles.map((profile) => profile.id);

  // Clamp the requested range to the booking horizon and the notice period.
  const basePolicy = resolvePolicy(service, settings);
  const horizonEnd = horizonDateInZone(now, basePolicy.maxHorizonDays, input.timezone);
  const effectiveFrom =
    input.fromDate < toIsoDateInZone(now, input.timezone)
      ? toIsoDateInZone(now, input.timezone)
      : input.fromDate;
  const effectiveTo = input.toDate > horizonEnd ? horizonEnd : input.toDate;
  if (effectiveTo < effectiveFrom) {
    return { slots: [], policy: basePolicy, timezone: input.timezone, truncated: false };
  }

  // The dates whose *rules* are resolved, padded by a day either side of the
  // range that will be offered. A window belongs to the date it starts on, so
  // an overnight rule (22:00–02:00, stored as 1320–1560) puts Tuesday's 00:30
  // inside Monday's window, and a business zone ahead of the customer's can
  // push the first hours of a local day into the previous one. This padding was
  // described in a comment here long before it existed: only the *database
  // queries* were padded, while the rules themselves were resolved for the bare
  // range, so the tail of every overnight window was silently dropped.
  const resolutionFrom = addDaysToDate(effectiveFrom, -1);
  const resolutionTo = addDaysToDate(effectiveTo, 1);
  const dates = eachDateInRange(resolutionFrom, resolutionTo);

  // The padded days widen the rules considered, never the answer: these two
  // bound what may actually be offered, and the slot engine clips to them.
  const rangeStart = resolveWallClock(effectiveFrom, 0, input.timezone).instant;
  const rangeEnd = resolveWallClock(effectiveTo, 1440, input.timezone).instant;
  const queryStart = addMinutes(rangeStart, -1440);
  const queryEnd = addMinutes(rangeEnd, 1440);

  // One query per kind of rule, covering every candidate provider.
  const [businessHours, holidays, staffRules, overrides, blackouts, locations, requirements] =
    await Promise.all([
      BusinessHours.findAll({ where: { businessId: input.businessId, isActive: true } }),
      Holiday.findAll({ where: { businessId: input.businessId, isActive: true } }),
      StaffAvailabilityRule.findAll({
        where: {
          businessId: input.businessId,
          staffProfileId: { [Op.in]: staffIds },
          isActive: true,
        },
      }),
      // Every scope that can affect this search, over the padded dates.
      // LOCATION rows were never loaded at all — the API accepted and stored
      // them and nothing ever read them back — and RESOURCE rows are needed by
      // the resource pool below. `computeWorkingWindows` decides which of them
      // apply to which layer; filtering by scope at the call site is how the
      // two paths drifted apart.
      AvailabilityOverride.findAll({
        where: {
          businessId: input.businessId,
          [Op.or]: [
            { staffProfileId: { [Op.in]: staffIds } },
            { scope: { [Op.in]: ['BUSINESS', 'LOCATION', 'RESOURCE'] } },
          ],
          date: { [Op.between]: [resolutionFrom, resolutionTo] },
        },
      }),
      BlackoutPeriod.findAll({
        where: {
          businessId: input.businessId,
          startsAt: { [Op.lt]: queryEnd },
          endsAt: { [Op.gt]: queryStart },
        },
      }),
      Location.findAll({
        where: { businessId: input.businessId, isActive: true },
        attributes: ['id', 'timezone'],
      }),
      ServiceResourceRequirement.findAll({ where: { serviceId: service.id } }),
    ]);

  const locationTimezones = new Map(locations.map((location) => [location.id, location.timezone]));

  // Existing reservations for these providers within the window.
  const reservations = await AppointmentStaff.findAll({
    where: {
      staffProfileId: { [Op.in]: staffIds },
      isBlocking: true,
      startsAt: { [Op.lt]: queryEnd },
      endsAt: { [Op.gt]: queryStart },
    },
  });

  // The resource pool, loaded only for services that actually need one — most
  // do not, and this is two extra round trips on the busiest read path there is.
  const resources = requirements.length
    ? await Resource.findAll({ where: { businessId: input.businessId, isActive: true } })
    : [];
  const resourceHolds = resources.length
    ? await AppointmentResource.findAll({
        where: {
          resourceId: { [Op.in]: resources.map((resource) => resource.id) },
          isActive: true,
          startsAt: { [Op.lt]: queryEnd },
          endsAt: { [Op.gt]: queryStart },
        },
      })
    : [];

  const resourceContext: ResourceContext = {
    businessTimezone: input.businessTimezone,
    locationTimezones,
    requirements,
    resources,
    holds: resourceHolds,
    blackouts,
    overrides,
    dates,
    window: { start: queryStart, end: queryEnd },
  };
  // Resource contention depends on the location, not on the provider, so
  // several providers at the same site share one computation.
  const resourceBusyByLocation = new Map<string, BusyInterval[]>();
  const resourceBusyAt = (locationId: string | null): BusyInterval[] => {
    const key = locationId ?? '';
    const cached = resourceBusyByLocation.get(key);
    if (cached) return cached;
    const computed = resourceBusyFor(resourceContext, locationId);
    resourceBusyByLocation.set(key, computed);
    return computed;
  };

  // Group services: appointments of THIS service with room left are offered as
  // joinable rather than treated as blocking.
  const joinableByStaff = new Map<
    string,
    Array<{ appointmentId: string; startsAt: Date; endsAt: Date; remainingCapacity: number }>
  >();
  if (service.capacity > 1) {
    const groupAppointments = await Appointment.findAll({
      where: {
        businessId: input.businessId,
        serviceId: service.id,
        status: { [Op.in]: [...ACTIVE_APPOINTMENT_STATUSES] },
        staffProfileId: { [Op.in]: staffIds },
        startsAt: { [Op.lt]: queryEnd },
        endsAt: { [Op.gt]: queryStart },
      },
    });
    for (const appointment of groupAppointments) {
      const remaining = appointment.capacity - appointment.bookedCount;
      if (remaining <= 0 || !appointment.staffProfileId) continue;
      const list = joinableByStaff.get(appointment.staffProfileId) ?? [];
      list.push({
        appointmentId: appointment.id,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        remainingCapacity: remaining,
      });
      joinableByStaff.set(appointment.staffProfileId, list);
    }
  }

  // Provider history, for the continuity factors in Smart Match.
  const previousProviders = new Set<string>();
  if (input.customerId) {
    const history = await Appointment.findAll({
      where: { businessId: input.businessId, customerId: input.customerId, status: 'COMPLETED' },
      attributes: ['staffProfileId'],
      limit: 50,
      order: [['startsAt', 'DESC']],
    });
    for (const appointment of history) {
      if (appointment.staffProfileId) previousProviders.add(appointment.staffProfileId);
    }
  }

  // ---- Daily booking caps -------------------------------------------------
  // Both caps are counted per calendar day in the **business** zone, because
  // that is the day `assertBookingLimits` counts when the booking is committed.
  // Reading the day in any other zone would make the search and the commit
  // disagree about which appointments fall on it, and the customer would be
  // offered a time that is refused a click later.
  // Most workspaces cap nothing, and this is the busiest read path in the
  // product: the day counts are only worth a query when some cap could bite.
  const capsApply =
    (Boolean(input.customerId) && basePolicy.maxBookingsPerCustomerPerDay !== null) ||
    settings.maxBookingsPerStaffPerDay !== null ||
    staffProfiles.some((profile) => profile.maxDailyAppointments !== null);

  const capDates = capsApply
    ? eachDateInRange(
        toIsoDateInZone(rangeStart, input.businessTimezone),
        toIsoDateInZone(addMinutes(rangeEnd, -1), input.businessTimezone),
      )
    : [];

  // Counting `Appointment` rows, not participants, and business-wide rather
  // than per service — again because that is exactly what the commit-time check
  // counts. A cap sourced from the service still applies across everything the
  // customer has booked that day.
  const cappedLoad =
    capDates.length > 0
      ? await Appointment.findAll({
          where: {
            businessId: input.businessId,
            status: { [Op.in]: [...ACTIVE_APPOINTMENT_STATUSES] },
            startsAt: {
              [Op.gte]: startOfDayInZone(capDates[0]!, input.businessTimezone),
              [Op.lt]: endOfDayInZone(capDates.at(-1)!, input.businessTimezone),
            },
            [Op.or]: [
              { staffProfileId: { [Op.in]: staffIds } },
              ...(input.customerId ? [{ customerId: input.customerId }] : []),
            ],
          },
          attributes: ['staffProfileId', 'customerId', 'startsAt'],
        })
      : [];

  const staffDayLoad = new Map<string, number>();
  const customerDayLoad = new Map<string, number>();
  for (const appointment of cappedLoad) {
    const date = toIsoDateInZone(appointment.startsAt, input.businessTimezone);
    if (appointment.staffProfileId) {
      const key = `${appointment.staffProfileId}|${date}`;
      staffDayLoad.set(key, (staffDayLoad.get(key) ?? 0) + 1);
    }
    if (input.customerId && appointment.customerId === input.customerId) {
      customerDayLoad.set(date, (customerDayLoad.get(date) ?? 0) + 1);
    }
  }

  /**
   * The days already at a cap, as instant spans the slot engine can subtract.
   *
   * The customer cap can only be applied when the caller says who is booking.
   * An anonymous search has no way to know, so those slots stay on offer and
   * the commit-time check remains the authority — the one direction of the
   * invariant that cannot be closed here.
   */
  const cappedDaysFor = (staffProfileId: string, policy: EffectivePolicy): TimeSpan[] => {
    const spans: TimeSpan[] = [];
    for (const date of capDates) {
      const staffFull =
        policy.maxBookingsPerStaffPerDay !== null &&
        (staffDayLoad.get(`${staffProfileId}|${date}`) ?? 0) >= policy.maxBookingsPerStaffPerDay;
      const customerFull =
        Boolean(input.customerId) &&
        policy.maxBookingsPerCustomerPerDay !== null &&
        (customerDayLoad.get(date) ?? 0) >= policy.maxBookingsPerCustomerPerDay;
      if (staffFull || customerFull) {
        spans.push({
          start: startOfDayInZone(date, input.businessTimezone),
          end: endOfDayInZone(date, input.businessTimezone),
        });
      }
    }
    return spans;
  };

  const maxSlots = Math.min(input.limit ?? env.AVAILABILITY_MAX_SLOTS, env.AVAILABILITY_MAX_SLOTS);

  // Generate per provider, then merge.
  const perStaffSlots = new Map<string, CandidateSlot[]>();
  let truncated = false;

  for (const profile of staffProfiles) {
    const assignment = assignments.find((row) => row.staffProfileId === profile.id) ?? null;
    const policy = resolvePolicy(service, settings, profile, assignment);
    // The branch this provider would actually be booked into. Booking resolves
    // it identically (`input.locationId ?? staffProfile.defaultLocationId`), so
    // every location-scoped rule below is read against the site the appointment
    // lands at rather than only when the caller happened to name one.
    const locationId = input.locationId ?? profile.defaultLocationId ?? null;

    const windows = computeWorkingWindows({
      businessId: input.businessId,
      businessTimezone: input.businessTimezone,
      staffProfile: profile,
      locationId,
      dates,
      businessHours,
      holidays,
      staffRules: staffRules.filter((rule) => rule.staffProfileId === profile.id),
      overrides,
      locationTimezones,
    });

    const joinable = joinableByStaff.get(profile.id) ?? [];
    const joinableIds = new Set(joinable.map((item) => item.appointmentId));

    const busy: BusyInterval[] = [
      ...reservations
        .filter((reservation) => reservation.staffProfileId === profile.id)
        .map((reservation) => ({
          start: reservation.startsAt,
          end: reservation.endsAt,
          reason: 'APPOINTMENT' as const,
        })),
      ...blackouts
        .filter(
          (blackout) =>
            blackout.scope === 'BUSINESS' ||
            (blackout.scope === 'STAFF' && blackout.staffProfileId === profile.id) ||
            // Matched against the effective location, not the requested one: a
            // maintenance closure at the branch this provider works from must
            // block them whether or not the customer filtered by location.
            (blackout.scope === 'LOCATION' && blackout.locationId === locationId),
        )
        .map((blackout) => ({
          start: blackout.startsAt,
          end: blackout.endsAt,
          reason: 'BLACKOUT' as const,
        })),
      // A required room that is already taken is as blocking as a booked
      // provider — and until now was the one constraint the search ignored and
      // the commit enforced.
      ...resourceBusyAt(locationId),
    ];

    const generated = generateSlots({
      rangeStart,
      rangeEnd,
      workingWindows: windows,
      busy,
      joinable,
      durationMinutes: policy.durationMinutes,
      preBufferMinutes: policy.preBufferMinutes,
      postBufferMinutes: policy.postBufferMinutes,
      slotIntervalMinutes: policy.slotIntervalMinutes,
      minNoticeMinutes: policy.minNoticeMinutes,
      limitReached: cappedDaysFor(profile.id, policy),
      now,
      maxSlots,
      explain: input.explain,
    });

    truncated = truncated || generated.truncated;
    // A joinable group appointment is surfaced even though its own reservation
    // makes the time look busy; everything else came from free time.
    perStaffSlots.set(
      profile.id,
      generated.slots.filter(
        (slot) => !slot.joinsAppointmentId || joinableIds.has(slot.joinsAppointmentId),
      ),
    );
  }

  // Rank providers once, then attribute each distinct start time to the best
  // available one — unless the customer asked for a specific person.
  const loadByStaff = new Map<string, number>();
  for (const reservation of reservations) {
    loadByStaff.set(
      reservation.staffProfileId,
      (loadByStaff.get(reservation.staffProfileId) ?? 0) + 1,
    );
  }

  const candidates: StaffCandidate[] = staffProfiles.map((profile) => {
    const assignment = assignments.find((row) => row.staffProfileId === profile.id);
    return {
      staffProfileId: profile.id,
      displayName: profile.displayName,
      priority: assignment?.priority ?? 0,
      weight: assignment?.weight ?? profile.assignmentWeight,
      currentLoad: loadByStaff.get(profile.id) ?? 0,
      maxDailyAppointments: profile.maxDailyAppointments,
      lastAssignedAt: profile.lastAssignedAt,
      isPreviousProvider: previousProviders.has(profile.id),
      isPreferredProvider: false,
      servesRequestedLocation: !input.locationId || profile.defaultLocationId === input.locationId,
    };
  });

  const ranked = rankCandidates(candidates, {
    now,
    strategy: service.assignmentStrategy,
  });
  const rankIndex = new Map(ranked.map((entry, index) => [entry.candidate.staffProfileId, index]));
  const profileById = new Map(staffProfiles.map((profile) => [profile.id, profile]));

  const byStart = new Map<number, AvailableSlot>();
  for (const [staffProfileId, slots] of perStaffSlots) {
    const profile = profileById.get(staffProfileId)!;
    const assignment = assignments.find((row) => row.staffProfileId === staffProfileId) ?? null;
    const policy = resolvePolicy(service, settings, profile, assignment);
    const rankedEntry = ranked[rankIndex.get(staffProfileId) ?? 0];

    for (const slot of slots) {
      const key = slot.startsAt.getTime();
      const existing = byStart.get(key);

      // When the customer named a provider there is nothing to choose between;
      // otherwise the better-ranked provider owns the time.
      const better =
        !existing ||
        (rankIndex.get(staffProfileId) ?? 99) < (rankIndex.get(existing.staffProfileId) ?? 99);

      if (input.staffProfileId || better) {
        byStart.set(key, {
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          staffProfileId,
          staffName: profile.displayName,
          locationId: slot.locationId,
          durationMinutes: policy.durationMinutes,
          priceAmount: policy.priceAmount,
          currency: policy.currency,
          ...(slot.remainingCapacity !== undefined
            ? { remainingCapacity: slot.remainingCapacity }
            : {}),
          ...(slot.joinsAppointmentId ? { joinsAppointmentId: slot.joinsAppointmentId } : {}),
          ...(input.explain && rankedEntry
            ? {
                matchScore: rankedEntry.score,
                matchReason: rankedEntry.factors.map((factor) => factor.reason).join(' '),
              }
            : {}),
        });
      }
    }
  }

  const slots = [...byStart.values()]
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .slice(0, maxSlots);

  return {
    slots,
    policy: basePolicy,
    timezone: input.timezone,
    truncated: truncated || byStart.size > maxSlots,
    ...(input.explain
      ? {
          candidates: ranked.map((entry) => ({
            staffProfileId: entry.candidate.staffProfileId,
            displayName: entry.candidate.displayName,
            score: entry.score,
            reason: entry.factors.map((factor) => factor.reason).join(' '),
          })),
        }
      : {}),
  };
}

/**
 * The effective policy for a service/provider pairing, without validating any
 * particular time.
 *
 * Used by the booking path when a customer joins an existing group session:
 * that session's slot was validated when it was created, so re-running slot
 * verification would only rediscover the session's own reservation and refuse.
 */
export async function getPolicyFor(input: {
  businessId: string;
  serviceId: string;
  staffProfileId: string;
}): Promise<EffectivePolicy> {
  const service = await Service.findOne({
    where: { id: input.serviceId, businessId: input.businessId, isActive: true },
  });
  if (!service) throw new NotFoundError('Service');

  const [settings] = await BusinessSettings.findOrCreate({
    where: { businessId: input.businessId },
    defaults: { businessId: input.businessId },
  });

  const profile = await StaffProfile.findOne({
    where: { id: input.staffProfileId, businessId: input.businessId },
  });
  if (!profile) throw new NotFoundError('Staff member');

  const assignment = await ServiceStaff.findOne({
    where: { serviceId: service.id, staffProfileId: profile.id, isActive: true },
  });

  return resolvePolicy(service, settings, profile, assignment);
}

/**
 * Customer-facing wording for every way a requested time can be refused.
 *
 * Keyed on the engine's rejection reasons so a new reason cannot be introduced
 * without wording to go with it.
 */
const REFUSAL_MESSAGES: Record<RejectionReason, string> = {
  TOO_SOON: 'That time is inside the minimum booking notice for this service.',
  OUTSIDE_WORKING_HOURS: 'That time is outside the available hours for this service.',
  CONFLICT: 'That time is no longer available.',
  OUTSIDE_RANGE: 'That time is further ahead than this service can be booked.',
  LIMIT_REACHED: 'A booking limit has been reached for that time.',
};

/**
 * Re-validates one exact requested time.
 *
 * Called at booking confirmation, on the freshest possible data. This is the
 * "recompute eligibility" step of the booking transaction — the offered slot
 * may be seconds old, and the world may have moved.
 *
 * Both edges of the bookable window are enforced here: the minimum notice
 * (inside `isSlotBookable`) and the booking horizon. Neither can be left to the
 * search, because a caller who names a provider and posts a start time never
 * runs a search at all.
 */
export async function verifySlot(input: {
  businessId: string;
  businessTimezone: string;
  serviceId: string;
  staffProfileId: string;
  locationId: string | null;
  startsAt: Date;
  /**
   * The zone the availability search ran in — the customer's own, on a booking
   * path. The horizon is a calendar-day rule and which day an instant falls on
   * depends on who is asking, so confirmation must read the date in the same
   * zone the search read it in. Defaults to the business zone for callers that
   * never ran a search.
   */
  timezone?: string | null;
  now?: Date;
}): Promise<{ ok: boolean; reason?: string; policy: EffectivePolicy }> {
  const now = input.now ?? new Date();

  const service = await Service.findOne({
    where: { id: input.serviceId, businessId: input.businessId, isActive: true },
  });
  if (!service) throw new NotFoundError('Service');

  const [settings] = await BusinessSettings.findOrCreate({
    where: { businessId: input.businessId },
    defaults: { businessId: input.businessId },
  });

  const profile = await StaffProfile.findOne({
    where: {
      id: input.staffProfileId,
      businessId: input.businessId,
      isActive: true,
      isBookable: true,
    },
  });
  if (!profile) throw new NotFoundError('Staff member');

  const assignment = await ServiceStaff.findOne({
    where: { serviceId: service.id, staffProfileId: profile.id, isActive: true },
  });
  if (!assignment) {
    return {
      ok: false,
      reason: 'This staff member no longer offers this service.',
      policy: resolvePolicy(service, settings, profile),
    };
  }

  const policy = resolvePolicy(service, settings, profile, assignment);
  const staffZone = profile.timezone || input.businessTimezone;
  const date = toIsoDateInZone(input.startsAt, staffZone);
  // The neighbouring dates are resolved too, for exactly the reason the search
  // pads its range: a window belongs to the date it *starts* on, so a 00:30
  // start sits inside the previous day's 22:00–02:00 rule and inside no rule of
  // its own date at all. Resolving one date only is what let the search offer
  // overnight slots that this check then refused as OUTSIDE_WORKING_HOURS —
  // times a customer could see, choose, and never book.
  const dates = [addDaysToDate(date, -1), date, addDaysToDate(date, 1)];
  // Booking creates the appointment at the caller's location or the provider's
  // default; location-scoped rules must be read against that same site.
  const locationId = input.locationId ?? profile.defaultLocationId ?? null;

  const [businessHours, holidays, staffRules, overrides, blackouts, locations, requirements] =
    await Promise.all([
      BusinessHours.findAll({ where: { businessId: input.businessId, isActive: true } }),
      Holiday.findAll({ where: { businessId: input.businessId, isActive: true } }),
      StaffAvailabilityRule.findAll({
        where: { businessId: input.businessId, staffProfileId: profile.id, isActive: true },
      }),
      // Same scopes the search loads, so the two cannot resolve a different set
      // of rules for the same instant.
      AvailabilityOverride.findAll({
        where: {
          businessId: input.businessId,
          [Op.or]: [
            { staffProfileId: profile.id },
            { scope: { [Op.in]: ['BUSINESS', 'LOCATION', 'RESOURCE'] } },
          ],
          date: { [Op.in]: dates },
        },
      }),
      BlackoutPeriod.findAll({
        where: {
          businessId: input.businessId,
          startsAt: { [Op.lt]: addMinutes(input.startsAt, policy.durationMinutes + 1440) },
          endsAt: { [Op.gt]: addMinutes(input.startsAt, -1440) },
        },
      }),
      Location.findAll({
        where: { businessId: input.businessId, isActive: true },
        attributes: ['id', 'timezone'],
      }),
      ServiceResourceRequirement.findAll({ where: { serviceId: service.id } }),
    ]);

  const locationTimezones = new Map(locations.map((location) => [location.id, location.timezone]));

  const windows = computeWorkingWindows({
    businessId: input.businessId,
    businessTimezone: input.businessTimezone,
    staffProfile: profile,
    locationId,
    dates,
    businessHours,
    holidays,
    staffRules,
    overrides,
    locationTimezones,
  });

  // Only services that need a room pay for this lookup.
  const resources = requirements.length
    ? await Resource.findAll({ where: { businessId: input.businessId, isActive: true } })
    : [];

  const reservations = await AppointmentStaff.findAll({
    where: {
      staffProfileId: profile.id,
      isBlocking: true,
      startsAt: {
        [Op.lt]: addMinutes(input.startsAt, policy.durationMinutes + policy.postBufferMinutes),
      },
      endsAt: { [Op.gt]: addMinutes(input.startsAt, -policy.preBufferMinutes) },
    },
  });

  const busy: BusyInterval[] = [
    ...reservations.map((reservation) => ({
      start: reservation.startsAt,
      end: reservation.endsAt,
      reason: 'APPOINTMENT' as const,
    })),
    ...blackouts
      .filter(
        (blackout) =>
          blackout.scope === 'BUSINESS' ||
          (blackout.scope === 'STAFF' && blackout.staffProfileId === profile.id) ||
          // The effective location again: a caller who named no location is
          // still booked into the provider's default one, and a closure there
          // has to refuse them.
          (blackout.scope === 'LOCATION' && blackout.locationId === locationId),
      )
      .map((blackout) => ({
        start: blackout.startsAt,
        end: blackout.endsAt,
        reason: 'BLACKOUT' as const,
      })),
    // Resource *configuration* only — a blacked-out or closed room refuses the
    // booking here rather than merely vanishing from the search. Existing
    // resource holds are deliberately excluded: this function also validates
    // reschedules, where the appointment being moved owns a hold of its own,
    // and counting it would make an appointment conflict with itself. That half
    // is enforced by `reserveResources` inside the booking transaction, under
    // the row lock and exclusion constraint that make it race-free.
    ...resourceBusyFor(
      {
        businessTimezone: input.businessTimezone,
        locationTimezones,
        requirements,
        resources,
        holds: [],
        blackouts,
        overrides,
        dates,
        window: {
          start: addMinutes(input.startsAt, -policy.preBufferMinutes),
          end: addMinutes(input.startsAt, policy.durationMinutes + policy.postBufferMinutes),
        },
      },
      locationId,
      { reservations: false },
    ),
  ];

  // The booking horizon is the far edge of the window whose near edge the
  // minimum notice guards below, so the two checks sit together. The search
  // clamps its range to the horizon, but that clamp protects only callers who
  // went through the search: naming a provider and posting a start time reaches
  // confirmation directly, and without this could book years past the horizon
  // the workspace publishes on its own booking page.
  //
  // Boundary: the search offers the *whole* of the horizon date — it clamps
  // `effectiveTo` to that date inclusive and runs the range to its final minute
  // — so a start on that date is accepted here and only later dates refused.
  // Both sides derive the date from `horizonDateInZone` in the same zone, which
  // is what guarantees a slot the search offered is never refused at commit.
  const zone = input.timezone ?? input.businessTimezone;
  if (toIsoDateInZone(input.startsAt, zone) > horizonDateInZone(now, policy.maxHorizonDays, zone)) {
    return { ok: false, reason: REFUSAL_MESSAGES.OUTSIDE_RANGE, policy };
  }

  const verdict = isSlotBookable({
    startsAt: input.startsAt,
    durationMinutes: policy.durationMinutes,
    preBufferMinutes: policy.preBufferMinutes,
    postBufferMinutes: policy.postBufferMinutes,
    workingWindows: windows,
    busy,
    minNoticeMinutes: policy.minNoticeMinutes,
    now,
  });

  if (verdict.bookable) return { ok: true, policy };

  return { ok: false, reason: REFUSAL_MESSAGES[verdict.reason ?? 'CONFLICT'], policy };
}
