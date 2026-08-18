import { useQuery } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  DatePicker,
  Dialog,
  ErrorState,
  Field,
  Select,
  Skeleton,
  Textarea,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/apiClient';
import { cn } from '@/lib/cn';
import { formatDateLong, formatTime, formatZoneOffset, toIsoDate } from '@/lib/format';
import { PERMISSIONS } from '@/lib/permissions';
import { FormBanner } from '@/pages/auth/FormBanner';
import { ownerKeys, toSearchParams } from './queryKeys';
import type { AvailabilitySearchResult, AvailableSlot } from './types';
import { useAppointmentActions } from './useAppointmentActions';
import { useStaffLookup } from './useWorkspaceLookups';

export interface RescheduleTarget {
  id: string;
  serviceId: string | null;
  serviceName: string | null;
  staffProfileId: string | null;
  locationId: string | null;
  startsAt: string;
  /** The zone the booking was made in; the picker resolves days in it. */
  timezone: string;
}

export interface RescheduleDialogProps {
  appointment: RescheduleTarget | null;
  open: boolean;
  onClose: () => void;
  /** Called after the move succeeds, so a drawer can refresh or close. */
  onMoved?: () => void;
}

/**
 * Moves a booking to another slot the scheduling engine actually offers.
 *
 * The times shown are not a grid of every quarter hour: they come from
 * `GET /appointments/availability/slots`, which has already applied the
 * service's buffers, the provider's rota, resource contention and the
 * workspace's notice period. Offering anything else would mean telling an
 * operator a time exists and then refusing it after they have told the
 * customer.
 *
 * Days are resolved in the booking's own timezone. A studio in Kolkata being
 * rearranged by a manager in London must see the studio's Tuesday.
 */
