/**
 * The slot engine.
 *
 * Deliberately pure: it takes already-resolved instants and returns candidate
 * slots. It performs no I/O, reads no clock of its own, and knows nothing about
 * Sequelize — which is what makes DST behaviour, buffer arithmetic and booking
 * limits exhaustively unit-testable without a database.
 *
 * Timezone work happens *before* this file (see availability.service.ts, which
 * uses utils/time.ts to turn wall-clock rules into instants). By the time
 * anything gets here, every boundary is an absolute UTC instant.
 *
 * The engine exists to serve one invariant, which availability.service.ts
 * states in full: **a slot the search offers must never be refused at commit,
 * and a slot the search hides must never be bookable.** Every constraint that
 * can refuse a booking therefore has to be expressible here — which is why
 * resource contention and daily booking caps are inputs rather than something
 * only the confirmation path knows about.
 */
import { addMinutes, intervalsOverlap, mergeIntervals } from '../utils/time';

/** Why a span of time is unavailable. Surfaced in explain mode and the UI. */
export type BusyReason =
  'APPOINTMENT' | 'BLACKOUT' | 'OVERRIDE' | 'HOLIDAY' | 'RESOURCE' | 'LOCATION_CLOSED';

export interface BusyInterval {
  /** Already includes the blocking appointment's own buffers. */
  start: Date;
  end: Date;
  reason: BusyReason;
}

/** A span the provider is actually working, resolved from rules + overrides. */
export interface WorkingWindow {
  start: Date;
  end: Date;
  locationId: string | null;
}

/**
 * An existing group appointment with room left. Offered as a joinable slot
 * instead of being treated as busy, so a yoga class with 6 of 20 places taken
 * still appears as bookable.
 */
export interface JoinableAppointment {
  appointmentId: string;
  startsAt: Date;
  endsAt: Date;
  remainingCapacity: number;
}

export interface SlotEngineInput {
  /** Absolute search window. The caller has already clamped it to the horizon. */
  rangeStart: Date;
  rangeEnd: Date;
  workingWindows: WorkingWindow[];
  busy: BusyInterval[];
  joinable?: JoinableAppointment[];

  durationMinutes: number;
  preBufferMinutes: number;
  postBufferMinutes: number;
  /** Grid granularity. Candidate starts are aligned to this from each window. */
  slotIntervalMinutes: number;
  /** Earliest a booking may be made, relative to `now`. */
  minNoticeMinutes: number;

  /**
   * Spans in which a daily booking cap has already been reached.
   *
   * Caps ("two appointments per customer per day", "eight per provider per
   * day") are counted per calendar day in a named zone, which is a wall-clock
   * notion this file must not know about; the caller resolves each full day to
   * an instant span and passes it in. Candidates *starting* inside one are
   * refused — the cap counts an appointment on the day it starts, exactly as
   * `assertBookingLimits` does when the booking is committed.
   */
  limitReached?: Array<{ start: Date; end: Date }>;

  /** Injected rather than read from the system clock, so tests are deterministic. */
  now: Date;
  /** Hard ceiling on returned slots, protecting the API from a huge range. */
  maxSlots: number;

  /** Populate `rejected` with per-candidate reasons. Costs memory; off by default. */
  explain?: boolean;
}

export interface CandidateSlot {
  startsAt: Date;
  endsAt: Date;
  /** The calendar footprint that will be reserved, buffers included. */
  bufferStartAt: Date;
  bufferEndAt: Date;
  locationId: string | null;
  /** Set when this slot joins an existing group appointment. */
  joinsAppointmentId?: string;
  remainingCapacity?: number;
}

export type RejectionReason =
  'TOO_SOON' | 'OUTSIDE_RANGE' | 'OUTSIDE_WORKING_HOURS' | 'CONFLICT' | 'LIMIT_REACHED';

export interface RejectedSlot {
  startsAt: Date;
  reason: RejectionReason;
  /** For CONFLICT: what the buffered window collided with. */
  conflictReason?: BusyReason;
}

export interface SlotEngineResult {
  slots: CandidateSlot[];
  rejected: RejectedSlot[];
  /** True when maxSlots cut the result short — the API reports this honestly
   *  instead of implying the day has no more availability. */
  truncated: boolean;
}

/**
 * Aligns a candidate start to the slot grid.
 *
 * The grid is anchored at each working window's start rather than at midnight,
 * so a clinic opening at 09:10 offers 09:10 / 09:25 / 09:40 rather than an
 * unusable 09:00 that lies before opening.
 */
