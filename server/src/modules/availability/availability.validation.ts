/**
 * Availability request schemas.
 *
 * These are the single source of truth for the availability contract: the
 * runtime validation, the generated OpenAPI document and the frontend's
 * generated types all derive from them, so the three cannot drift apart.
 *
 * Two translations happen here rather than in the service, so the service only
 * ever handles storage-shaped values:
 *
 *  - `HH:mm` becomes minutes from local midnight. An end at or before the start
 *    is read as running into the next day, which is exactly what an
 *    `end_minute` above 1440 encodes (22:00–02:00 is stored as 1320–1560).
 *  - `scope` and the target ids are checked against the same rule the
 *    `*_scope_target_check` constraints enforce, so a bad combination is a
 *    readable 422 instead of a database error surfacing as a 500.
 */
import { z } from 'zod';
import {
  AVAILABILITY_OVERRIDE_REASONS,
  AVAILABILITY_OVERRIDE_SCOPES,
  type AvailabilityOverrideScope,
} from '../../database/models/AvailabilityOverride';
import {
  BLACKOUT_REASONS,
  BLACKOUT_SCOPES,
  type BlackoutScope,
} from '../../database/models/BlackoutPeriod';
import { MINUTES_PER_DAY, hhMmToMinutes, isIsoDate, minutesToHhMm } from '../../utils/time';

const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/** A week of split shifts across several sites, with room to spare. */
const MAX_WEEKLY_WINDOWS = 70;

const DAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const uuidSchema = z.string().uuid();

/** Sunday = 0 … Saturday = 6, matching the `day_of_week` column and the UI. */
const dayOfWeekSchema = z.number().int().min(0).max(6);

const HH_MM_PATTERN = /^(?:[01]?\d|2[0-4]):[0-5]\d$/;

const timeOfDaySchema = z
  .string()
  .trim()
  .regex(HH_MM_PATTERN, 'Use a 24-hour time formatted HH:mm, for example 09:00.')
  .refine(
    (value) => !value.startsWith('24:') || value === '24:00',
    'Midnight at the end of a day is 24:00; there is no other time in the 24th hour.',
  );

/**
 * `24:00` is midnight at the *end* of a day, so it can only close a window —
 * `start_minute` is constrained to 0..1439.
 */
const startTimeSchema = timeOfDaySchema.refine(
  (value) => value !== '24:00',
  'A window cannot start at 24:00. Use 00:00 for midnight at the start of the day.',
);

const isoDateSchema = z
  .string()
  .trim()
  .refine(isIsoDate, 'Use a calendar date formatted YYYY-MM-DD.');

/**
 * An instant, which must carry its offset (`Z` or `+05:30`). A bare local time
 * would be read in whichever zone the server happens to run in.
 */
const instantSchema = z
  .string()
  .datetime({
    offset: true,
    message: 'Use an ISO-8601 timestamp including its offset, e.g. 2025-03-01T09:00:00Z.',
  })
  .transform((value) => new Date(value));

const noteSchema = z.string().trim().max(1000).nullable().default(null);

/** Query strings are text: only these two literals are a boolean. */
const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');

const paginationShape = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

// ---------------------------------------------------------------------------
// Wall-clock windows
// ---------------------------------------------------------------------------

interface MinuteWindow {
  startMinute: number;
  endMinute: number;
}

/**
 * Normalises an `HH:mm` pair to minutes from local midnight.
 *
 * Callers must reject an end equal to the start first: rolling that forward
 * would silently turn "09:00 to 09:00" into a 24-hour shift.
 */
function toMinuteWindow(startTime: string, endTime: string): MinuteWindow {
  const startMinute = hhMmToMinutes(startTime);
  const closing = hhMmToMinutes(endTime);
  return {
    startMinute,
    endMinute: closing > startMinute ? closing : closing + MINUTES_PER_DAY,
  };
}

