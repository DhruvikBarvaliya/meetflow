import { useQuery } from '@tanstack/react-query';
import { CalendarX2 } from 'lucide-react';
import { DateTime } from 'luxon';
import { useId } from 'react';
import type { AvailabilitySearchResult } from '@/components/owner';
import { DatePicker, ErrorState, Field, Skeleton } from '@/components/ui';
import { api } from '@/lib/apiClient';
import { cn } from '@/lib/cn';
import { formatTime } from '@/lib/format';

export interface SlotPickerProps {
  serviceId: string;
  /** The provider the appointment is already assigned to. */
  staffProfileId: string;
  /** The zone the calendar day is read in, and the zone the times are shown in. */
  timezone: string;
  /** `YYYY-MM-DD`; controlled so the caller can reset it when a dialog closes. */
  date: string | null;
  onDateChange: (date: string) => void;
  /** The chosen slot's `startsAt`, as an offset-bearing instant. */
  value: string | null;
  onChange: (startsAt: string) => void;
  /** The appointment's current time, so the user can see what they are moving. */
  currentStartsAt?: string;
  disabled?: boolean;
}

/**
 * Date plus a grid of the times the scheduling engine actually offers.
 *
 * Times come from the availability search rather than from a free-text control,
 * because the engine only ever places a booking on the workspace's slot
 * interval, inside working hours, clear of buffers and of everything already on
 * the calendar. Offering anything else would let someone pick a time that is
 * then refused, which is the worst possible moment to find out.
 *
 * Why this exists next to `components/owner/RescheduleDialog`: that dialog
 * commits through `POST /appointments/:id/reschedule`, which the API runs with
 * `enforceCustomerPolicy: false` — a workspace acting for a customer who has
 * phoned in is not bound by the customer's own deadline. A customer moving
 * their own booking must go through `/public/appointments/:publicId/reschedule`
 * instead, which does enforce it. Same picker, deliberately different door.
 */
export function SlotPicker({
  serviceId,
  staffProfileId,
  timezone,
  date,
  onDateChange,
  value,
  onChange,
  currentStartsAt,
  disabled = false,
}: SlotPickerProps): JSX.Element {
  const groupName = useId();
  const today = DateTime.now().setZone(timezone).toISODate() ?? undefined;

  const slotsQuery = useQuery({
    queryKey: ['availability', 'slots', serviceId, staffProfileId, timezone, date],
    queryFn: () => {
      const search = new URLSearchParams({
        serviceId,
        staffProfileId,
        fromDate: date ?? '',
        toDate: date ?? '',
        timezone,
      });
      return api.get<AvailabilitySearchResult>(
        `/appointments/availability/slots?${search.toString()}`,
      );
    },
    enabled: date !== null && !disabled,
    // Slots go stale the instant somebody else books one, and this list is the
    // thing the user is about to act on.
    staleTime: 15_000,
  });

  const slots = slotsQuery.data?.slots ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Field label="New date" required>
        {(fieldProps) => (
          <DatePicker
            {...fieldProps}
            value={date}
            onChange={onDateChange}
            timezone={timezone}
            min={today}
            disabled={disabled}
          />
        )}
      </Field>

      <fieldset disabled={disabled} className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-fg">New time</legend>

        {date === null ? (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-fg-muted">
            Choose a date to see the times that are free.
          </p>
        ) : slotsQuery.isPending ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-hidden="true">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-9" />
            ))}
          </div>
        ) : slotsQuery.isError ? (
          <ErrorState
            error={slotsQuery.error}
            onRetry={() => void slotsQuery.refetch()}
            className="py-8"
          />
        ) : slots.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border px-3 py-8 text-center">
            <CalendarX2 className="size-5 text-fg-muted" aria-hidden="true" />
            <p className="text-sm text-fg-muted">Nothing is free on this date. Try another day.</p>
          </div>
        ) : (
          <>
            <div role="none" className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {slots.map((slot) => {
                const selected = slot.startsAt === value;
                const isCurrent = currentStartsAt === slot.startsAt;
                return (
                  <label
                    key={slot.startsAt}
                    className={cn(
                      'relative flex cursor-pointer items-center justify-center rounded-md border px-2 py-2 text-sm tabular-nums transition-colors',
                      'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus',
                      selected
                        ? 'border-brand bg-brand font-semibold text-on-brand'
                        : 'border-border bg-surface text-fg-secondary hover:bg-surface-hover hover:text-fg',
                    )}
                  >
                    <input
                      type="radio"
                      name={groupName}
                      value={slot.startsAt}
                      checked={selected}
                      onChange={() => onChange(slot.startsAt)}
                      className="mf-sr-only"
                    />
                    {formatTime(slot.startsAt, timezone)}
                    {isCurrent ? <span className="mf-sr-only"> (the current time)</span> : null}
                  </label>
                );
              })}
            </div>
            {slotsQuery.data?.truncated === true ? (
              <p className="text-xs text-fg-muted">
                More times exist than are shown here. Pick a narrower date if you do not see the one
                you want.
              </p>
            ) : null}
          </>
        )}
      </fieldset>
    </div>
  );
}