function alignForward(from: Date, anchor: Date, stepMinutes: number): Date {
  if (from <= anchor) return anchor;
  const stepMs = stepMinutes * 60_000;
  const elapsed = from.getTime() - anchor.getTime();
  const steps = Math.ceil(elapsed / stepMs);
  return new Date(anchor.getTime() + steps * stepMs);
}

/**
 * Sorted-scan overlap test.
 *
 * `busy` is merged and sorted once by the caller, and `cursor` advances
 * monotonically across candidates, so the whole generation stays O(n + m)
 * rather than O(n × m) on a busy calendar.
 */
function findConflict(
  busy: BusyInterval[],
  windowStart: Date,
  windowEnd: Date,
  fromIndex: number,
): { index: number; conflict: BusyInterval | null } {
  let index = fromIndex;
  while (index < busy.length && busy[index]!.end <= windowStart) index += 1;

  for (let probe = index; probe < busy.length; probe += 1) {
    const block = busy[probe]!;
    if (block.start >= windowEnd) break;
    if (intervalsOverlap(windowStart, windowEnd, block.start, block.end)) {
      return { index, conflict: block };
    }
  }
  return { index, conflict: null };
}

/**
 * Merges busy intervals while keeping a representative reason for each merged
 * block, so "why is 14:00 unavailable?" still has an answer after folding.
 */
function mergeBusy(busy: BusyInterval[]): BusyInterval[] {
  if (busy.length === 0) return [];
  const reasonAt = new Map<number, BusyReason>();
  for (const block of busy) reasonAt.set(block.start.getTime(), block.reason);

  return mergeIntervals(busy).map((merged) => ({
    start: merged.start,
    end: merged.end,
    reason: reasonAt.get(merged.start.getTime()) ?? 'APPOINTMENT',
  }));
}

