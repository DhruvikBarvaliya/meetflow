import { DateTime } from 'luxon';
import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import { formatMinuteOfDay, formatTime, formatTimeRange } from '@/lib/format';
import type { AppointmentStatus } from '@/types/api';
import type { CalendarEvent } from './types';

/**
 * The three calendar views.
 *
 * Everything here resolves in an explicit timezone — the workspace's — rather
 * than the browser's. A calendar is the one screen where using the wrong clock
 * is not a cosmetic bug: it moves appointments to the wrong day.
 *
 * Every event is a real `<button>`, so the grid is reachable by keyboard and
 * announced as an activatable control rather than a coloured rectangle.
 */

export const PX_PER_HOUR = 56;

/** Anything shorter than this would render as an unreadable sliver. */
const MIN_BLOCK_PX = 24;

/** The window a day column shows when the day's own events do not widen it. */
const DEFAULT_START_HOUR = 7;
const DEFAULT_END_HOUR = 21;

/**
 * Statuses that no longer occupy the diary.
 *
 * They stay visible — an operator needs to see that the 10am was cancelled, not
 * to find a hole where it was — but they are drawn back so the live bookings
 * read first.
 */
const SPENT_STATUSES: readonly AppointmentStatus[] = ['CANCELLED', 'REJECTED', 'NO_SHOW'];

export interface PositionedEvent {
  event: CalendarEvent;
  topPx: number;
  heightPx: number;
  /** Which of the overlapping columns this block sits in. */
  lane: number;
  laneCount: number;
}

function minutesInto(instant: string, zone: string, dayStart: DateTime): number {
  return DateTime.fromISO(instant).setZone(zone).diff(dayStart, 'minutes').minutes;
}

/**
 * Packs a day's events into side-by-side lanes.
 *
 * Two appointments at the same time are a real thing in this product — two
 * therapists, two rooms — so they are drawn beside each other rather than on
 * top of one another. The sweep keeps a running set of blocks that have not yet
 * ended; a block takes the lowest free lane, and the whole overlapping cluster
 * shares the widest lane count so their widths line up.
 */
export function layoutDay(
  events: CalendarEvent[],
  zone: string,
  dayStart: DateTime,
  windowStartHour: number,
): PositionedEvent[] {
  const sorted = [...events].sort(
    (a, b) => DateTime.fromISO(a.startsAt).toMillis() - DateTime.fromISO(b.startsAt).toMillis(),
  );

  const placed: Array<{ event: CalendarEvent; start: number; end: number; lane: number }> = [];
  const cluster: number[] = [];
  const result: PositionedEvent[] = [];

  /** Blocks that overlap in a chain share one lane count. */
  let clusterEnd = -Infinity;
  let clusterStartIndex = 0;

  const flush = (endIndex: number): void => {
    const laneCount = Math.max(1, ...cluster);
    for (let index = clusterStartIndex; index < endIndex; index += 1) {
      const entry = placed[index];
      if (!entry) continue;
      const topMinutes = entry.start - windowStartHour * 60;
      result.push({
        event: entry.event,
        topPx: (topMinutes / 60) * PX_PER_HOUR,
        heightPx: Math.max(MIN_BLOCK_PX, ((entry.end - entry.start) / 60) * PX_PER_HOUR),
        lane: entry.lane,
        laneCount,
      });
    }
    cluster.length = 0;
    clusterStartIndex = endIndex;
  };

  for (const event of sorted) {
    const start = minutesInto(event.startsAt, zone, dayStart);
    const end = Math.max(start + 1, minutesInto(event.endsAt, zone, dayStart));

    if (start >= clusterEnd && cluster.length > 0) flush(placed.length);

    const takenLanes = new Set(
      placed
        .slice(clusterStartIndex)
        .filter((entry) => entry.end > start)
        .map((entry) => entry.lane),
    );
    let lane = 0;
    while (takenLanes.has(lane)) lane += 1;

    placed.push({ event, start, end, lane });
    cluster.push(lane + 1);
    clusterEnd = Math.max(clusterEnd, end);
  }

  flush(placed.length);
  return result;
}

/** The hour range a set of events needs, widened to a sensible default. */
export function hourWindow(events: CalendarEvent[], zone: string): { start: number; end: number } {
  if (events.length === 0) return { start: DEFAULT_START_HOUR, end: DEFAULT_END_HOUR };

  let earliest = DEFAULT_START_HOUR;
  let latest = DEFAULT_END_HOUR;

  for (const event of events) {
    const start = DateTime.fromISO(event.startsAt).setZone(zone);
    const end = DateTime.fromISO(event.endsAt).setZone(zone);
    earliest = Math.min(earliest, start.hour);
    // An appointment ending at 20:15 needs the 21:00 line drawn.
    latest = Math.max(latest, end.minute > 0 ? end.hour + 1 : end.hour);
  }

  return { start: Math.max(0, earliest), end: Math.min(24, Math.max(latest, earliest + 1)) };
}