interface WeeklyWindow {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  isActive: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

function describeWindow(window: WeeklyWindow): string {
  const day = DAY_LABELS[window.dayOfWeek] ?? `day ${window.dayOfWeek}`;
  return `${day} ${minutesToHhMm(window.startMinute)}–${minutesToHhMm(window.endMinute)}`;
}

/**
 * The minutes-of-week spans a weekly window occupies.
 *
 * A Saturday-night window runs into Sunday morning; splitting it at the week
 * boundary keeps every comparison a plain half-open interval test, and means an
 * overnight window is checked against the *next day's* rows rather than only
 * against the ones sharing its weekday.
 */
function weekSpans(window: WeeklyWindow): MinuteWindow[] {
  const start = window.dayOfWeek * MINUTES_PER_DAY + window.startMinute;
  const end = window.dayOfWeek * MINUTES_PER_DAY + window.endMinute;
  if (end <= MINUTES_PER_WEEK) return [{ startMinute: start, endMinute: end }];
  return [
    { startMinute: start, endMinute: MINUTES_PER_WEEK },
    { startMinute: 0, endMinute: end - MINUTES_PER_WEEK },
  ];
}

function windowsCollide(left: WeeklyWindow, right: WeeklyWindow): boolean {
  return weekSpans(left).some((a) =>
    weekSpans(right).some((b) => a.startMinute < b.endMinute && b.startMinute < a.endMinute),
  );
}

/**
 * Whether two rules are ever in force on the same day.
 *
 * ISO `YYYY-MM-DD` strings order correctly under `<`, so the bounds are
 * compared as text rather than parsed into dates that would acquire a zone.
 */
function validityPeriodsIntersect(left: WeeklyWindow, right: WeeklyWindow): boolean {
  const leftFrom = left.effectiveFrom ?? null;
  const leftTo = left.effectiveTo ?? null;
  const rightFrom = right.effectiveFrom ?? null;
  const rightTo = right.effectiveTo ?? null;
  if (leftTo !== null && rightFrom !== null && leftTo < rightFrom) return false;
  if (rightTo !== null && leftFrom !== null && rightTo < leftFrom) return false;
  return true;
}

interface Collision {
  index: number;
  earlier: WeeklyWindow;
  later: WeeklyWindow;
}

/**
 * Deactivated rows are ignored: they describe a schedule that is not applied,
 * so two of them may sit on top of each other harmlessly.
 */
function findCollision(entries: readonly WeeklyWindow[]): Collision | null {
  const live = entries
    .map((entry, index) => ({ entry, index }))
    .filter((candidate) => candidate.entry.isActive);

  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const earlier = live[i];
      const later = live[j];
      if (!earlier || !later) continue;
      if (!validityPeriodsIntersect(earlier.entry, later.entry)) continue;
      if (windowsCollide(earlier.entry, later.entry)) {
        return { index: later.index, earlier: earlier.entry, later: later.entry };
      }
    }
  }
  return null;
}

function reportCollision(
  entries: readonly WeeklyWindow[],
  ctx: z.RefinementCtx,
  field: string,
): void {
  const collision = findCollision(entries);
  if (!collision) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [field, collision.index],
    message:
      `${describeWindow(collision.later)} overlaps ${describeWindow(collision.earlier)}. ` +
      'Split shifts must not intersect; use one row per uninterrupted window.',
  });
}

// ---------------------------------------------------------------------------
// Scope / target agreement
// ---------------------------------------------------------------------------

interface ScopedTarget {
  scope: AvailabilityOverrideScope | BlackoutScope;
  staffProfileId: string | null;
  locationId: string | null;
  resourceId: string | null;
}

/**
 * Mirrors `availability_overrides_scope_target_check` and
 * `blackout_periods_scope_target_check` exactly — including that a STAFF or
 * RESOURCE row may *also* carry a location, which narrows it to that site.
 */
function scopeTargetProblem(value: ScopedTarget): string | null {
  switch (value.scope) {
    case 'BUSINESS':
      return value.staffProfileId === null && value.locationId === null && value.resourceId === null
        ? null
        : 'A BUSINESS-scoped row covers the whole workspace and must name no target.';
    case 'LOCATION':
      return value.locationId !== null && value.staffProfileId === null && value.resourceId === null
        ? null
        : 'A LOCATION-scoped row must name locationId and nothing else.';
    case 'STAFF':
      return value.staffProfileId !== null && value.resourceId === null
        ? null
        : 'A STAFF-scoped row must name staffProfileId, may add locationId, and never resourceId.';
    case 'RESOURCE':
      return value.resourceId !== null && value.staffProfileId === null
        ? null
        : 'A RESOURCE-scoped row must name resourceId, may add locationId, and never staffProfileId.';
  }
}

function reportScopeTarget(value: ScopedTarget, ctx: z.RefinementCtx): void {
  const problem = scopeTargetProblem(value);
  if (problem) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scope'], message: problem });
  }
}

// ---------------------------------------------------------------------------
// Path parameters
// ---------------------------------------------------------------------------

export const idParamsSchema = z.object({ id: uuidSchema }).strict();

export const staffProfileIdParamsSchema = z.object({ staffProfileId: uuidSchema }).strict();

// ---------------------------------------------------------------------------
// Business hours
// ---------------------------------------------------------------------------

