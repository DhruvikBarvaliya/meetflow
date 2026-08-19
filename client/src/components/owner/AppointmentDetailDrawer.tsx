import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Mail, MapPin, Phone, Tag, User } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Drawer, ErrorState, Field, Skeleton, Textarea } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/apiClient';
import {
  customerName,
  formatDateLong,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatTimeRange,
  formatZoneOffset,
  humanizeEnum,
} from '@/lib/format';
import { PERMISSIONS } from '@/lib/permissions';
import { AppointmentActions } from './AppointmentActions';
import { ownerKeys } from './queryKeys';
import { RescheduleDialog, type RescheduleTarget } from './RescheduleDialog';
import { AppointmentStatusBadge } from './StatusBadge';
import type { AppointmentDetail } from './types';
import { useAppointmentActions } from './useAppointmentActions';

export interface AppointmentDetailDrawerProps {
  appointmentId: string | null;
  open: boolean;
  onClose: () => void;
}

function DetailRow({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof User;
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">{label}</p>
        <div className="mt-0.5 text-sm text-fg">{children}</div>
      </div>
    </div>
  );
}

/**
 * A booking-form answer key as a person would read it.
 *
 * The keys are chosen by whoever built the booking link and are constrained to
 * `lower_snake` or `camelCase`, so both have to be broken apart — `firstVisit`
 * printed verbatim next to an answer looks like a bug in the product.
 */
