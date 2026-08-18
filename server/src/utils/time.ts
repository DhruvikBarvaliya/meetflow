/**
 * Timezone and DST-safe time handling.
 *
 * MeetFlow's scheduling correctness rests on two rules, enforced here so no
 * call site has to remember them:
 *
 *  1. An *instant* is always a UTC `Date` (`timestamptz` in PostgreSQL).
 *  2. A *wall-clock rule* ("we open at 09:00 on Tuesdays") is a local time in a
 *     named IANA zone, and is only ever converted to an instant through Luxon.
 *
 * Manual offset arithmetic is banned: `+05:30` is a property of an instant in a
 * zone, not of the zone itself, and adding fixed offsets silently breaks every
 * DST transition. Everything below goes through Luxon's zone database.
 */
import { DateTime, IANAZone, Interval } from 'luxon';

/** Minutes from local midnight — how business/staff hours are stored. */
export type MinutesOfDay = number;

/** `YYYY-MM-DD`, a calendar date with no instant attached. */
export type IsoDate = string;

export const MINUTES_PER_DAY = 1440;

/** Sunday = 0 … Saturday = 6. Matches the `day_of_week` column and the UI. */
export const DAYS_OF_WEEK = [0, 1, 2, 3, 4, 5, 6] as const;
export type DayOfWeek = (typeof DAYS_OF_WEEK)[number];

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Zone validation
// ---------------------------------------------------------------------------

/** True for a real IANA identifier such as `Asia/Kolkata`. Rejects `+05:30`. */
export function isValidTimezone(zone: string): boolean {
  if (!zone || typeof zone !== 'string') return false;
  // A fixed-offset string is not a timezone: it cannot express DST.
  if (/^[+-]\d{2}:?\d{2}$/.test(zone)) return false;
  return IANAZone.isValidZone(zone);
}

export function assertValidTimezone(zone: string): void {
  if (!isValidTimezone(zone)) {
    throw new Error(
      `"${zone}" is not a valid IANA timezone identifier (expected e.g. "Asia/Kolkata").`,
    );
  }
}

// ---------------------------------------------------------------------------
// Calendar dates
// ---------------------------------------------------------------------------

export function isIsoDate(value: string): value is IsoDate {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  return DateTime.fromISO(value, { zone: 'utc' }).isValid;
}

export function assertIsoDate(value: string, label = 'date'): IsoDate {
  if (!isIsoDate(value)) {
    throw new Error(`${label} must be a calendar date formatted YYYY-MM-DD (received "${value}").`);
  }
  return value;
}

/** The calendar date an instant falls on, as seen from `zone`. */
export function toIsoDateInZone(instant: Date, zone: string): IsoDate {
  return DateTime.fromJSDate(instant, { zone }).toFormat('yyyy-MM-dd');
}

/** Today's calendar date in `zone` (not the server's local date). */
export function todayInZone(zone: string, now: Date = new Date()): IsoDate {
  return toIsoDateInZone(now, zone);
}

/** Sunday=0 … Saturday=6 for a calendar date. Zone-independent by definition. */
export function dayOfWeekForDate(date: IsoDate): DayOfWeek {
  // Luxon: 1 = Monday … 7 = Sunday. Modulo maps Sunday(7) -> 0.
  const weekday = DateTime.fromISO(date, { zone: 'utc' }).weekday;
  return (weekday % 7) as DayOfWeek;
}

/** Inclusive list of calendar dates. Purely calendar arithmetic, DST-immune. */
export function eachDateInRange(start: IsoDate, end: IsoDate): IsoDate[] {
  const first = DateTime.fromISO(start, { zone: 'utc' }).startOf('day');
  const last = DateTime.fromISO(end, { zone: 'utc' }).startOf('day');
  if (!first.isValid || !last.isValid || last < first) return [];

  const dates: IsoDate[] = [];
  for (let cursor = first; cursor <= last; cursor = cursor.plus({ days: 1 })) {
    dates.push(cursor.toFormat('yyyy-MM-dd'));
  }
  return dates;
}

export function addDaysToDate(date: IsoDate, days: number): IsoDate {
  return DateTime.fromISO(date, { zone: 'utc' }).plus({ days }).toFormat('yyyy-MM-dd');
}

export function daysBetween(start: IsoDate, end: IsoDate): number {
  const a = DateTime.fromISO(start, { zone: 'utc' }).startOf('day');
  const b = DateTime.fromISO(end, { zone: 'utc' }).startOf('day');
  return Math.round(b.diff(a, 'days').days);
}