export const businessHoursEntrySchema = z
  .object({
    dayOfWeek: dayOfWeekSchema,
    startTime: startTimeSchema,
    endTime: timeOfDaySchema,
    isActive: z.boolean().default(true),
  })
  .strict()
  .refine((entry) => entry.startTime !== entry.endTime, {
    path: ['endTime'],
    message: 'A window must have a length. A day that is open end to end is 00:00–24:00.',
  })
  .transform((entry) => ({
    dayOfWeek: entry.dayOfWeek,
    isActive: entry.isActive,
    ...toMinuteWindow(entry.startTime, entry.endTime),
  }));

export const listBusinessHoursQuerySchema = z
  .object({
    ...paginationShape,
    // Omitting this returns the business-wide set — the same set PUT replaces
    // when its body carries no locationId, so one GET round-trips into one PUT.
    locationId: uuidSchema.optional(),
    isActive: booleanQuery.optional(),
  })
  .strict();

export const replaceBusinessHoursSchema = z
  .object({
    locationId: uuidSchema.nullable().default(null),
    // A full replacement, not a delta: an empty array is a valid instruction
    // meaning "this scope has no opening hours at all".
    hours: z.array(businessHoursEntrySchema).max(MAX_WEEKLY_WINDOWS),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Mirrors business_hours_unique_window, which ignores is_active — two rows
    // with the same start would be a database error rather than a 422.
    const starts = new Set<string>();
    value.hours.forEach((entry, index) => {
      const key = `${entry.dayOfWeek}:${entry.startMinute}`;
      if (starts.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['hours', index],
          message: `Two windows start at ${minutesToHhMm(entry.startMinute)} on ${
            DAY_LABELS[entry.dayOfWeek] ?? `day ${entry.dayOfWeek}`
          }.`,
        });
      }
      starts.add(key);
    });

    reportCollision(value.hours, ctx, 'hours');
  });

// ---------------------------------------------------------------------------
// Staff availability rules
// ---------------------------------------------------------------------------

export const staffAvailabilityRuleSchema = z
  .object({
    dayOfWeek: dayOfWeekSchema,
    startTime: startTimeSchema,
    endTime: timeOfDaySchema,
    /** NULL means the member works this window at any location. */
    locationId: uuidSchema.nullable().default(null),
    effectiveFrom: isoDateSchema.nullable().default(null),
    effectiveTo: isoDateSchema.nullable().default(null),
    isActive: z.boolean().default(true),
  })
  .strict()
  .refine((entry) => entry.startTime !== entry.endTime, {
    path: ['endTime'],
    message: 'A window must have a length. A day worked end to end is 00:00–24:00.',
  })
  .refine(
    (entry) =>
      entry.effectiveFrom === null ||
      entry.effectiveTo === null ||
      entry.effectiveTo >= entry.effectiveFrom,
    {
      path: ['effectiveTo'],
      message: 'A rule cannot stop applying before it starts.',
    },
  )
  .transform((entry) => ({
    dayOfWeek: entry.dayOfWeek,
    locationId: entry.locationId,
    effectiveFrom: entry.effectiveFrom,
    effectiveTo: entry.effectiveTo,
    isActive: entry.isActive,
    ...toMinuteWindow(entry.startTime, entry.endTime),
  }));

export const listStaffRulesQuerySchema = z
  .object({
    ...paginationShape,
    isActive: booleanQuery.optional(),
  })
  .strict();

export const replaceStaffRulesSchema = z
  .object({
    rules: z.array(staffAvailabilityRuleSchema).max(MAX_WEEKLY_WINDOWS),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Deliberately blind to locationId: one person cannot be at two sites at
    // once, so windows that overlap in time collide wherever they are worked.
    reportCollision(value.rules, ctx, 'rules');
  });

// ---------------------------------------------------------------------------
// Availability overrides
// ---------------------------------------------------------------------------

export const listOverridesQuerySchema = z
  .object({
    ...paginationShape,
    staffProfileId: uuidSchema.optional(),
    scope: z.enum(AVAILABILITY_OVERRIDE_SCOPES).optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  })
  .strict()
  .refine((query) => query.from === undefined || query.to === undefined || query.to >= query.from, {
    path: ['to'],
    message: 'The end of the range cannot precede its start.',
  });