function answerLabel(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** `true` is not an answer anybody gave; the question was yes or no. */
function answerValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ');
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

function SectionHeading({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{children}</h3>
  );
}

/**
 * Everything known about one booking, with the actions that can change it.
 *
 * Two clocks are shown whenever they differ. The workspace's is the one the
 * diary is kept in; the customer's is the one they will turn up by. A drawer
 * that shows only one of them is how a customer gets told the wrong time.
 */
export function AppointmentDetailDrawer({
  appointmentId,
  open,
  onClose,
}: AppointmentDetailDrawerProps): JSX.Element {
  const { activeBusinessId, activeTimezone, can } = useAuth();
  const queryClient = useQueryClient();
  const { updateNotes } = useAppointmentActions();

  const [rescheduling, setRescheduling] = useState(false);
  const [internalNotes, setInternalNotes] = useState('');
  const [notesDirty, setNotesDirty] = useState(false);

  const detailQuery = useQuery({
    queryKey: ownerKeys.appointment(activeBusinessId, appointmentId ?? ''),
    queryFn: () => api.get<AppointmentDetail>(`/appointments/${appointmentId ?? ''}`),
    enabled: open && appointmentId !== null,
  });

  const detail = detailQuery.data;
  const appointment = detail?.appointment;

  // The textarea is uncontrolled by the server once the operator starts typing;
  // resetting on every refetch would delete a half-written note under them.
  useEffect(() => {
    if (!appointment || notesDirty) return;
    setInternalNotes(appointment.internalNotes ?? '');
  }, [appointment, notesDirty]);

  useEffect(() => {
    if (!open) setNotesDirty(false);
  }, [open]);

  const canManageNotes = can(PERMISSIONS.APPOINTMENTS_NOTES_MANAGE);

  const refresh = (): void => {
    void queryClient.invalidateQueries({
      queryKey: ownerKeys.appointment(activeBusinessId, appointmentId ?? ''),
    });
  };

  const target: RescheduleTarget | null = appointment
    ? {
        id: appointment.id,
        serviceId: appointment.serviceId,
        serviceName: appointment.service?.name ?? null,
        staffProfileId: appointment.staffProfileId,
        locationId: appointment.locationId,
        startsAt: appointment.startsAt,
        timezone: appointment.timezone,
      }
    : null;

  const customer = appointment?.customer ?? null;
  const customerZone = detail?.participants[0]?.customer?.timezone ?? null;
  const showsTwoClocks =
    appointment !== undefined && customerZone !== null && customerZone !== appointment.timezone;

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title="Appointment"
        description={appointment ? appointment.publicId : undefined}
        width="lg"
        footer={
          appointment ? (
            <AppointmentActions
              appointment={appointment}
              variant="buttons"
              onReschedule={() => setRescheduling(true)}
              onCompleted={refresh}
            />
          ) : undefined
        }
      >
        {detailQuery.isPending ? (
          <div className="flex flex-col gap-4" aria-live="polite">
            <span className="mf-sr-only">Loading appointment</span>
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : detailQuery.isError ? (
          <ErrorState error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />
        ) : appointment ? (
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center gap-2">
              <AppointmentStatusBadge status={appointment.status} />
              <Badge tone="neutral">Booked via {humanizeEnum(appointment.source)}</Badge>
              {appointment.requiresApproval && appointment.status === 'PENDING' ? (
                <Badge tone="warning">Awaiting approval</Badge>
              ) : null}
              {appointment.lateCancellation ? <Badge tone="danger">Late cancellation</Badge> : null}
            </div>

            <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface-sunken p-4">
              <DetailRow icon={Clock} label="When">
                <p className="font-medium">
                  {formatDateLong(appointment.startsAt, appointment.timezone)}
                </p>
                <p className="tabular-nums text-fg-secondary">
                  {formatTimeRange(appointment.startsAt, appointment.endsAt, appointment.timezone)}{' '}
                  · {formatDuration(appointment.durationMinutes)} ·{' '}
                  {formatZoneOffset(appointment.timezone, appointment.startsAt)}
                </p>
                {showsTwoClocks && customerZone ? (
                  <p className="mt-1 text-xs text-fg-muted">
                    Customer&rsquo;s clock:{' '}
                    {formatTimeRange(appointment.startsAt, appointment.endsAt, customerZone)} (
                    {customerZone})
                  </p>
                ) : null}
                {appointment.preBufferMinutes > 0 || appointment.postBufferMinutes > 0 ? (
                  <p className="mt-1 text-xs text-fg-muted">
                    Held from{' '}
                    {formatTimeRange(
                      appointment.bufferStartAt,
                      appointment.bufferEndAt,
                      appointment.timezone,
                    )}{' '}
                    including buffers.
                  </p>
                ) : null}
              </DetailRow>

              <DetailRow icon={Tag} label="Service">
                <p>{appointment.service?.name ?? 'No service attached'}</p>
                <p className="text-fg-secondary">
                  {formatMoney(appointment.priceAmount, appointment.currency)}
                  {appointment.capacity > 1
                    ? ` · ${appointment.bookedCount} of ${appointment.capacity} places taken`
                    : ''}
                </p>
              </DetailRow>

              <DetailRow icon={User} label="Provider">
                {appointment.staffProfile?.displayName ?? 'Unassigned'}
              </DetailRow>

              {appointment.location ? (
                <DetailRow icon={MapPin} label="Location">
                  {appointment.location.name}
                </DetailRow>
              ) : null}
            </div>

            {customer ? (
              <section className="flex flex-col gap-3">
                <SectionHeading>Customer</SectionHeading>
                <div className="flex flex-col gap-2 text-sm">
                  <p className="font-medium text-fg">
                    {can(PERMISSIONS.CUSTOMERS_READ) ? (
                      <Link
                        to={`/app/customers?customer=${customer.id}`}
                        className="rounded-xs text-brand-text underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                      >
                        {customerName(customer)}
                      </Link>
                    ) : (
                      customerName(customer)
                    )}
                  </p>
                  {customer.email ? (
                    <p className="flex items-center gap-2 text-fg-secondary">
                      <Mail className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
                      <a
                        href={`mailto:${customer.email}`}
                        className="rounded-xs underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                      >
                        {customer.email}
                      </a>
                    </p>
                  ) : null}
                  {customer.phone ? (
                    <p className="flex items-center gap-2 text-fg-secondary">
                      <Phone className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
                      <a
                        href={`tel:${customer.phone}`}
                        className="rounded-xs underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                      >
                        {customer.phone}
                      </a>
                    </p>
                  ) : null}
                </div>
              </section>
            ) : null}

            {appointment.customerNotes ? (
              <section className="flex flex-col gap-2">
                <SectionHeading>What the customer told you</SectionHeading>
                <p className="whitespace-pre-wrap rounded-md border border-border px-3 py-2 text-sm leading-relaxed text-fg-secondary">
                  {appointment.customerNotes}
                </p>
              </section>
            ) : null}

            {Object.keys(appointment.answers).length > 0 ? (
              <section className="flex flex-col gap-2">
                <SectionHeading>Booking form answers</SectionHeading>
                <dl className="flex flex-col gap-2 text-sm">
                  {Object.entries(appointment.answers).map(([key, value]) => (
                    <div key={key} className="flex flex-wrap gap-x-2">
                      <dt className="font-medium text-fg-secondary">{answerLabel(key)}:</dt>
                      <dd className="text-fg">{answerValue(value)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ) : null}

            {canManageNotes ? (
              <section className="flex flex-col gap-2">
                <Field
                  label="Internal note"
                  hint="Visible to your team only — never sent to the customer."
                >
                  {(field) => (
                    <Textarea
                      {...field}
                      rows={3}
                      maxLength={5000}
                      value={internalNotes}
                      onChange={(event) => {
                        setInternalNotes(event.target.value);
                        setNotesDirty(true);
                      }}
                      placeholder="Prefers the quieter room; allow ten extra minutes."
                    />
                  )}
                </Field>
                {notesDirty ? (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      loading={updateNotes.isPending}
                      onClick={() =>
                        updateNotes.mutate(
                          {
                            id: appointment.id,
                            input: {
                              internalNotes: internalNotes.trim() === '' ? null : internalNotes,
                            },
                          },
                          {
                            onSuccess: () => {
                              setNotesDirty(false);
                              refresh();
                            },
                          },
                        )
                      }
                    >
                      Save note
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setInternalNotes(appointment.internalNotes ?? '');
                        setNotesDirty(false);
                      }}
                    >
                      Discard
                    </Button>
                  </div>
                ) : null}
              </section>
            ) : appointment.internalNotes ? (
              <section className="flex flex-col gap-2">
                <SectionHeading>Internal note</SectionHeading>
                <p className="whitespace-pre-wrap rounded-md border border-border px-3 py-2 text-sm leading-relaxed text-fg-secondary">
                  {appointment.internalNotes}
                </p>
              </section>
            ) : null}

            {detail && detail.rescheduleHistory.length > 0 ? (
              <section className="flex flex-col gap-2">
                <SectionHeading>Moved {detail.rescheduleHistory.length} time(s)</SectionHeading>
                <ul className="flex flex-col gap-2">
                  {detail.rescheduleHistory.map((entry) => (
                    <li key={entry.id} className="text-sm text-fg-secondary">
                      <span className="tabular-nums">
                        {formatDateTime(entry.previousStartsAt, appointment.timezone)}
                      </span>{' '}
                      →{' '}
                      <span className="tabular-nums font-medium text-fg">
                        {formatDateTime(entry.newStartsAt, appointment.timezone)}
                      </span>
                      {entry.reason ? (
                        <span className="block text-xs text-fg-muted">{entry.reason}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {detail && detail.statusHistory.length > 0 ? (
              <section className="flex flex-col gap-3">
                <SectionHeading>History</SectionHeading>
                <ol className="flex flex-col gap-3 border-l border-border pl-4">
                  {detail.statusHistory.map((entry) => (
                    <li key={entry.id} className="relative text-sm">
                      <span
                        aria-hidden="true"
                        className="absolute -left-[1.3125rem] top-1.5 size-2 rounded-full bg-border-strong"
                      />
                      <p className="font-medium text-fg">
                        {entry.fromStatus
                          ? `${humanizeEnum(entry.fromStatus)} → ${humanizeEnum(entry.toStatus)}`
                          : humanizeEnum(entry.toStatus)}
                      </p>
                      <p className="text-xs text-fg-muted">
                        {formatDateTime(entry.createdAt, activeTimezone)} ·{' '}
                        {entry.actorLabel ?? humanizeEnum(entry.actorType)}
                      </p>
                      {entry.reason ? (
                        <p className="mt-0.5 text-xs text-fg-secondary">{entry.reason}</p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}
          </div>
        ) : null}
      </Drawer>

      <RescheduleDialog
        appointment={target}
        open={rescheduling}
        onClose={() => setRescheduling(false)}
        onMoved={refresh}
      />
    </>
  );
}
