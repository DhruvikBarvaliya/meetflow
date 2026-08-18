/**
 * The customer's own view of one appointment, reached from the opaque link in
 * their confirmation email.
 *
 * No authentication: the `apt_…` handle *is* the credential, which is why the
 * page never exposes anything beyond this one appointment and never lets the
 * customer change the provider or location — only the time.
 *
 * Where policy forbids an action the control is disabled *and* the reason is
 * spelled out. The API returns `canCancel` / `canReschedule` as plain booleans
 * without saying why, so the reason is reconstructed from the deadline and the
 * remaining-moves count it does return.
 *
 * One structural constraint shapes the reschedule UI: availability is published
 * per *booking link*, and an appointment does not carry the slug it was booked
 * through. When this browser remembers the slug (or it arrives as `?link=`) the
 * customer gets the real slot grid; otherwise they name a date and time and the
 * server rules on it. Both paths hit the same endpoint.
 */
import { useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { DateTime } from 'luxon';
import {
  CalendarClock,
  CalendarX2,
  CheckCircle2,
  Clock,
  Info,
  MapPin,
  UserRound,
  Video,
} from 'lucide-react';
import {
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  DatePicker,
  ErrorState,
  Field,
  Skeleton,
  Textarea,
  TimePicker,
} from '@/components/ui';
// Imported from the file rather than the `@/components/owner` barrel: this is
// an unauthenticated page, and the barrel would pull the whole management
// bundle into the chunk a customer downloads.
import { AppointmentStatusBadge } from '@/components/owner/StatusBadge';
import { isApiError } from '@/lib/apiClient';
import {
  browserTimezone,
  formatDateLong,
  formatDuration,
  formatMoney,
  formatRelative,
  formatTimeRange,
  formatZoneLabel,
} from '@/lib/format';
import type { PublicSlot } from '@/types/api';
import { PublicShell } from './PublicShell';
import { SlotPicker } from './SlotPicker';
import {
  recallBookingLink,
  useAvailability,
  useBookingLink,
  useCancelPublicAppointment,
  usePublicAppointment,
  useReschedulePublicAppointment,
} from './publicApi';

const WINDOW_DAYS = 7;

/** Statuses after which nothing can be changed by anyone. */
const TERMINAL_STATUSES = ['CANCELLED', 'COMPLETED', 'NO_SHOW', 'REJECTED'];

export default function ManageBookingPage() {
  const { publicId = '' } = useParams<{ publicId: string }>();
  const [searchParams] = useSearchParams();
  const appointmentQuery = usePublicAppointment(publicId);
  const appointment = appointmentQuery.data;

  const [timezone, setTimezone] = useState(browserTimezone);
  const [mode, setMode] = useState<'view' | 'reschedule'>('view');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [selectedSlot, setSelectedSlot] = useState<PublicSlot | null>(null);
  const [manualDate, setManualDate] = useState<string | null>(null);
  const [manualTime, setManualTime] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [windowStart, setWindowStart] = useState<string | null>(null);

  const reschedule = useReschedulePublicAppointment(publicId);
  const cancel = useCancelPublicAppointment(publicId);

  // `?link=` lets the success page hand the slug straight over; localStorage
  // covers a later visit from the same browser.
  const slug = searchParams.get('link') ?? recallBookingLink(publicId) ?? '';
  const linkQuery = useBookingLink(slug);

  const todayIso = useMemo(
    () => DateTime.now().setZone(timezone).toFormat('yyyy-MM-dd'),
    [timezone],
  );
  const effectiveStart = windowStart && windowStart > todayIso ? windowStart : todayIso;
  const windowEnd = useMemo(
    () =>
      DateTime.fromISO(effectiveStart, { zone: timezone })
        .plus({ days: WINDOW_DAYS - 1 })
        .toFormat('yyyy-MM-dd'),
    [effectiveStart, timezone],
  );

  const isRescheduling = mode === 'reschedule';
  const canShowSlots = slug.length > 0;

  const availabilityQuery = useAvailability(
    slug,
    {
      serviceId: appointment?.service?.id ?? null,
      // Only when the link publishes a provider choice — otherwise the server
      // answers 422 and the grid never loads.
      staffProfileId: linkQuery.data?.link.allowStaffSelection
        ? (appointment?.staff?.id ?? null)
        : null,
      locationId: appointment?.location?.id ?? null,
      fromDate: effectiveStart,
      toDate: windowEnd,
      timezone,
    },
    isRescheduling && canShowSlots,
  );

  if (appointmentQuery.isLoading) {
    return (
      <PublicShell business={null}>
        <Skeleton className="mb-4 h-8 w-56" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </PublicShell>
    );
  }

  if (appointmentQuery.isError || !appointment) {
    return (
      <PublicShell business={null}>
        <ErrorState
          error={appointmentQuery.error}
          title="We could not find that appointment"
          onRetry={() => void appointmentQuery.refetch()}
        />
      </PublicShell>
    );
  }

  const { policy } = appointment;
  const startsAt = DateTime.fromISO(appointment.startsAt);
  const isPast = startsAt < DateTime.now();
  const isTerminal = TERMINAL_STATUSES.includes(appointment.status);
  const noticeMinutes = startsAt.diff(DateTime.now(), 'minutes').minutes;

  /**
   * Reconstructs *why* an action is closed. The API sends only the boolean, so
   * the deadline and remaining-move counts it also sends are used to name the
   * specific rule rather than showing a generic refusal.
   */
  function blockedReason(kind: 'reschedule' | 'cancel'): string | null {
    const allowed = kind === 'cancel' ? policy.canCancel : policy.canReschedule;
    if (allowed) return null;
    if (isTerminal) return `This appointment is ${appointment!.status.toLowerCase()}.`;
    if (isPast) return 'This appointment has already passed.';

    if (kind === 'reschedule' && policy.remainingReschedules <= 0) {
      return `This appointment has already been moved the maximum number of times. Please contact ${appointment!.business.name} if you need to change it.`;
    }

    const deadline =
      kind === 'cancel' ? policy.cancellationDeadlineMinutes : policy.rescheduleDeadlineMinutes;
    if (noticeMinutes < deadline) {
      const verb = kind === 'cancel' ? 'cancelled' : 'moved';
      return `Appointments can only be ${verb} online more than ${formatDuration(deadline)} in advance. Please contact ${appointment!.business.name}.`;
    }

    const verb = kind === 'cancel' ? 'Cancelling' : 'Rescheduling';
    return `${verb} online is not offered for this booking. Please contact ${appointment!.business.name}.`;
  }

  const rescheduleBlocked = blockedReason('reschedule');
  const cancelBlocked = blockedReason('cancel');

  /** The instant the customer has settled on, from whichever picker they used. */
  const chosenStartsAt: string | null = canShowSlots
    ? (selectedSlot?.startsAt ?? null)
    : manualDate && manualTime
      ? (DateTime.fromISO(`${manualDate}T${manualTime}`, { zone: timezone }).toISO() ?? null)
      : null;

  async function submitReschedule() {
    if (!chosenStartsAt) return;
    setActionError(null);
    setStatusMessage(null);
    try {
      await reschedule.mutateAsync({ startsAt: chosenStartsAt });
      setMode('view');
      setSelectedSlot(null);
      setManualDate(null);
      setManualTime(null);
      setStatusMessage('Your appointment has been moved. A new confirmation is on its way.');
      await appointmentQuery.refetch();
    } catch (error) {
      setActionError(
        isApiError(error) ? error.message : 'We could not move your appointment. Please try again.',
      );
      if (isApiError(error) && error.status === 409) {
        setSelectedSlot(null);
        void availabilityQuery.refetch();
      }
    }
  }

  async function submitCancel() {
    setActionError(null);
    setStatusMessage(null);
    try {
      await cancel.mutateAsync(cancelReason.trim() ? { reason: cancelReason.trim() } : {});
      setCancelOpen(false);
      setStatusMessage('Your appointment has been cancelled.');
      await appointmentQuery.refetch();
    } catch (error) {
      setCancelOpen(false);
      setActionError(
        isApiError(error)
          ? error.message
          : 'We could not cancel your appointment. Please try again.',
      );
    }
  }

  const customerName = appointment.customer
    ? [appointment.customer.firstName, appointment.customer.lastName].filter(Boolean).join(' ')
    : null;

  return (
    <PublicShell business={appointment.business} timezone={timezone} onTimezoneChange={setTimezone}>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Your appointment</h1>
        <AppointmentStatusBadge status={appointment.status} />
      </div>

      {/* One element, both seen and announced: `role="status"` is an implicit
          polite live region, so a separate visually-hidden copy would make a
          screen reader read the outcome twice. */}
      {statusMessage ? (
        <div
          role="status"
          className="mb-4 flex items-start gap-2 rounded-lg border border-success-border bg-success-subtle px-3 py-2 text-sm text-success-text"
        >
          <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {statusMessage}
        </div>
      ) : null}

      {actionError ? (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger-text"
        >
          {actionError}
        </div>
      ) : null}

      {appointment.status === 'CANCELLED' ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-surface-sunken px-3 py-2 text-sm text-fg-secondary">
          <CalendarX2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            This appointment was cancelled
            {appointment.cancelledAt ? ` ${formatRelative(appointment.cancelledAt, timezone)}` : ''}
            .{appointment.cancellationReason ? ` Reason: ${appointment.cancellationReason}` : ''}
          </span>
        </div>
      ) : null}

      {appointment.requiresApproval && appointment.status === 'PENDING' ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-info-subtle px-3 py-2 text-sm text-info-text">
          <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {appointment.business.name} has not confirmed this request yet. You will be emailed when
          they do.
        </div>
      ) : null}

      <Card>
        <CardBody className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-lg font-medium">
                {appointment.service?.name ?? appointment.title ?? 'Appointment'}
              </p>
              <p className="text-sm text-fg-muted">
                {formatDuration(appointment.durationMinutes)}
                {appointment.rescheduleCount > 0
                  ? ` · moved ${appointment.rescheduleCount} time${appointment.rescheduleCount === 1 ? '' : 's'}`
                  : ''}
              </p>
            </div>
            <p className="shrink-0 font-medium">
              {formatMoney(appointment.priceAmount, appointment.currency)}
            </p>
          </div>

          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="flex gap-2">
              <Clock aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
              <div>
                <dt className="text-fg-muted">When</dt>
                <dd className="font-medium">
                  {formatDateLong(appointment.startsAt, timezone)}
                  <br />
                  {formatTimeRange(appointment.startsAt, appointment.endsAt, timezone)}
                  <span className="block font-normal text-fg-muted">
                    {formatZoneLabel(timezone)}
                  </span>
                </dd>
              </div>
            </div>

            {appointment.staff ? (
              <div className="flex gap-2">
                <UserRound aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
                <div>
                  <dt className="text-fg-muted">With</dt>
                  <dd className="font-medium">{appointment.staff.displayName}</dd>
                </div>
              </div>
            ) : null}

            {appointment.location ? (
              <div className="flex gap-2">
                <MapPin aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
                <div>
                  <dt className="text-fg-muted">Where</dt>
                  <dd className="font-medium">
                    {appointment.location.name}
                    {appointment.location.address ? (
                      <span className="block font-normal text-fg-muted">
                        {appointment.location.address}
                      </span>
                    ) : null}
                  </dd>
                </div>
              </div>
            ) : null}

            {customerName ? (
              <div className="flex gap-2">
                <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
                <div>
                  <dt className="text-fg-muted">Booked for</dt>
                  <dd className="font-medium">{customerName}</dd>
                </div>
              </div>
            ) : null}
          </dl>

          {appointment.location?.virtualMeetingUrl ? (
            <a
              href={appointment.location.virtualMeetingUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <Video aria-hidden className="h-4 w-4" />
              Join the video call
            </a>
          ) : null}

          {appointment.customerNotes ? (
            <div className="rounded-lg bg-surface-sunken px-3 py-2 text-sm">
              <p className="text-fg-muted">Your note</p>
              <p className="whitespace-pre-line">{appointment.customerNotes}</p>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {!isTerminal && !isPast ? (
        <div className="mt-5 space-y-3">
          {mode === 'view' ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    setMode('reschedule');
                    setActionError(null);
                    setStatusMessage(null);
                  }}
                  disabled={!policy.canReschedule}
                  leadingIcon={<CalendarClock aria-hidden className="h-4 w-4" />}
                >
                  Reschedule
                </Button>
                <Button
                  variant="danger"
                  onClick={() => setCancelOpen(true)}
                  disabled={!policy.canCancel}
                  leadingIcon={<CalendarX2 aria-hidden className="h-4 w-4" />}
                >
                  Cancel
                </Button>
              </div>

              {/* A disabled button with no explanation is a dead end. */}
              {rescheduleBlocked ? (
                <p className="text-sm text-fg-muted">{rescheduleBlocked}</p>
              ) : null}
              {cancelBlocked && cancelBlocked !== rescheduleBlocked ? (
                <p className="text-sm text-fg-muted">{cancelBlocked}</p>
              ) : null}
              {policy.canReschedule && policy.remainingReschedules > 0 ? (
                <p className="text-sm text-fg-muted">
                  You can move this appointment {policy.remainingReschedules} more time
                  {policy.remainingReschedules === 1 ? '' : 's'}.
                </p>
              ) : null}
            </>
          ) : null}

          {isRescheduling ? (
            <Card>
              <CardBody className="space-y-5">
                {canShowSlots ? (
                  <>
                    <Field label="Jump to a date" className="w-full sm:w-56">
                      {(props) => (
                        <DatePicker
                          {...props}
                          value={effectiveStart}
                          timezone={timezone}
                          min={todayIso}
                          onChange={setWindowStart}
                        />
                      )}
                    </Field>

                    <SlotPicker
                      slots={availabilityQuery.data?.slots ?? []}
                      timezone={timezone}
                      isLoading={availabilityQuery.isFetching}
                      error={availabilityQuery.isError ? availabilityQuery.error : null}
                      onRetry={() => void availabilityQuery.refetch()}
                      selectedStartsAt={selectedSlot?.startsAt ?? null}
                      onSelect={setSelectedSlot}
                      fromDate={effectiveStart}
                      toDate={windowEnd}
                      onShiftWindow={(direction) =>
                        setWindowStart(
                          DateTime.fromISO(effectiveStart, { zone: timezone })
                            .plus({ days: direction * WINDOW_DAYS })
                            .toFormat('yyyy-MM-dd'),
                        )
                      }
                      canGoBack={effectiveStart > todayIso}
                      canGoForward
                      truncated={availabilityQuery.data?.truncated ?? false}
                    />
                  </>
                ) : (
                  <>
                    <p className="flex items-start gap-2 rounded-lg bg-info-subtle px-3 py-2 text-sm text-info-text">
                      <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
                      Choose when you would like to come instead. We will check it against{' '}
                      {appointment.business.name}&rsquo;s calendar and tell you straight away if it
                      is not free.
                    </p>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="New date" required>
                        {(props) => (
                          <DatePicker
                            {...props}
                            value={manualDate}
                            timezone={timezone}
                            min={todayIso}
                            onChange={setManualDate}
                          />
                        )}
                      </Field>
                      <Field label="New time" required hint={`In ${formatZoneLabel(timezone)}`}>
                        {(props) => (
                          <TimePicker {...props} value={manualTime} onChange={setManualTime} />
                        )}
                      </Field>
                    </div>
                  </>
                )}

                <p aria-live="polite" className="mf-sr-only">
                  {reschedule.isPending ? 'Moving your appointment' : ''}
                </p>

                <div className="flex items-center justify-between gap-3">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setMode('view');
                      setSelectedSlot(null);
                      setActionError(null);
                    }}
                    disabled={reschedule.isPending}
                  >
                    Keep current time
                  </Button>
                  <Button
                    onClick={() => void submitReschedule()}
                    disabled={!chosenStartsAt}
                    loading={reschedule.isPending}
                  >
                    Move appointment
                  </Button>
                </div>
              </CardBody>
            </Card>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={cancelOpen}
        onCancel={() => setCancelOpen(false)}
        onConfirm={() => void submitCancel()}
        title="Cancel this appointment?"
        confirmLabel="Cancel appointment"
        cancelLabel="Keep it"
        destructive
        loading={cancel.isPending}
        description={
          <div className="space-y-3">
            <p>
              This frees the slot for someone else and cannot be undone. {appointment.business.name}{' '}
              will be notified.
            </p>
            <Field label="Reason" hint="Optional">
              {(props) => (
                <Textarea
                  {...props}
                  rows={3}
                  value={cancelReason}
                  onChange={(event) => setCancelReason(event.target.value)}
                  placeholder="Let them know why, if you would like to."
                />
              )}
            </Field>
          </div>
        }
      />
    </PublicShell>
  );
}