export const createOverrideSchema = z
  .object({
    scope: z.enum(AVAILABILITY_OVERRIDE_SCOPES),
    staffProfileId: uuidSchema.nullable().default(null),
    locationId: uuidSchema.nullable().default(null),
    resourceId: uuidSchema.nullable().default(null),
    date: isoDateSchema,
    /** false removes time the recurring rules offer; true adds a window. */
    isAvailable: z.boolean(),
    startTime: startTimeSchema.nullable().default(null),
    endTime: timeOfDaySchema.nullable().default(null),
    reason: z.enum(AVAILABILITY_OVERRIDE_REASONS).nullable().default(null),
    note: noteSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    reportScopeTarget(value, ctx);

    // Mirrors availability_overrides_window_check: a half-specified window has
    // no meaning, and an all-day override is both bounds omitted.
    if ((value.startTime === null) !== (value.endTime === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endTime'],
        message:
          'Give both startTime and endTime for a partial-day override, or neither for a whole day.',
      });
      return;
    }
    if (value.startTime !== null && value.startTime === value.endTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endTime'],
        message: 'A window must have a length. Omit both times to cover the whole day.',
      });
    }
  })
  .transform((value) => ({
    scope: value.scope,
    staffProfileId: value.staffProfileId,
    locationId: value.locationId,
    resourceId: value.resourceId,
    date: value.date,
    isAvailable: value.isAvailable,
    reason: value.reason,
    note: value.note,
    ...(value.startTime === null || value.endTime === null
      ? { startMinute: null, endMinute: null }
      : toMinuteWindow(value.startTime, value.endTime)),
  }));

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

export const listHolidaysQuerySchema = z
  .object({
    ...paginationShape,
    locationId: uuidSchema.optional(),
    isActive: booleanQuery.optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  })
  .strict()
  .refine((query) => query.from === undefined || query.to === undefined || query.to >= query.from, {
    path: ['to'],
    message: 'The end of the range cannot precede its start.',
  });

export const createHolidaySchema = z
  .object({
    name: z.string().trim().min(1, 'A holiday needs a name.').max(160),
    date: isoDateSchema,
    /** NULL means every location observes it. */
    locationId: uuidSchema.nullable().default(null),
    /** Repeats on the same month and day every year; `date` is the first one. */
    isRecurringAnnually: z.boolean().default(false),
    /** false labels the day for customers without removing any availability. */
    closesBusiness: z.boolean().default(true),
    isActive: z.boolean().default(true),
  })
  .strict();

// ---------------------------------------------------------------------------
// Blackout periods
// ---------------------------------------------------------------------------

export const listBlackoutsQuerySchema = z
  .object({
    ...paginationShape,
    scope: z.enum(BLACKOUT_SCOPES).optional(),
    staffProfileId: uuidSchema.optional(),
    locationId: uuidSchema.optional(),
    resourceId: uuidSchema.optional(),
    from: instantSchema.optional(),
    to: instantSchema.optional(),
  })
  .strict()
  .refine((query) => query.from === undefined || query.to === undefined || query.to > query.from, {
    path: ['to'],
    message: 'The end of the range must be after its start.',
  });

export const createBlackoutSchema = z
  .object({
    scope: z.enum(BLACKOUT_SCOPES),
    staffProfileId: uuidSchema.nullable().default(null),
    locationId: uuidSchema.nullable().default(null),
    resourceId: uuidSchema.nullable().default(null),
    startsAt: instantSchema,
    endsAt: instantSchema,
    reason: z.enum(BLACKOUT_REASONS).default('CUSTOM'),
    note: noteSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    reportScopeTarget(value, ctx);

    if (value.endsAt <= value.startsAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'A blackout must end after it starts.',
      });
    }
  });

export type IdParams = z.infer<typeof idParamsSchema>;
export type StaffProfileIdParams = z.infer<typeof staffProfileIdParamsSchema>;
export type ListBusinessHoursQuery = z.infer<typeof listBusinessHoursQuerySchema>;
export type ReplaceBusinessHoursBody = z.infer<typeof replaceBusinessHoursSchema>;
export type BusinessHoursEntry = z.infer<typeof businessHoursEntrySchema>;
export type ListStaffRulesQuery = z.infer<typeof listStaffRulesQuerySchema>;
export type ReplaceStaffRulesBody = z.infer<typeof replaceStaffRulesSchema>;
export type StaffAvailabilityRuleEntry = z.infer<typeof staffAvailabilityRuleSchema>;
export type ListOverridesQuery = z.infer<typeof listOverridesQuerySchema>;
export type CreateOverrideBody = z.infer<typeof createOverrideSchema>;
export type ListHolidaysQuery = z.infer<typeof listHolidaysQuerySchema>;
export type CreateHolidayBody = z.infer<typeof createHolidaySchema>;
export type ListBlackoutsQuery = z.infer<typeof listBlackoutsQuerySchema>;
export type CreateBlackoutBody = z.infer<typeof createBlackoutSchema>;
