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
 */
import { Op } from 'sequelize';
import { env } from '../config/env';
import { createLogger } from '../config/logger';
import { ACTIVE_APPOINTMENT_STATUSES } from '../database/models/Appointment';
import {
  Appointment,
  AppointmentStaff,
  AvailabilityOverride,
  BlackoutPeriod,
  BusinessHours,
  BusinessSettings,
  Holiday,
  Location,
  Service,
  ServiceStaff,
  StaffAvailabilityRule,
  StaffProfile,
} from '../database/models';
import { NotFoundError, ValidationError } from '../utils/errors';
import {
  addMinutes,
  assertIsoDate,
  dayOfWeekForDate,
  eachDateInRange,
  daysBetween,
  isValidTimezone,
  resolveWallClock,
  toIsoDateInZone,
  type IsoDate,
} from '../utils/time';
import {
  generateSlots,
  isSlotBookable,
  type BusyInterval,
  type CandidateSlot,
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
    maxBookingsPerStaffPerDay: settings.maxBookingsPerStaffPerDay,
    priceAmount: serviceStaff?.priceAmountOverride ?? service.priceAmount,
    currency: service.currency,
  };
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

/** Resolves weekday wall-clock rules into instants for one calendar date. */
function resolveDayWindows(
  date: IsoDate,
  rules: WindowSource[],
  zone: string,
): Array<{ start: Date; end: Date; locationId: string | null }> {
  const dayOfWeek = dayOfWeekForDate(date);
  const windows: Array<{ start: Date; end: Date; locationId: string | null }> = [];

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

export interface WorkingWindowContext {
  businessId: string;
  businessTimezone: string;
  staffProfile: StaffProfile;
  locationId: string | null;
  dates: IsoDate[];
  /** Preloaded so a multi-staff search issues one query, not one per person. */
  businessHours: BusinessHours[];
  holidays: Holiday[];
  staffRules: StaffAvailabilityRule[];
  overrides: AvailabilityOverride[];
  locationTimezones: Map<string, string>;
}

/**
 * Computes the instants a staff member is genuinely available to be booked on
 * each requested date.
 */
export function computeWorkingWindows(context: WorkingWindowContext): WorkingWindow[] {
  const staffZone = context.staffProfile.timezone || context.businessTimezone;
  const result: WorkingWindow[] = [];

  const closedDates = new Set(
    context.holidays
      .filter((holiday) => holiday.closesBusiness && holiday.isActive)
      .flatMap((holiday) => {
        const iso = String(holiday.date);
        if (!holiday.isRecurringAnnually) return [iso];
        // A recurring holiday matches on month/day in every requested year.
        const [, month, day] = iso.split('-');
        return context.dates.filter((date) => date.slice(5) === `${month}-${day}`);
      }),
  );

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

    const businessZone =
      (context.locationId ? context.locationTimezones.get(context.locationId) : undefined) ??
      context.businessTimezone;

    const openWindows = resolveDayWindows(
      date,
      applicableHours.map((row) => ({
        dayOfWeek: row.dayOfWeek,
        startMinute: row.startMinute,
        endMinute: row.endMinute,
        locationId: row.locationId,
      })),
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

    let staffWindows = resolveDayWindows(
      date,
      activeRules.map((rule) => ({
        dayOfWeek: rule.dayOfWeek,
        startMinute: rule.startMinute,
        endMinute: rule.endMinute,
        locationId: rule.locationId,
      })),
      staffZone,
    );

    // 3. Date-specific overrides. `is_available = true` replaces the recurring
    //    rules for that date (working an unusual Saturday); `false` subtracts.
    const dayOverrides = context.overrides.filter((override) => String(override.date) === date);
    const additions = dayOverrides.filter((override) => override.isAvailable);
    const removals = dayOverrides.filter((override) => !override.isAvailable);

    if (additions.length > 0) {
      staffWindows = additions
        .map((override) => {
          const startMinute = override.startMinute ?? 0;
          const endMinute = override.endMinute ?? 1440;
          const start = resolveWallClock(date, startMinute, staffZone);
          const end = resolveWallClock(date, endMinute, staffZone);
          return end.instant > start.instant
            ? { start: start.instant, end: end.instant, locationId: override.locationId }
            : null;
        })
        .filter(
          (window): window is { start: Date; end: Date; locationId: string | null } =>
            window !== null,
        );
    }

    for (const removal of removals) {
      if (removal.startMinute === null || removal.endMinute === null) {
        staffWindows = []; // whole day off (leave, sickness)
        break;
      }
      const from = resolveWallClock(date, removal.startMinute, staffZone).instant;
      const to = resolveWallClock(date, removal.endMinute, staffZone).instant;
      staffWindows = staffWindows.flatMap((window) => {
        if (to <= window.start || from >= window.end) return [window];
        const remaining: typeof staffWindows = [];
        if (from > window.start) remaining.push({ ...window, end: from });
        if (to < window.end) remaining.push({ ...window, start: to });
        return remaining;
      });
    }

    // 4. Bookable time is where the business is open AND the staff are working.
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
  const horizonEnd = toIsoDateInZone(
    addMinutes(now, basePolicy.maxHorizonDays * 24 * 60),
    input.timezone,
  );
  const effectiveFrom =
    input.fromDate < toIsoDateInZone(now, input.timezone)
      ? toIsoDateInZone(now, input.timezone)
      : input.fromDate;
  const effectiveTo = input.toDate > horizonEnd ? horizonEnd : input.toDate;
  if (effectiveTo < effectiveFrom) {
    return { slots: [], policy: basePolicy, timezone: input.timezone, truncated: false };
  }

  const dates = eachDateInRange(effectiveFrom, effectiveTo);
  // Pad by a day either side: a window can start on the previous local day in
  // another zone, and overnight hours can run into the next.
  const rangeStart = resolveWallClock(effectiveFrom, 0, input.timezone).instant;
  const rangeEnd = resolveWallClock(effectiveTo, 1440, input.timezone).instant;
  const queryStart = addMinutes(rangeStart, -1440);
  const queryEnd = addMinutes(rangeEnd, 1440);

  // One query per kind of rule, covering every candidate provider.
  const [businessHours, holidays, staffRules, overrides, blackouts, locations] = await Promise.all([
    BusinessHours.findAll({ where: { businessId: input.businessId, isActive: true } }),
    Holiday.findAll({ where: { businessId: input.businessId, isActive: true } }),
    StaffAvailabilityRule.findAll({
      where: {
        businessId: input.businessId,
        staffProfileId: { [Op.in]: staffIds },
        isActive: true,
      },
    }),
    AvailabilityOverride.findAll({
      where: {
        businessId: input.businessId,
        [Op.or]: [{ staffProfileId: { [Op.in]: staffIds } }, { scope: 'BUSINESS' }],
        date: { [Op.between]: [effectiveFrom, effectiveTo] },
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

  const maxSlots = Math.min(input.limit ?? env.AVAILABILITY_MAX_SLOTS, env.AVAILABILITY_MAX_SLOTS);

  // Generate per provider, then merge.
  const perStaffSlots = new Map<string, CandidateSlot[]>();
  let truncated = false;

  for (const profile of staffProfiles) {
    const assignment = assignments.find((row) => row.staffProfileId === profile.id) ?? null;
    const policy = resolvePolicy(service, settings, profile, assignment);

    const windows = computeWorkingWindows({
      businessId: input.businessId,
      businessTimezone: input.businessTimezone,
      staffProfile: profile,
      locationId: input.locationId ?? profile.defaultLocationId ?? null,
      dates,
      businessHours,
      holidays,
      staffRules: staffRules.filter((rule) => rule.staffProfileId === profile.id),
      overrides: overrides.filter(
        (override) => override.staffProfileId === profile.id || override.scope === 'BUSINESS',
      ),
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
            (blackout.scope === 'LOCATION' && blackout.locationId === input.locationId),
        )
        .map((blackout) => ({
          start: blackout.startsAt,
          end: blackout.endsAt,
          reason: 'BLACKOUT' as const,
        })),
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
 * Re-validates one exact requested time.
 *
 * Called at booking confirmation, on the freshest possible data. This is the
 * "recompute eligibility" step of the booking transaction — the offered slot
 * may be seconds old, and the world may have moved.
 */
export async function verifySlot(input: {
  businessId: string;
  businessTimezone: string;
  serviceId: string;
  staffProfileId: string;
  locationId: string | null;
  startsAt: Date;
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
  const dates = [date];

  const [businessHours, holidays, staffRules, overrides, blackouts, locations] = await Promise.all([
    BusinessHours.findAll({ where: { businessId: input.businessId, isActive: true } }),
    Holiday.findAll({ where: { businessId: input.businessId, isActive: true } }),
    StaffAvailabilityRule.findAll({
      where: { businessId: input.businessId, staffProfileId: profile.id, isActive: true },
    }),
    AvailabilityOverride.findAll({
      where: {
        businessId: input.businessId,
        [Op.or]: [{ staffProfileId: profile.id }, { scope: 'BUSINESS' }],
        date,
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
  ]);

  const windows = computeWorkingWindows({
    businessId: input.businessId,
    businessTimezone: input.businessTimezone,
    staffProfile: profile,
    locationId: input.locationId ?? profile.defaultLocationId ?? null,
    dates,
    businessHours,
    holidays,
    staffRules,
    overrides,
    locationTimezones: new Map(locations.map((location) => [location.id, location.timezone])),
  });

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
          (blackout.scope === 'LOCATION' && blackout.locationId === input.locationId),
      )
      .map((blackout) => ({
        start: blackout.startsAt,
        end: blackout.endsAt,
        reason: 'BLACKOUT' as const,
      })),
  ];

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

  const reasons: Record<string, string> = {
    TOO_SOON: 'That time is inside the minimum booking notice for this service.',
    OUTSIDE_WORKING_HOURS: 'That time is outside the available hours for this service.',
    CONFLICT: 'That time is no longer available.',
    OUTSIDE_RANGE: 'That time is outside the bookable window.',
    LIMIT_REACHED: 'A booking limit has been reached for that time.',
  };
  return { ok: false, reason: reasons[verdict.reason ?? 'CONFLICT'], policy };
}