function blockTone(status: AppointmentStatus): string {
  if (SPENT_STATUSES.includes(status)) return 'opacity-60 line-through decoration-1';
  if (status === 'PENDING') return 'ring-1 ring-inset ring-warning-border';
  return '';
}

export interface EventBlockProps {
  event: CalendarEvent;
  zone: string;
  onSelect: (event: CalendarEvent) => void;
  style?: React.CSSProperties;
  compact?: boolean;
}

/**
 * One appointment on the grid.
 *
 * The service colour is a tint behind the text rather than the text colour
 * itself: a workspace can pick any hex, and text painted in an arbitrary
 * customer-chosen colour has no contrast guarantee at all.
 */
export function EventBlock({
  event,
  zone,
  onSelect,
  style,
  compact = false,
}: EventBlockProps): JSX.Element {
  const tint = event.color ?? undefined;
  const label = `${event.title ?? event.serviceName ?? 'Appointment'}, ${formatTimeRange(
    event.startsAt,
    event.endsAt,
    zone,
  )}${event.customerName ? `, ${event.customerName}` : ''}, ${event.status.toLowerCase().replace('_', ' ')}`;

  return (
    <button
      type="button"
      onClick={() => onSelect(event)}
      aria-label={label}
      style={{
        ...style,
        borderLeftColor: tint,
        backgroundColor: tint ? `color-mix(in srgb, ${tint} 14%, transparent)` : undefined,
      }}
      className={cn(
        'flex w-full flex-col overflow-hidden rounded-md border border-border border-l-4 bg-surface-sunken px-2 py-1 text-left transition-colors',
        'hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
        blockTone(event.status),
      )}
    >
      <span
        className={cn(
          'truncate font-medium text-fg',
          compact ? 'text-[0.6875rem] leading-4' : 'text-xs',
        )}
      >
        {formatTime(event.startsAt, zone)} {event.title ?? event.serviceName ?? 'Appointment'}
      </span>
      {!compact && event.customerName ? (
        <span className="truncate text-[0.6875rem] text-fg-muted">{event.customerName}</span>
      ) : null}
      {!compact && event.staffName ? (
        <span className="truncate text-[0.6875rem] text-fg-muted">{event.staffName}</span>
      ) : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Time grid (day and week)
// ---------------------------------------------------------------------------

export interface TimeGridProps {
  /** One entry per column, already in the workspace zone. */
  days: DateTime[];
  events: CalendarEvent[];
  zone: string;
  onSelect: (event: CalendarEvent) => void;
}

export function TimeGrid({ days, events, zone, onSelect }: TimeGridProps): JSX.Element {
  const window = useMemo(() => hourWindow(events, zone), [events, zone]);
  const hours = useMemo(
    () => Array.from({ length: window.end - window.start }, (_, index) => window.start + index),
    [window],
  );

  const today = DateTime.now().setZone(zone).startOf('day');

  const columns = useMemo(
    () =>
      days.map((day) => {
        const dayEvents = events.filter((event) =>
          DateTime.fromISO(event.startsAt).setZone(zone).hasSame(day, 'day'),
        );
        return { day, positioned: layoutDay(dayEvents, zone, day, window.start) };
      }),
    [days, events, zone, window.start],
  );

  return (
    <div className="mf-scroll-x">
      <div className="flex min-w-[42rem]">
        {/* Hour gutter */}
        <div className="w-16 shrink-0 pt-10" aria-hidden="true">
          {hours.map((hour) => (
            <div
              key={hour}
              style={{ height: PX_PER_HOUR }}
              className="relative pr-2 text-right text-[0.6875rem] tabular-nums text-fg-muted"
            >
              <span className="absolute right-2 -top-1.5">{formatMinuteOfDay(hour * 60)}</span>
            </div>
          ))}
        </div>

        <div className="flex flex-1">
          {columns.map(({ day, positioned }) => {
            const isToday = day.hasSame(today, 'day');
            return (
              <div key={day.toISODate()} className="min-w-0 flex-1 border-l border-border">
                <div
                  className={cn(
                    'sticky top-0 z-10 h-10 border-b border-border bg-surface px-2 py-1.5 text-center',
                    isToday && 'bg-brand-subtle',
                  )}
                >
                  <p
                    className={cn(
                      'truncate text-xs font-medium',
                      isToday ? 'text-brand-text' : 'text-fg-secondary',
                    )}
                  >
                    {day.toFormat('ccc')}{' '}
                    <span className="tabular-nums">{day.toFormat('d LLL')}</span>
                  </p>
                </div>

                <div className="relative" style={{ height: hours.length * PX_PER_HOUR }}>
                  {hours.map((hour) => (
                    <div
                      key={hour}
                      aria-hidden="true"
                      style={{ height: PX_PER_HOUR }}
                      className="border-b border-border/60"
                    />
                  ))}

                  {positioned.map(({ event, topPx, heightPx, lane, laneCount }) => (
                    <EventBlock
                      key={event.id}
                      event={event}
                      zone={zone}
                      onSelect={onSelect}
                      compact={heightPx < 44}
                      style={{
                        position: 'absolute',
                        top: topPx,
                        height: heightPx,
                        // A hair of padding on each side so neighbouring blocks
                        // never share an edge and read as one.
                        left: `calc(${(lane / laneCount) * 100}% + 2px)`,
                        width: `calc(${100 / laneCount}% - 4px)`,
                      }}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Month grid
// ---------------------------------------------------------------------------

export interface MonthGridProps {
  /** Any day inside the month to draw. */
  anchor: DateTime;
  events: CalendarEvent[];
  zone: string;
  onSelect: (event: CalendarEvent) => void;
  /** Jumps to the day view for a date the user asked to see in full. */
  onOpenDay: (date: DateTime) => void;
}

const MONTH_CHIP_LIMIT = 3;
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function MonthGrid({
  anchor,
  events,
  zone,
  onSelect,
  onOpenDay,
}: MonthGridProps): JSX.Element {
  const today = DateTime.now().setZone(zone).startOf('day');

  const cells = useMemo(() => {
    const monthStart = anchor.startOf('month');
    // Luxon's weekday is 1 = Monday, so this always lands on the Monday on or
    // before the 1st and the grid never starts mid-week.
    const gridStart = monthStart.minus({ days: monthStart.weekday - 1 });
    return Array.from({ length: 42 }, (_, index) => gridStart.plus({ days: index }));
  }, [anchor]);

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const key = DateTime.fromISO(event.startsAt).setZone(zone).toISODate() ?? '';
      const bucket = map.get(key);
      if (bucket) bucket.push(event);
      else map.set(key, [event]);
    }
    for (const bucket of map.values()) {
      bucket.sort(
        (a, b) => DateTime.fromISO(a.startsAt).toMillis() - DateTime.fromISO(b.startsAt).toMillis(),
      );
    }
    return map;
  }, [events, zone]);

  return (
    <div className="mf-scroll-x">
      <div className="min-w-[42rem]">
        <div className="grid grid-cols-7 border-b border-border" aria-hidden="true">
          {WEEKDAY_LABELS.map((label) => (
            <div key={label} className="px-2 py-2 text-center text-xs font-medium text-fg-muted">
              {label}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7">
          {cells.map((day) => {
            const iso = day.toISODate() ?? '';
            const dayEvents = byDate.get(iso) ?? [];
            const inMonth = day.month === anchor.month;
            const isToday = day.hasSame(today, 'day');
            const overflow = dayEvents.length - MONTH_CHIP_LIMIT;

            return (
              <div
                key={iso}
                className={cn(
                  'flex min-h-28 flex-col gap-1 border-b border-l border-border p-1.5',
                  !inMonth && 'bg-surface-sunken',
                )}
              >
                <button
                  type="button"
                  onClick={() => onOpenDay(day)}
                  aria-label={`Open ${day.toFormat('cccc d LLLL yyyy')}`}
                  className={cn(
                    'self-start rounded-full px-1.5 text-xs font-medium tabular-nums transition-colors',
                    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
                    isToday
                      ? 'bg-brand text-on-brand'
                      : inMonth
                        ? 'text-fg hover:bg-surface-hover'
                        : 'text-fg-muted hover:bg-surface-hover',
                  )}
                >
                  {day.day}
                </button>

                {dayEvents.slice(0, MONTH_CHIP_LIMIT).map((event) => (
                  <EventBlock
                    key={event.id}
                    event={event}
                    zone={zone}
                    onSelect={onSelect}
                    compact
                  />
                ))}

                {overflow > 0 ? (
                  <button
                    type="button"
                    onClick={() => onOpenDay(day)}
                    className="rounded-xs px-1 text-left text-[0.6875rem] font-medium text-brand-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
                  >
                    +{overflow} more
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
