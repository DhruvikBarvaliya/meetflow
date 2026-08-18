/**
 * Date and time selection.
 *
 * Slots arrive from the server as UTC instants and are grouped into *the
 * visitor's* calendar days, not the workspace's. Someone in London booking a
 * Bengaluru clinic sees the times on their own clock, under their own dates —
 * which is the whole reason the API takes a timezone parameter.
 *
 * Every day in the requested window is rendered, including the empty ones. A
 * day that was searched and came back full is a real answer, and silently
 * omitting it would leave the visitor unable to tell it apart from a day the
 * page never looked at.
 */
import { useMemo } from 'react';
import { DateTime } from 'luxon';
import { CalendarX2, ChevronLeft, ChevronRight, Info } from 'lucide-react';
import { Button, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { eachDayInRange, formatTime, formatZoneLabel } from '@/lib/format';
import type { PublicSlot } from '@/types/api';

export interface SlotPickerProps {
  slots: PublicSlot[];
  timezone: string;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  selectedStartsAt: string | null;
  onSelect: (slot: PublicSlot) => void;
  /** Inclusive window currently being shown, as ISO dates in `timezone`. */
  fromDate: string;
  toDate: string;
  onShiftWindow: (direction: -1 | 1) => void;
  canGoBack: boolean;
  canGoForward: boolean;
  /** True when the server capped the result — say so rather than imply a full day. */
  truncated: boolean;
  /** Shown when a provider is chosen, so identical times stay distinguishable. */
  showProvider?: boolean;
}

interface DayGroup {
  isoDate: string;
  label: string;
  weekday: string;
  isToday: boolean;
  slots: PublicSlot[];
}

export function SlotPicker({
  slots,
  timezone,
  isLoading,
  error,
  onRetry,
  selectedStartsAt,
  onSelect,
  fromDate,
  toDate,
  onShiftWindow,
  canGoBack,
  canGoForward,
  truncated,
  showProvider = false,
}: SlotPickerProps) {
  const days = useMemo<DayGroup[]>(() => {
    const byDate = new Map<string, PublicSlot[]>();

    for (const slot of slots) {
      const key = DateTime.fromISO(slot.startsAt, { zone: timezone }).toFormat('yyyy-MM-dd');
      const bucket = byDate.get(key);
      if (bucket) bucket.push(slot);
      else byDate.set(key, [slot]);
    }

    const today = DateTime.now().setZone(timezone).toFormat('yyyy-MM-dd');

    // Driven by the requested range, not by what came back, so full days keep
    // their place in the week.
    return eachDayInRange(fromDate, toDate, timezone).map((isoDate) => {
      const day = DateTime.fromISO(isoDate, { zone: timezone });
      return {
        isoDate,
        label: day.toFormat('d LLL'),
        weekday: day.toFormat('cccc'),
        isToday: isoDate === today,
        slots: (byDate.get(isoDate) ?? []).sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
      };
    });
  }, [slots, timezone, fromDate, toDate]);

  const windowLabel = useMemo(() => {
    const start = DateTime.fromISO(fromDate, { zone: timezone });
    const end = DateTime.fromISO(toDate, { zone: timezone });
    const sameMonth = start.month === end.month && start.year === end.year;
    return sameMonth
      ? `${start.toFormat('d')} – ${end.toFormat('d LLL yyyy')}`
      : `${start.toFormat('d LLL')} – ${end.toFormat('d LLL yyyy')}`;
  }, [fromDate, toDate, timezone]);

  const hasAnySlot = slots.length > 0;

  return (
    <section aria-labelledby="slot-picker-heading">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="slot-picker-heading" className="text-base font-semibold">
            Choose a time
          </h2>
          <p className="text-sm text-fg-muted">{windowLabel}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onShiftWindow(-1)}
            disabled={!canGoBack || isLoading}
            aria-label="Show earlier dates"
          >
            <ChevronLeft aria-hidden className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onShiftWindow(1)}
            disabled={!canGoForward || isLoading}
            aria-label="Show later dates"
          >
            <ChevronRight aria-hidden className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Tells a screen reader the result changed without moving the focus. */}
      <p aria-live="polite" className="mf-sr-only">
        {isLoading
          ? 'Loading available times'
          : `${slots.length} available time${slots.length === 1 ? '' : 's'} between ${fromDate} and ${toDate}, shown in ${formatZoneLabel(timezone)}`}
      </p>

      {isLoading ? (
        <div className="space-y-5" aria-hidden>
          {[0, 1, 2].map((row) => (
            <div key={row}>
              <Skeleton className="mb-2 h-4 w-32" />
              <div className="flex flex-wrap gap-2">
                {[0, 1, 2, 3, 4, 5].map((cell) => (
                  <Skeleton key={cell} className="h-11 w-24 rounded-lg" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <ErrorState error={error} title="We could not load available times" onRetry={onRetry} />
      ) : !hasAnySlot ? (
        <EmptyState
          icon={<CalendarX2 aria-hidden className="h-6 w-6" />}
          title="Fully booked in this range"
          description={
            canGoForward
              ? 'Every day shown is taken. Try looking further ahead, or change the service or provider.'
              : 'Every day shown is taken. Try a different service or provider, or contact the business directly.'
          }
          action={
            canGoForward ? (
              <Button onClick={() => onShiftWindow(1)}>Show later dates</Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-5">
          {days.map((day) => (
            <div key={day.isoDate}>
              <h3 className="mb-2 text-sm font-medium text-fg-secondary">
                {day.weekday}, {day.label}
                {day.isToday ? <span className="ml-1.5 text-fg-muted">· today</span> : null}
              </h3>

              {day.slots.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-fg-muted">
                  No times available
                </p>
              ) : (
                <div
                  role="group"
                  aria-label={`Times on ${day.weekday} ${day.label}`}
                  className="flex flex-wrap gap-2"
                >
                  {day.slots.map((slot) => {
                    const isSelected = slot.startsAt === selectedStartsAt;
                    const isFull = slot.remainingCapacity === 0;

                    return (
                      <button
                        key={`${slot.startsAt}-${slot.staffProfileId}`}
                        type="button"
                        onClick={() => onSelect(slot)}
                        disabled={isFull}
                        aria-pressed={isSelected}
                        className={cn(
                          // 44px tall: a comfortable touch target on a phone,
                          // which is where most of these bookings happen.
                          'min-h-11 min-w-[5.5rem] rounded-lg border px-3 py-2 text-sm transition-colors',
                          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                          isFull &&
                            'cursor-not-allowed border-border bg-surface-sunken text-fg-muted',
                          !isFull && isSelected && 'border-brand bg-brand text-on-brand',
                          !isFull &&
                            !isSelected &&
                            'border-border bg-surface hover:border-brand hover:bg-surface-hover',
                        )}
                      >
                        <span className="block font-medium">
                          {formatTime(slot.startsAt, timezone)}
                        </span>
                        {showProvider ? (
                          <span
                            className={cn(
                              'block text-[0.6875rem]',
                              isSelected ? 'text-on-brand/80' : 'text-fg-muted',
                            )}
                          >
                            {slot.staffName}
                          </span>
                        ) : null}
                        {slot.remainingCapacity !== undefined ? (
                          <span
                            className={cn(
                              'block text-[0.6875rem]',
                              isSelected ? 'text-on-brand/80' : 'text-fg-muted',
                            )}
                          >
                            {isFull ? 'Full' : `${slot.remainingCapacity} left`}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}

          {truncated ? (
            <p className="flex items-start gap-2 rounded-lg bg-info-subtle px-3 py-2 text-sm text-info-text">
              <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              There are more times than we can show at once. Narrow the range or pick a provider to
              see the rest.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