// ---------------------------------------------------------------------------
// Wall-clock <-> instant conversion
// ---------------------------------------------------------------------------

/** What happened when a wall-clock time was resolved against a zone. */
export type WallClockResolution =
  | 'exact'
  /** The local time never happened (spring-forward gap) — shifted forward. */
  | 'skipped'
  /** The local time happened twice (fall-back overlap) — earliest offset used. */
  | 'ambiguous';

export interface ResolvedWallClock {
  instant: Date;
  resolution: WallClockResolution;
  /** UTC offset in minutes that actually applied at this instant. */
  offsetMinutes: number;
}

/**
 * Resolve "minutes-from-midnight on this local date in this zone" to an instant.
 *
 * Handles the two DST edge cases explicitly instead of pretending they cannot
 * happen:
 *
 *  - **Spring forward** (e.g. `America/New_York`, 2024-03-10, 02:30 does not
 *    exist). Luxon advances into the new offset; we report `skipped` so the
 *    scheduling engine can drop the slot rather than book a nonexistent time.
 *  - **Fall back** (e.g. `America/New_York`, 2024-11-03, 01:30 happens twice).
 *    We deterministically take the first (pre-transition) occurrence and report
 *    `ambiguous`.
 *
 * `minutes` may exceed 1440 to express times that roll into the following day,
 * which is how overnight business hours (22:00–02:00) are stored.
 */
export function resolveWallClock(
  date: IsoDate,
  minutes: MinutesOfDay,
  zone: string,
): ResolvedWallClock {
  const dayOffset = Math.floor(minutes / MINUTES_PER_DAY);
  const withinDay = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = Math.floor(withinDay / 60);
  const minute = withinDay % 60;

  // Calendar-add the day offset first, then pin the wall-clock time. Doing it
  // in this order keeps "the next day at 01:00 local" correct across a
  // transition, which `plus({ minutes })` would not.
  const targetDate = DateTime.fromISO(date, { zone: 'utc' }).plus({ days: dayOffset });
  const candidate = DateTime.fromObject(
    { year: targetDate.year, month: targetDate.month, day: targetDate.day, hour, minute },
    { zone },
  );

  if (!candidate.isValid) {
    throw new Error(
      `Unable to resolve ${date} +${minutes}m in zone "${zone}": ${candidate.invalidReason ?? 'invalid'}`,
    );
  }

  // Luxon silently shifts a nonexistent local time forward by the gap. If the
  // wall clock we got back is not the wall clock we asked for, the time was
  // skipped by a DST transition.
  const skipped = candidate.hour !== hour || candidate.minute !== minute;

  // Ambiguity: the same wall-clock reading occurs again one hour later in
  // absolute time, which only happens inside a fall-back overlap.
  const oneHourLater = DateTime.fromMillis(candidate.toMillis() + 3_600_000, { zone });
  const ambiguous =
    !skipped && oneHourLater.hour === candidate.hour && oneHourLater.minute === candidate.minute;

  return {
    instant: candidate.toJSDate(),
    resolution: skipped ? 'skipped' : ambiguous ? 'ambiguous' : 'exact',
    offsetMinutes: candidate.offset,
  };
}

/** Convenience wrapper when the caller does not care about DST metadata. */
export function wallClockToInstant(date: IsoDate, minutes: MinutesOfDay, zone: string): Date {
  return resolveWallClock(date, minutes, zone).instant;
}

/** Start of a calendar day in a zone, as an instant. */
export function startOfDayInZone(date: IsoDate, zone: string): Date {
  return DateTime.fromISO(date, { zone }).startOf('day').toJSDate();
}

/** Exclusive end of a calendar day in a zone (= start of the next day). */
export function endOfDayInZone(date: IsoDate, zone: string): Date {
  return DateTime.fromISO(date, { zone }).startOf('day').plus({ days: 1 }).toJSDate();
}

/** Minutes from local midnight for an instant, as read in `zone`. */
export function minutesOfDayInZone(instant: Date, zone: string): MinutesOfDay {
  const dt = DateTime.fromJSDate(instant, { zone });
  return dt.hour * 60 + dt.minute;
}

// ---------------------------------------------------------------------------
// Instant arithmetic
// ---------------------------------------------------------------------------