export function RescheduleDialog({
  appointment,
  open,
  onClose,
  onMoved,
}: RescheduleDialogProps): JSX.Element | null {
  const { activeBusinessId, can } = useAuth();
  const { reschedule } = useAppointmentActions();
  const staff = useStaffLookup();

  const zone = appointment?.timezone ?? 'UTC';
  const today = DateTime.now().setZone(zone).toISODate() ?? '';

  const [date, setDate] = useState<string>(today);
  const [staffProfileId, setStaffProfileId] = useState<string>('');
  const [selected, setSelected] = useState<AvailableSlot | null>(null);
  const [reason, setReason] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reopening for a different booking must not inherit the last one's choices.
  useEffect(() => {
    if (!open || !appointment) return;
    setDate(toIsoDate(appointment.startsAt, appointment.timezone));
    setStaffProfileId(appointment.staffProfileId ?? '');
    setSelected(null);
    setReason('');
    setSubmitError(null);
  }, [open, appointment]);

  const canSearch = can(PERMISSIONS.AVAILABILITY_READ);
  const serviceId = appointment?.serviceId ?? null;

  const scope = useMemo(
    () => ({
      serviceId: serviceId ?? '',
      staffProfileId: staffProfileId === '' ? undefined : staffProfileId,
      fromDate: date,
      toDate: date,
      timezone: zone,
    }),
    [serviceId, staffProfileId, date, zone],
  );

  const slotsQuery = useQuery({
    queryKey: ownerKeys.slots(activeBusinessId, scope),
    queryFn: () =>
      api.get<AvailabilitySearchResult>(`/appointments/availability/slots${toSearchParams(scope)}`),
    enabled: open && canSearch && serviceId !== null && date !== '',
    // Availability is the most perishable thing in the product: a slot offered
    // from cache is a slot a colleague may already have taken.
    staleTime: 0,
    gcTime: 0,
  });

  const staffOptions = useMemo(
    () => [
      { value: '', label: 'Any available provider' },
      ...staff.items.map((profile) => ({ value: profile.id, label: profile.displayName })),
    ],
    [staff.items],
  );

  if (!appointment) return null;

  const slots = slotsQuery.data?.slots ?? [];

  const onConfirm = (): void => {
    if (!selected) return;
    setSubmitError(null);
    reschedule.mutate(
      {
        id: appointment.id,
        input: {
          startsAt: selected.startsAt,
          staffProfileId: selected.staffProfileId,
          // The API takes an optional locationId, not a nullable one: a mobile
          // service with no site must omit the key rather than send null.
          ...(selected.locationId ? { locationId: selected.locationId } : {}),
          reason: reason.trim() === '' ? null : reason.trim(),
        },
      },
      {
        onSuccess: () => {
          onMoved?.();
          onClose();
        },
        onError: (error) => {
          setSubmitError(
            error instanceof Error
              ? error.message
              : 'That time is no longer available. Choose another.',
          );
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Move this appointment"
      description={
        <>
          Currently {formatDateLong(appointment.startsAt, zone)} at{' '}
          {formatTime(appointment.startsAt, zone)} ({formatZoneOffset(zone, appointment.startsAt)}).
          Only times the scheduling engine can actually fill are offered.
        </>
      }
      width="lg"
      dismissOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={reschedule.isPending}>
            Keep the current time
          </Button>
          <Button onClick={onConfirm} disabled={selected === null} loading={reschedule.isPending}>
            {selected ? `Move to ${formatTime(selected.startsAt, zone)}` : 'Choose a time'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormBanner message={submitError} />

        {serviceId === null ? (
          <p className="text-sm text-fg-muted">
            This booking has no service attached, so no availability can be searched for it.
          </p>
        ) : !canSearch ? (
          <p className="text-sm text-fg-muted">
            Your role cannot read availability, so times cannot be offered here.
          </p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Date" hint={`Days are read in ${zone}.`}>
                {(field) => (
                  <DatePicker
                    {...field}
                    value={date}
                    onChange={(next) => {
                      setDate(next);
                      setSelected(null);
                    }}
                    timezone={zone}
                    min={today}
                  />
                )}
              </Field>

              <Field label="Provider" hint="Narrow the search, or let the engine choose.">
                {(field) => (
                  <Select
                    {...field}
                    options={staffOptions}
                    value={staffProfileId}
                    onChange={(event) => {
                      setStaffProfileId(event.target.value);
                      setSelected(null);
                    }}
                  />
                )}
              </Field>
            </div>

            <div>
              <p className="mb-2 text-sm font-medium text-fg">
                {appointment.serviceName ?? 'Available times'}
              </p>

              <div aria-live="polite" aria-busy={slotsQuery.isFetching}>
                {slotsQuery.isPending ? (
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {Array.from({ length: 8 }, (_, index) => (
                      <Skeleton key={index} className="h-10 w-full" />
                    ))}
                  </div>
                ) : slotsQuery.isError ? (
                  <ErrorState
                    error={slotsQuery.error}
                    onRetry={() => void slotsQuery.refetch()}
                    className="py-6"
                  />
                ) : slots.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-fg-muted">
                    Nothing is free on {formatDateLong(date, zone)}. Try another day, or widen the
                    search by choosing any provider.
                  </p>
                ) : (
                  <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {slots.map((slot) => {
                      const isSelected =
                        selected?.startsAt === slot.startsAt &&
                        selected.staffProfileId === slot.staffProfileId;
                      return (
                        <li key={`${slot.startsAt}-${slot.staffProfileId}`}>
                          <button
                            type="button"
                            onClick={() => setSelected(slot)}
                            aria-pressed={isSelected}
                            className={cn(
                              'flex w-full flex-col items-center gap-0.5 rounded-md border px-2 py-2 text-sm transition-colors',
                              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                              isSelected
                                ? 'border-brand bg-brand-subtle font-semibold text-brand-text'
                                : 'border-border bg-surface text-fg hover:bg-surface-hover',
                            )}
                          >
                            <span className="tabular-nums">{formatTime(slot.startsAt, zone)}</span>
                            <span className="truncate text-xs font-normal text-fg-muted">
                              {slot.staffName}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {slotsQuery.data?.truncated === true ? (
                <p className="mt-2 text-xs text-fg-muted">
                  More times exist than can be listed here. Narrow by provider to see the rest.
                </p>
              ) : null}
            </div>

            <Field
              label="Reason for the move"
              hint="Recorded on the booking's history and included in the customer's email."
            >
              {(field) => (
                <Textarea
                  {...field}
                  rows={2}
                  value={reason}
                  maxLength={500}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Therapist unavailable — offered the next morning slot."
                />
              )}
            </Field>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** The icon paired with this dialog wherever it is launched from. */
export const RescheduleIcon = CalendarClock;
