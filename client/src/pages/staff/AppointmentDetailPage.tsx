import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock,
  Clock,
  Mail,
  MapPin,
  Phone,
  Receipt,
  Sparkles,
  UserRound,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { useParams } from 'react-router-dom';
import { z } from 'zod';
import { PageHeader } from '@/components/layout/PageHeader';
import { PermissionGate } from '@/components/layout/PermissionGate';
import {
  APPOINTMENT_EVENTS,
  AppointmentActions,
  AppointmentStatusBadge,
  ALLOWED_TRANSITIONS,
  RescheduleDialog,
  ownerKeys,
  useAppointmentActions,
  useLiveRefresh,
  type AppointmentDetail,
  type RescheduleTarget,
} from '@/components/owner';
import {
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  ErrorState,
  Field,
  Input,
  Skeleton,
  Textarea,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/apiClient';
import {
  formatDateLong,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatTime,
  formatTimeRange,
  formatZoneOffset,
  customerName,
  humanizeEnum,
} from '@/lib/format';
import { PERMISSIONS } from '@/lib/permissions';
import { FormBanner } from '@/pages/auth/FormBanner';
import { useFormApiError } from '@/pages/auth/useFormApiError';

const BREADCRUMBS = [{ label: 'My schedule', to: '/app/my/schedule' }, { label: 'Appointment' }];

/**
 * Where a booking came from, in words a person would use.
 *
 * Keyed loosely on purpose: the server's source enum carries a value the shared
 * types have not caught up with, and an unrecognised one should read as a tidy
 * label rather than break the row it sits in.
 */
const SOURCE_LABELS: Record<string, string> = {
  PUBLIC: 'Booked online',
  STAFF: 'Booked by a team member',
  OWNER: 'Booked by the owner',
  ADMIN: 'Booked by support',
  WAITLIST: 'Promoted from the waitlist',
  API: 'Booked through the API',
};

const notesSchema = z.object({
  title: z.string().trim().max(200, 'Keep the title under 200 characters.'),
  customerNotes: z.string().trim().max(5000, 'Keep this under 5000 characters.'),
  internalNotes: z.string().trim().max(5000, 'Keep this under 5000 characters.'),
});

type NotesValues = z.infer<typeof notesSchema>;

const NOTES_FIELDS = ['title', 'customerNotes', 'internalNotes'] as const;

/** `null` erases the stored value; the API distinguishes that from "unchanged". */
function toNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Booking-form answers are workspace-defined, so values arrive untyped. */
function answerToText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map((entry) => answerToText(entry)).join(', ');
  return JSON.stringify(value);
}