/**
 * Exact elapsed-time addition. Correct for durations (a 30-minute appointment
 * lasts 30 real minutes even across a DST boundary) — never use this to move a
 * wall-clock rule.
 */
export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}

export function differenceInMinutes(later: Date, earlier: Date): number {
  return (later.getTime() - earlier.getTime()) / 60_000;
}

/** Half-open overlap test: [aStart, aEnd) ∩ [bStart, bEnd) ≠ ∅. */
export function intervalsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

/** Rounds an instant up to the next multiple of `stepMinutes` past the hour. */
export function ceilToInterval(instant: Date, stepMinutes: number): Date {
  if (stepMinutes <= 0) return instant;
  const stepMs = stepMinutes * 60_000;
  return new Date(Math.ceil(instant.getTime() / stepMs) * stepMs);
}

// ---------------------------------------------------------------------------
// Formatting / presentation
// ---------------------------------------------------------------------------

export function toIsoString(instant: Date): string {
  return instant.toISOString();
}

/** ISO-8601 with the zone's real offset at that instant, e.g. for emails. */
export function formatInZone(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toISO() ?? instant.toISOString();
}

/** Human-readable rendering for notifications: "Tue 12 Aug 2025, 2:30 PM IST". */
export function formatForHumans(instant: Date, zone: string, locale = 'en-US'): string {
  return DateTime.fromJSDate(instant, { zone })
    .setLocale(locale)
    .toFormat('ccc d LLL yyyy, h:mm a ZZZZ');
}

export function minutesToHhMm(minutes: MinutesOfDay): string {
  const withinDay = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hh = String(Math.floor(withinDay / 60)).padStart(2, '0');
  const mm = String(withinDay % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Parses `HH:mm` (also accepts `24:00` to mean end-of-day). */
export function hhMmToMinutes(value: string): MinutesOfDay {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Expected a time formatted HH:mm (received "${value}").`);
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 24 || mins > 59 || (hours === 24 && mins !== 0)) {
    throw new Error(`"${value}" is not a valid time of day.`);
  }
  return hours * 60 + mins;
}

/** Zone offset in minutes at a given instant — for display only. */
export function zoneOffsetMinutes(zone: string, instant: Date = new Date()): number {
  return DateTime.fromJSDate(instant, { zone }).offset;
}

/** Short zone label at an instant ("IST", "EDT") — DST-accurate. */
export function zoneAbbreviation(zone: string, instant: Date = new Date()): string {
  return DateTime.fromJSDate(instant, { zone }).toFormat('ZZZZ');
}

/** True when `zone` observes DST during the 12 months following `from`. */
export function zoneObservesDst(zone: string, from: Date = new Date()): boolean {
  const start = DateTime.fromJSDate(from, { zone });
  for (let month = 0; month < 12; month += 1) {
    if (start.plus({ months: month }).offset !== start.offset) return true;
  }
  return false;
}

/** Merges overlapping/adjacent intervals — used to fold busy time together. */
export function mergeIntervals(
  intervals: Array<{ start: Date; end: Date }>,
): Array<{ start: Date; end: Date }> {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Array<{ start: Date; end: Date }> = [];
  let current = { start: sorted[0]!.start, end: sorted[0]!.end };

  for (const candidate of sorted.slice(1)) {
    if (candidate.start.getTime() <= current.end.getTime()) {
      if (candidate.end.getTime() > current.end.getTime())
        current = { ...current, end: candidate.end };
    } else {
      merged.push(current);
      current = { start: candidate.start, end: candidate.end };
    }
  }
  merged.push(current);
  return merged;
}

/** Subtracts busy intervals from a free window, returning the remaining gaps. */
export function subtractIntervals(
  window: { start: Date; end: Date },
  busy: Array<{ start: Date; end: Date }>,
): Array<{ start: Date; end: Date }> {
  const free: Array<{ start: Date; end: Date }> = [];
  let cursor = window.start;

  for (const block of mergeIntervals(busy)) {
    if (block.end <= window.start || block.start >= window.end) continue;
    if (block.start > cursor) free.push({ start: cursor, end: block.start });
    if (block.end > cursor) cursor = block.end;
    if (cursor >= window.end) break;
  }
  if (cursor < window.end) free.push({ start: cursor, end: window.end });
  return free;
}

/** Luxon Interval for callers that want richer range operations. */
export function toInterval(start: Date, end: Date): Interval {
  return Interval.fromDateTimes(DateTime.fromJSDate(start), DateTime.fromJSDate(end));
}