export function generateSlots(input: SlotEngineInput): SlotEngineResult {
  const {
    rangeStart,
    rangeEnd,
    durationMinutes,
    preBufferMinutes,
    postBufferMinutes,
    slotIntervalMinutes,
    minNoticeMinutes,
    now,
    maxSlots,
    explain = false,
  } = input;

  const slots: CandidateSlot[] = [];
  const rejected: RejectedSlot[] = [];
  let truncated = false;

  if (durationMinutes <= 0 || slotIntervalMinutes <= 0 || maxSlots <= 0) {
    return { slots, rejected, truncated };
  }

  const earliestStart = addMinutes(now, minNoticeMinutes);
  const busy = mergeBusy(input.busy);
  // Day-length spans, a handful at most: merged so an overlapping customer cap
  // and provider cap on the same day are tested once.
  const capped = mergeIntervals(input.limitReached ?? []);

  // Joinable group appointments are keyed by start instant so a candidate slot
  // landing on one can be turned into a "join this class" offer.
  const joinableByStart = new Map<number, JoinableAppointment>();
  for (const item of input.joinable ?? []) {
    if (item.remainingCapacity > 0) joinableByStart.set(item.startsAt.getTime(), item);
  }

  const windows = [...input.workingWindows].sort((a, b) => a.start.getTime() - b.start.getTime());

  for (const window of windows) {
    if (slots.length >= maxSlots) {
      truncated = true;
      break;
    }
    // Clip the working window to the requested range.
    const windowStart = window.start > rangeStart ? window.start : rangeStart;
    const windowEnd = window.end < rangeEnd ? window.end : rangeEnd;
    if (windowEnd <= windowStart) continue;

    // Cursor into the sorted busy list; monotonic within a window.
    let busyCursor = 0;
    let candidate = alignForward(windowStart, window.start, slotIntervalMinutes);

    while (candidate.getTime() + durationMinutes * 60_000 <= windowEnd.getTime()) {
      if (slots.length >= maxSlots) {
        truncated = true;
        break;
      }

      const startsAt = candidate;
      const endsAt = addMinutes(startsAt, durationMinutes);
      const bufferStartAt = addMinutes(startsAt, -preBufferMinutes);
      const bufferEndAt = addMinutes(endsAt, postBufferMinutes);

      if (startsAt < earliestStart) {
        if (explain) rejected.push({ startsAt, reason: 'TOO_SOON' });
        candidate = addMinutes(candidate, slotIntervalMinutes);
        continue;
      }

      // Checked before the joinable branch: taking a place in an existing group
      // session still counts towards the day's cap, so a customer at their
      // limit must not be offered a class to join either.
      const cap = capped.find((span) => startsAt >= span.start && startsAt < span.end);
      if (cap) {
        if (explain) rejected.push({ startsAt, reason: 'LIMIT_REACHED' });
        // Skip to the end of the capped day rather than walking a whole day of
        // grid positions that are all refused for the same reason.
        const skipTo = alignForward(cap.end, window.start, slotIntervalMinutes);
        candidate = skipTo > candidate ? skipTo : addMinutes(candidate, slotIntervalMinutes);
        continue;
      }

      const joinable = joinableByStart.get(startsAt.getTime());
      if (joinable && joinable.endsAt.getTime() === endsAt.getTime()) {
        // The appointment already exists and has room: it does not need to be
        // conflict-checked against itself.
        slots.push({
          startsAt,
          endsAt,
          bufferStartAt,
          bufferEndAt,
          locationId: window.locationId,
          joinsAppointmentId: joinable.appointmentId,
          remainingCapacity: joinable.remainingCapacity,
        });
        candidate = addMinutes(candidate, slotIntervalMinutes);
        continue;
      }

      // The *buffered* footprint is what must be free — preparation time is as
      // real a reservation as the appointment itself.
      const { index, conflict } = findConflict(busy, bufferStartAt, bufferEndAt, busyCursor);
      busyCursor = index;

      if (conflict) {
        if (explain) {
          rejected.push({ startsAt, reason: 'CONFLICT', conflictReason: conflict.reason });
        }
        // Jump the cursor to the end of the blocking interval instead of
        // stepping one grid unit at a time through a long meeting.
        const skipTo = alignForward(
          addMinutes(conflict.end, -preBufferMinutes),
          window.start,
          slotIntervalMinutes,
        );
        candidate = skipTo > candidate ? skipTo : addMinutes(candidate, slotIntervalMinutes);
        continue;
      }

      slots.push({
        startsAt,
        endsAt,
        bufferStartAt,
        bufferEndAt,
        locationId: window.locationId,
      });
      candidate = addMinutes(candidate, slotIntervalMinutes);
    }
  }

  // Windows can overlap (two rules covering the same hour, or two locations).
  // Deduplicate on start+location so the customer never sees the same time twice.
  const seen = new Set<string>();
  const deduped = slots.filter((slot) => {
    const identity = `${slot.startsAt.getTime()}|${slot.locationId ?? ''}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  deduped.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  return { slots: deduped, rejected, truncated };
}

/**
 * Whether one specific requested time is still bookable.
 *
 * Used at booking confirmation to re-validate the exact slot the customer
 * chose. It intentionally does NOT reuse generateSlots: the grid alignment that
 * is right for *offering* times must not be able to reject a time the engine
 * itself offered a moment earlier, and confirmation cares only about "is this
 * exact window free and in policy".
 *
 * Daily booking caps are deliberately absent: they are counted, and refused,
 * inside the booking transaction where the count cannot go stale between the
 * check and the INSERT. `generateSlots` takes them as an input only so the
 * search stops offering times that commit is certain to refuse.
 */
export function isSlotBookable(input: {
  startsAt: Date;
  durationMinutes: number;
  preBufferMinutes: number;
  postBufferMinutes: number;
  workingWindows: WorkingWindow[];
  busy: BusyInterval[];
  minNoticeMinutes: number;
  now: Date;
}): { bookable: boolean; reason?: RejectionReason; conflictReason?: BusyReason } {
  const endsAt = addMinutes(input.startsAt, input.durationMinutes);
  const bufferStartAt = addMinutes(input.startsAt, -input.preBufferMinutes);
  const bufferEndAt = addMinutes(endsAt, input.postBufferMinutes);

  if (input.startsAt < addMinutes(input.now, input.minNoticeMinutes)) {
    return { bookable: false, reason: 'TOO_SOON' };
  }

  const insideWorkingHours = input.workingWindows.some(
    (window) => window.start <= input.startsAt && window.end >= endsAt,
  );
  if (!insideWorkingHours) {
    return { bookable: false, reason: 'OUTSIDE_WORKING_HOURS' };
  }

  for (const block of mergeBusy(input.busy)) {
    if (intervalsOverlap(bufferStartAt, bufferEndAt, block.start, block.end)) {
      return { bookable: false, reason: 'CONFLICT', conflictReason: block.reason };
    }
  }

  return { bookable: true };
}
