/**
 * Resource availability arithmetic.
 *
 * A room, a chair or a machine constrains a booking exactly as much as the
 * person delivering it, and MeetFlow has always enforced that — but only at
 * commit, inside `reserveResources`. Availability search knew nothing about
 * resources at all, so a service whose only treatment room was already taken
 * still advertised the slot and the customer met the clash as a 409 *after*
 * filling in the form. This module is what lets the search subtract resource
 * contention before a time is ever offered.
 *
 * Deliberately pure, like the slot engine: it takes resolved instants and
 * returns the spans in which a service's required resources cannot all be
 * found. Everything zone-shaped — an override's calendar day, a location's
 * timezone — is resolved by availability.service.ts before anything reaches
 * here, so this file has no clock, no zone database and no Sequelize.
 *
 * The capacity semantics mirror `reserveResources` in
 * modules/appointments/booking.service.ts deliberately and exactly, because the
 * two answering differently is the whole defect:
 *
 *   - a resource contributes **at most one unit** to a requirement (booking
 *     reserves one row per resource and moves on to the next candidate), so a
 *     requirement for `quantity` units needs `quantity` distinct resources;
 *   - a resource is usable while strictly fewer than `capacity` reservations
 *     overlap it. `capacity = 1` is the case the
 *     `appointment_resources_no_overlap` GiST exclusion constraint enforces in
 *     the database; `capacity > 1` is the case an exclusion constraint cannot
 *     express ("at most N" is not "no overlap"), which booking counts under a
 *     row lock and which is counted here the same way;
 *   - an **optional** requirement never hides a slot, because booking proceeds
 *     without it rather than refusing.
 */
import { mergeIntervals } from '../utils/time';
import type { BusyInterval } from './slotEngine';

export interface TimeSpan {
  start: Date;
  end: Date;
}

/** One candidate resource, with everything already claiming its time. */
export interface ResourcePool {
  resourceId: string;
  /** How many concurrent holders it supports. 1 for an exclusive room. */
  capacity: number;
  /**
   * Spans in which the resource may not be used at all — RESOURCE-scoped
   * blackouts and availability overrides. Distinct from `reservations` because
   * these ignore capacity: a room under maintenance is out even if empty.
   */
  unavailable: TimeSpan[];
  /** One span per unit already held, buffers included, as stored on the row. */
  reservations: TimeSpan[];
}

/** One `service_resource_requirements` row, resolved to its candidates. */
export interface ResourceDemand {
  /** How many distinct resources from `pool` must be free at once. */
  quantity: number;
  /** Optional requirements never hide a slot; booking goes ahead without them. */
  isRequired: boolean;
  /** Candidates that could satisfy it, already filtered by type and location. */
  pool: ResourcePool[];
}

/** Intersection of a span with the search window, dropping anything empty. */
function clipToWindow(spans: TimeSpan[], window: TimeSpan): TimeSpan[] {
  const clipped: TimeSpan[] = [];
  for (const span of spans) {
    const start = span.start > window.start ? span.start : window.start;
    const end = span.end < window.end ? span.end : window.end;
    if (end > start) clipped.push({ start, end });
  }
  return clipped;
}

/**
 * The spans covered by at least `depth` of the given intervals.
 *
 * One sweep answers both questions this module asks: "when are `capacity`
 * reservations overlapping one resource?" and "when are enough resources out at
 * once to leave the requirement short?".
 */
function spansAtDepth(spans: TimeSpan[], depth: number, window: TimeSpan): TimeSpan[] {
  // Depth zero is satisfied everywhere, including where nothing is booked.
  if (depth <= 0) return clipToWindow([window], window);

  const events: Array<{ at: number; delta: number }> = [];
  for (const span of spans) {
    if (span.end <= span.start) continue;
    events.push({ at: span.start.getTime(), delta: 1 });
    events.push({ at: span.end.getTime(), delta: -1 });
  }
  if (events.length === 0) return [];

  // Half-open [start, end) semantics, matching the tstzrange the database
  // indexes: a span ending exactly where the next begins must not make the
  // depth dip, so closes are applied before opens at the same instant.
  events.sort((a, b) => (a.at !== b.at ? a.at - b.at : a.delta - b.delta));

  const covered: TimeSpan[] = [];
  let open = 0;
  let since: number | null = null;

  for (const event of events) {
    const before = open;
    open += event.delta;
    if (before < depth && open >= depth) {
      since = event.at;
    } else if (before >= depth && open < depth && since !== null) {
      covered.push({ start: new Date(since), end: new Date(event.at) });
      since = null;
    }
  }

  return clipToWindow(mergeIntervals(covered), window);
}

/**
 * The spans in which one resource cannot be handed to a new booking.
 *
 * Merging the two causes together per resource matters: a blackout overlapping
 * a saturated period is still *one* resource being out, and counting it twice
 * would make the pool look emptier than it is.
 */
function exhaustedSpans(resource: ResourcePool, window: TimeSpan): TimeSpan[] {
  // A resource configured with no capacity can never be handed out. Guarded
  // rather than assumed: the depth sweep below treats 0 as "always satisfied",
  // which would silently invert the answer.
  if (resource.capacity <= 0) return clipToWindow([window], window);

  return mergeIntervals([
    ...clipToWindow(resource.unavailable, window),
    ...spansAtDepth(resource.reservations, resource.capacity, window),
  ]);
}

/**
 * Spans within `window` where a service's required resources cannot be found.
 *
 * Returned as `BusyInterval`s so the slot engine subtracts them exactly as it
 * subtracts appointments and blackouts, and so explain mode can say `RESOURCE`
 * — the one `BusyReason` member that, until now, nothing ever produced.
 */
export function computeResourceBusy(demands: ResourceDemand[], window: TimeSpan): BusyInterval[] {
  const busy: TimeSpan[] = [];

  for (const demand of demands) {
    if (!demand.isRequired || demand.quantity <= 0) continue;

    // Fewer candidates than the service needs: no arrangement of the diary can
    // satisfy it. Booking would refuse every candidate time, so the search says
    // so once instead of offering a day of slots that all end in a 409.
    if (demand.pool.length < demand.quantity) {
      busy.push({ start: window.start, end: window.end });
      continue;
    }

    // The requirement fails wherever the pool is short by one: with N
    // candidates and `quantity` needed, that is N - quantity + 1 of them out at
    // the same instant.
    const exhausted = demand.pool.flatMap((resource) => exhaustedSpans(resource, window));
    busy.push(...spansAtDepth(exhausted, demand.pool.length - demand.quantity + 1, window));
  }

  return mergeIntervals(busy).map((span) => ({
    start: span.start,
    end: span.end,
    reason: 'RESOURCE' as const,
  }));
}