/** `firstVisit` → `First visit`, so a question key reads as a label. */
function answerLabel(key: string): string {
  return humanizeEnum(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2'));
}

function DetailRow({
  icon,
  label,
  children,
}: {
  icon: JSX.Element;
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0 text-fg-muted" aria-hidden="true">
        {icon}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">{label}</dt>
        <dd className="text-sm text-fg">{children}</dd>
      </div>
    </div>
  );
}

export default function AppointmentDetailPage(): JSX.Element {
  const { appointmentId = '' } = useParams<{ appointmentId: string }>();
  const { activeBusinessId, activeTimezone } = useAuth();
  const queryClient = useQueryClient();
  const { updateNotes } = useAppointmentActions();

  const [moveOpen, setMoveOpen] = useState(false);

  /*
   * Keyed under the management surface's own prefix on purpose: every lifecycle
   * action invalidates that prefix, so a check-in fired from this page — or
   * from the diary in another tab — refreshes this view without a second
   * invalidation rule that could drift from the first.
   */
  const detailQuery = useQuery({
    queryKey: ownerKeys.appointment(activeBusinessId, appointmentId),
    queryFn: () => api.get<AppointmentDetail>(`/appointments/${appointmentId}`),
    enabled: appointmentId.length > 0,
  });

  useLiveRefresh({
    events: APPOINTMENT_EVENTS,
    onRefresh: () => {
      void queryClient.invalidateQueries({
        queryKey: ownerKeys.appointment(activeBusinessId, appointmentId),
      });
    },
  });

  const detail = detailQuery.data;
  const appointment = detail?.appointment;

  const notesForm = useForm<NotesValues>({
    resolver: zodResolver(notesSchema),
    values: {
      title: appointment?.title ?? '',
      customerNotes: appointment?.customerNotes ?? '',
      internalNotes: appointment?.internalNotes ?? '',
    },
  });
  const { formError, clearFormError, handleApiError } = useFormApiError<NotesValues>(
    notesForm.setError,
    NOTES_FIELDS,
  );

  if (detailQuery.isPending) {
    return (
      <>
        <PageHeader title="Appointment" breadcrumbs={BREADCRUMBS} />
        <div className="flex flex-col gap-4" aria-hidden="true">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </>
    );
  }

  if (detailQuery.isError || !detail || !appointment) {
    return (
      <>
        <PageHeader title="Appointment" breadcrumbs={BREADCRUMBS} />
        <Card>
          <ErrorState
            error={detailQuery.error}
            onRetry={() => void detailQuery.refetch()}
            title="We could not open this appointment"
          />
        </Card>
      </>
    );
  }

  // The clock a provider works to is the site's, then the workspace's.
  // `appointment.timezone` is the *customer's* zone and is shown separately.
  const zone = appointment.location?.timezone ?? activeTimezone;
  const heading = appointment.title ?? appointment.service?.name ?? 'Appointment';
  const terminal = ALLOWED_TRANSITIONS[appointment.status].length === 0;

  // The organiser's participant row is the one carrying full contact detail;
  // the appointment's own `customer` is the summary the diary list uses.
  const contact =
    detail.participants.find((entry) => entry.role === 'ORGANIZER')?.customer ??
    detail.participants[0]?.customer ??
    null;
  // Both branches read a Customer, whose `lastName` is nullable — hence the
  // shared helper rather than a template literal, which renders "Jane null".
  const displayName = contact
    ? customerName(contact)
    : appointment.customer
      ? customerName(appointment.customer)
      : null;

  const answers = Object.entries(appointment.answers);

  const timeline = [
    ...detail.statusHistory.map((entry) => ({
      id: entry.id,
      at: entry.createdAt,
      title:
        entry.fromStatus === null
          ? `Booked as ${humanizeEnum(entry.toStatus).toLowerCase()}`
          : `${humanizeEnum(entry.fromStatus)} → ${humanizeEnum(entry.toStatus)}`,
      actor: entry.actorLabel ?? humanizeEnum(entry.actorType),
      note: entry.reason,
    })),
    ...detail.rescheduleHistory.map((entry) => ({
      id: entry.id,
      at: entry.createdAt,
      title: `Moved from ${formatDateTime(entry.previousStartsAt, zone)} to ${formatDateTime(entry.newStartsAt, zone)}`,
      actor: 'Reschedule',
      note: entry.reason,
    })),
  ].sort((a, b) => (a.at < b.at ? -1 : 1));

  const rescheduleTarget: RescheduleTarget = {
    id: appointment.id,
    serviceId: appointment.serviceId,
    serviceName: appointment.service?.name ?? null,
    staffProfileId: appointment.staffProfileId,
    locationId: appointment.locationId,
    startsAt: appointment.startsAt,
    timezone: zone,
  };

  const onSaveNotes = notesForm.handleSubmit(async (values) => {
    clearFormError();
    const input: {
      title?: string | null;
      customerNotes?: string | null;
      internalNotes?: string | null;
    } = {};
    const dirty = notesForm.formState.dirtyFields;
    if (dirty.title === true) input.title = toNullable(values.title);
    if (dirty.customerNotes === true) input.customerNotes = toNullable(values.customerNotes);
    if (dirty.internalNotes === true) input.internalNotes = toNullable(values.internalNotes);
    if (Object.keys(input).length === 0) return;

    try {
      await updateNotes.mutateAsync({ id: appointment.id, input });
      notesForm.reset(values);
    } catch (error) {
      handleApiError(error);
    }
  });

  return (
    <>
      <PageHeader
        title={heading}
        breadcrumbs={BREADCRUMBS}
        description={
          <>
            {formatDateLong(appointment.startsAt, zone)} ·{' '}
            {formatTimeRange(appointment.startsAt, appointment.endsAt, zone)} (
            {formatZoneOffset(zone, appointment.startsAt)}) ·{' '}
            {formatDuration(appointment.durationMinutes)}
          </>
        }
        actions={<AppointmentStatusBadge status={appointment.status} />}
      />

      {/* --- Lifecycle ------------------------------------------------------ */}
      <Card>
        <CardHeader
          as="h2"
          title="What you can do"
          description={
            terminal
              ? 'This appointment has reached a final state, so nothing further can be recorded against it.'
              : 'Only the actions your role allows, and that this appointment’s current state permits, are shown.'
          }
        />
        <CardBody>
          {terminal ? (
            <p className="text-sm text-fg-muted">
              {humanizeEnum(appointment.status)}
              {appointment.cancellationReason ? ` — ${appointment.cancellationReason}` : ''}
              {appointment.cancelledAt
                ? ` on ${formatDateTime(appointment.cancelledAt, zone)}`
                : ''}
            </p>
          ) : (
            <AppointmentActions
              appointment={appointment}
              variant="buttons"
              onReschedule={() => setMoveOpen(true)}
            />
          )}
        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* --- Customer ---------------------------------------------------- */}
        <Card>
          <CardHeader as="h2" title="Who you are seeing" />
          <CardBody>
            {displayName ? (
              <dl className="flex flex-col gap-4">
                <DetailRow icon={<UserRound className="size-4" />} label="Name">
                  {displayName}
                </DetailRow>
                {contact?.email ? (
                  <DetailRow icon={<Mail className="size-4" />} label="Email">
                    <a
                      href={`mailto:${contact.email}`}
                      className="rounded-xs text-brand-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      {contact.email}
                    </a>
                  </DetailRow>
                ) : null}
                {contact?.phone ? (
                  <DetailRow icon={<Phone className="size-4" />} label="Phone">
                    <a
                      href={`tel:${contact.phone}`}
                      className="rounded-xs text-brand-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      {contact.phone}
                    </a>
                  </DetailRow>
                ) : null}
                {contact?.timezone && contact.timezone !== zone ? (
                  <DetailRow icon={<Clock className="size-4" />} label="Their local time">
                    {formatTime(appointment.startsAt, contact.timezone)} on{' '}
                    {formatDateLong(appointment.startsAt, contact.timezone)} (
                    {contact.timezone.replace(/_/g, ' ')})
                  </DetailRow>
                ) : null}
              </dl>
            ) : (
              <p className="text-sm text-fg-muted">
                This appointment has no customer record attached to it.
              </p>
            )}

            {appointment.customerNotes ? (
              <div className="mt-5 rounded-md border border-border bg-surface-sunken px-3.5 py-3">
                <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                  What the customer told you
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-fg-secondary">
                  {appointment.customerNotes}
                </p>
              </div>
            ) : null}

            {answers.length > 0 ? (
              <dl className="mt-5 flex flex-col gap-2 border-t border-border pt-4">
                {answers.map(([key, value]) => (
                  <div key={key} className="flex flex-wrap items-baseline gap-x-2">
                    <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                      {answerLabel(key)}
                    </dt>
                    <dd className="text-sm text-fg-secondary">{answerToText(value)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </CardBody>
        </Card>

        {/* --- Booking ----------------------------------------------------- */}
        <Card>
          <CardHeader as="h2" title="The booking" />
          <CardBody>
            <dl className="flex flex-col gap-4">
              <DetailRow icon={<Sparkles className="size-4" />} label="Service">
                {appointment.service?.name ?? 'No service on this booking'}
              </DetailRow>
              <DetailRow icon={<Clock className="size-4" />} label="Time on site">
                {formatTimeRange(appointment.bufferStartAt, appointment.bufferEndAt, zone)}
                {appointment.preBufferMinutes > 0 || appointment.postBufferMinutes > 0 ? (
                  <span className="text-fg-muted">
                    {' '}
                    (includes {appointment.preBufferMinutes} min before and{' '}
                    {appointment.postBufferMinutes} min after)
                  </span>
                ) : null}
              </DetailRow>
              {appointment.location ? (
                <DetailRow icon={<MapPin className="size-4" />} label="Location">
                  {appointment.location.name}
                </DetailRow>
              ) : null}
              <DetailRow icon={<Receipt className="size-4" />} label="Price">
                {formatMoney(appointment.priceAmount, appointment.currency)}
              </DetailRow>
              {appointment.capacity > 1 ? (
                <DetailRow icon={<UserRound className="size-4" />} label="Places">
                  {appointment.bookedCount} of {appointment.capacity} booked
                </DetailRow>
              ) : null}
              <DetailRow icon={<CalendarClock className="size-4" />} label="Reference">
                <span className="font-mono text-xs">{appointment.publicId}</span>
                <span className="block text-xs text-fg-muted">
                  {SOURCE_LABELS[appointment.source] ?? humanizeEnum(appointment.source)} ·{' '}
                  {formatDateTime(appointment.createdAt, zone)}
                </span>
              </DetailRow>
            </dl>
          </CardBody>
        </Card>
      </div>

      {/* --- Notes ---------------------------------------------------------- */}
      <PermissionGate
        permission={[PERMISSIONS.APPOINTMENTS_UPDATE, PERMISSIONS.APPOINTMENTS_NOTES_MANAGE]}
        mode="any"
      >
        <Card>
          <CardHeader
            as="h2"
            title="Notes"
            description="Internal notes are never shown to the customer."
          />
          <form onSubmit={onSaveNotes} noValidate>
            <CardBody className="flex flex-col gap-4">
              <FormBanner message={formError} />

              <PermissionGate permission={PERMISSIONS.APPOINTMENTS_UPDATE}>
                <Field
                  label="Display title"
                  hint="Renames this booking in the diary. Leave empty to use the service name."
                  error={notesForm.formState.errors.title?.message}
                >
                  {(fieldProps) => (
                    <Input
                      {...fieldProps}
                      {...notesForm.register('title')}
                      maxLength={200}
                      placeholder={appointment.service?.name ?? 'Appointment'}
                    />
                  )}
                </Field>

                <Field
                  label="Note from the customer"
                  hint="Editable because your role can amend booking details."
                  error={notesForm.formState.errors.customerNotes?.message}
                >
                  {(fieldProps) => (
                    <Textarea
                      {...fieldProps}
                      {...notesForm.register('customerNotes')}
                      rows={3}
                      placeholder="Nothing recorded"
                    />
                  )}
                </Field>
              </PermissionGate>

              <PermissionGate permission={PERMISSIONS.APPOINTMENTS_NOTES_MANAGE}>
                <Field
                  label="Internal note"
                  hint="Only your team can read this."
                  error={notesForm.formState.errors.internalNotes?.message}
                >
                  {(fieldProps) => (
                    <Textarea
                      {...fieldProps}
                      {...notesForm.register('internalNotes')}
                      rows={4}
                      placeholder="What happened, what to remember for next time"
                    />
                  )}
                </Field>
              </PermissionGate>
            </CardBody>
            <CardFooter>
              <Button
                type="submit"
                loading={updateNotes.isPending}
                disabled={!notesForm.formState.isDirty}
              >
                Save notes
              </Button>
            </CardFooter>
          </form>
        </Card>
      </PermissionGate>

      {/* --- Timeline ------------------------------------------------------- */}
      <Card>
        <CardHeader
          as="h2"
          title="History"
          description="Every change the API recorded against this booking."
        />
        <CardBody>
          <ol className="flex flex-col gap-4">
            {timeline.map((entry) => (
              <li key={entry.id} className="flex gap-3">
                <span
                  className="mt-1.5 size-2 shrink-0 rounded-full bg-border-strong"
                  aria-hidden="true"
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="text-sm font-medium text-fg">{entry.title}</p>
                  <p className="text-xs text-fg-muted">
                    {formatDateTime(entry.at, zone)} · {entry.actor}
                  </p>
                  {entry.note ? (
                    <p className="text-sm leading-relaxed text-fg-secondary">{entry.note}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>

      <RescheduleDialog
        appointment={rescheduleTarget}
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
      />
    </>
  );
}
