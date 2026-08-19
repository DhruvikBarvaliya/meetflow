/**
 * One booking, as the person who made it sees it.
 *
 * Reads `GET /me/bookings/:publicId`, which answers with the same view the
 * anonymous manage page gets. That is deliberate on the server's side and worth
 * relying on here: it is the only shape that carries the customer *policy* —
 * whether this booking may still be moved or cancelled, and how many moves are
 * left. The management endpoints omit it, because a workspace acting on a
 * customer's phone call is not bound by the customer's own deadline, and a page
 * built on those would offer buttons the write endpoints then refuse.
 *
 * Being signed in buys one thing over the emailed `apt_…` link: the change is
 * attributable to an account rather than to whoever was holding a URL. It buys
 * no extra authority. The scope is still "bookings belonging to this person's
 * customer records", enforced inside the WHERE clause, so a handle belonging to
 * somebody else and a handle belonging to nobody produce the same 404.
 *
 * **Rescheduling asks for a time in the venue's clock, not the reader's.** When
 * somebody says they would like to come at ten, they mean ten where the
 * appointment happens. The field says which zone it is reading, and where the
 * reader's own clock differs the equivalent is shown underneath — silently
 * converting one into the other is how a customer books 3:30am.
 *
 * There is no slot grid here, and that is a property of the API rather than an
 * omission: availability is published per *booking link*, and an appointment
 * does not record the link it was booked through. The person names a time and
 * the server rules on it against live data, which is the same check a slot grid
 * would only have been predicting.
 */
import { DateTime } from 'luxon';
import {
  CalendarClock,
  CalendarX2,
  CheckCircle2,
  Clock,
  Info,
  Mail,
  MapPin,
  Phone,
  UserRound,
  Video,
} from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader } from '@/components/layout/PageHeader';
import { AppointmentStatusBadge } from '@/components/owner/StatusBadge';
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
import { isApiError } from '@/lib/apiClient';
import {
  browserTimezone,
  canonicalTimezone,
  formatDateLong,
  formatDuration,
  formatMoney,
  formatRelative,
  formatTimeRange,
  formatZoneLabel,
} from '@/lib/format';
import { useCancelPortalBooking, usePortalBooking, useReschedulePortalBooking } from './portalApi';

const BREADCRUMBS = [{ label: 'Your bookings', to: '/portal/bookings' }, { label: 'Booking' }];

/** Statuses after which nothing can be changed by anyone. */
const TERMINAL_STATUSES = ['CANCELLED', 'COMPLETED', 'NO_SHOW', 'REJECTED'];

export default function AppointmentDetailPage(): JSX.Element {
  const { publicId = '' } = useParams<{ publicId: string }>();

  const bookingQuery = usePortalBooking(publicId);
  const reschedule = useReschedulePortalBooking(publicId);
  const cancel = useCancelPortalBooking(publicId);

  const [mode, setMode] = useState<'view' | 'reschedule'>('view');
  const [newDate, setNewDate] = useState<string | null>(null);
  const [newTime, setNewTime] = useState<string | null>(null);
  const [moveReason, setMoveReason] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  if (bookingQuery.isPending) {
    return (
      <>
        <PageHeader title="Booking" breadcrumbs={BREADCRUMBS} />
        <div className="flex flex-col gap-4" aria-hidden="true">
          <Skeleton className="h-28 w-full rounded-lg" />
          <Skeleton className="h-48 w-full rounded-lg" />
        </div>
      </>
    );
  }

  if (bookingQuery.isError || !bookingQuery.data) {
    return (
      <>
        <PageHeader title="Booking" breadcrumbs={BREADCRUMBS} />
        <Card>
          <ErrorState
            error={bookingQuery.error}
            title="We could not open this booking"
            onRetry={() => void bookingQuery.refetch()}
          />
        </Card>
      </>
    );
  }

  const booking = bookingQuery.data;
  const { policy, business } = booking;

  // The clock the appointment happens on, and the one the reader is in.
  const venueZone = canonicalTimezone(booking.timezone);
  // `browserTimezone` canonicalises on the way out, so both sides of the
  // comparison below are in the same vocabulary.
  const viewerZone = browserTimezone();
  const zonesDiffer = venueZone !== viewerZone;

  const startsAt = DateTime.fromISO(booking.startsAt);
  const isPast = startsAt < DateTime.now();
  const isTerminal = TERMINAL_STATUSES.includes(booking.status);
  const noticeMinutes = startsAt.diff(DateTime.now(), 'minutes').minutes;

  /**
   * Why an action is closed, in the reader's terms.
   *
   * `canCancel` and `canReschedule` are single booleans over several different
   * rules, so the specific one is reconstructed from the deadlines and counts
   * the payload does carry. A disabled button with no explanation is a dead end,
   * and the reader would have no way to tell "too late" from "not offered here".
   */
  function blockedReason(kind: 'reschedule' | 'cancel'): string | null {
    const allowed = kind === 'cancel' ? policy.canCancel : policy.canReschedule;
    if (allowed) return null;
    if (isTerminal) return `This booking is ${booking.status.toLowerCase()}.`;
    if (isPast) return 'This appointment has already passed.';

    if (kind === 'reschedule' && policy.remainingReschedules <= 0) {
      return `This booking has already been moved the maximum number of times. Contact ${business.name} if you still need to change it.`;
    }

    const deadline =
      kind === 'cancel' ? policy.cancellationDeadlineMinutes : policy.rescheduleDeadlineMinutes;
    if (noticeMinutes < deadline) {
      const verb = kind === 'cancel' ? 'cancelled' : 'moved';
      return `Bookings can only be ${verb} online more than ${formatDuration(deadline)} in advance. Contact ${business.name}.`;
    }

    const verb = kind === 'cancel' ? 'Cancelling' : 'Rescheduling';
    return `${verb} online is not offered for this booking. Contact ${business.name}.`;
  }

  const rescheduleBlocked = blockedReason('reschedule');
  const cancelBlocked = blockedReason('cancel');

  /**
   * The instant the reader has settled on.
   *
   * Built in the venue's zone, which is what the field says it is reading. Null
   * until both halves are chosen, so the submit button has something honest to
   * be disabled by.
   */
  const chosenStartsAt =
    newDate && newTime
      ? (DateTime.fromISO(`${newDate}T${newTime}`, { zone: venueZone }).toISO() ?? null)
      : null;

  const todayAtVenue = DateTime.now().setZone(venueZone).toFormat('yyyy-MM-dd');

  function leaveRescheduleMode(): void {
    setMode('view');
    setNewDate(null);
    setNewTime(null);
    setMoveReason('');
  }

  async function submitReschedule(): Promise<void> {
    if (!chosenStartsAt) return;
    setActionError(null);
    setStatusMessage(null);
    try {
      await reschedule.mutateAsync({
        startsAt: chosenStartsAt,
        ...(moveReason.trim() ? { reason: moveReason.trim() } : {}),
      });
      leaveRescheduleMode();
      setStatusMessage('Your booking has been moved. A new confirmation is on its way.');
    } catch (error) {
      setActionError(
        isApiError(error) ? error.message : 'We could not move your booking. Please try again.',
      );
    }
  }

  async function submitCancel(): Promise<void> {
    setActionError(null);
    setStatusMessage(null);
    try {
      await cancel.mutateAsync(cancelReason.trim() ? { reason: cancelReason.trim() } : {});
      setCancelOpen(false);
      setCancelReason('');
      setStatusMessage('Your booking has been cancelled.');
    } catch (error) {
      setCancelOpen(false);
      setActionError(
        isApiError(error) ? error.message : 'We could not cancel your booking. Please try again.',
      );
    }
  }

  return (
    <>
      <PageHeader
        title={booking.service?.name ?? booking.title ?? 'Booking'}
        breadcrumbs={BREADCRUMBS}
        description={`With ${business.name}`}
        actions={<AppointmentStatusBadge status={booking.status} />}
      />

      {/* One element, both seen and announced: `role="status"` is an implicit
          polite live region, so a visually-hidden copy would be read twice. */}
      {statusMessage ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-success-border bg-success-subtle px-3 py-2 text-sm text-success-text"
        >
          <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0" />
          {statusMessage}
        </div>
      ) : null}

      {actionError ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger-text"
        >
          {actionError}
        </div>
      ) : null}

      {booking.status === 'CANCELLED' ? (
        <div className="flex items-start gap-2 rounded-lg bg-surface-sunken px-3 py-2 text-sm text-fg-secondary">
          <CalendarX2 aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            This booking was cancelled
            {booking.cancelledAt ? ` ${formatRelative(booking.cancelledAt, viewerZone)}` : ''}.
            {booking.cancellationReason ? ` Reason: ${booking.cancellationReason}` : ''}
          </span>
        </div>
      ) : null}

      {booking.requiresApproval && booking.status === 'PENDING' ? (
        <div className="flex items-start gap-2 rounded-lg bg-info-subtle px-3 py-2 text-sm text-info-text">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          {business.name} has not confirmed this request yet. You will be emailed when they do.
        </div>
      ) : null}

      <Card>
        <CardBody className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <p className="text-sm text-fg-muted">
              {formatDuration(booking.durationMinutes)}
              {booking.rescheduleCount > 0
                ? ` · moved ${booking.rescheduleCount} time${booking.rescheduleCount === 1 ? '' : 's'}`
                : ''}
            </p>
            <p className="shrink-0 font-medium">
              {formatMoney(booking.priceAmount, booking.currency)}
            </p>
          </div>

          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="flex gap-2">
              <Clock aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-muted" />
              <div>
                <dt className="text-fg-muted">When</dt>
                <dd className="font-medium">
                  {formatDateLong(booking.startsAt, viewerZone)}
                  <br />
                  {formatTimeRange(booking.startsAt, booking.endsAt, viewerZone)}
                  <span className="block font-normal text-fg-muted">
                    {formatZoneLabel(viewerZone)}
                  </span>
                  {/* Both clocks, never one silently standing in for the other. */}
                  {zonesDiffer ? (
                    <span className="mt-1 block font-normal text-fg-muted">
                      {formatTimeRange(booking.startsAt, booking.endsAt, venueZone)} where it
                      happens — {formatZoneLabel(venueZone)}
                    </span>
                  ) : null}
                </dd>
              </div>
            </div>

            {booking.staff ? (
              <div className="flex gap-2">
                <UserRound aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-muted" />
                <div>
                  <dt className="text-fg-muted">With</dt>
                  <dd className="font-medium">{booking.staff.displayName}</dd>
                </div>
              </div>
            ) : null}

            {booking.location ? (
              <div className="flex gap-2">
                <MapPin aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-muted" />
                <div>
                  <dt className="text-fg-muted">Where</dt>
                  <dd className="font-medium">
                    {booking.location.name}
                    {booking.location.address ? (
                      <span className="block font-normal text-fg-muted">
                        {booking.location.address}
                      </span>
                    ) : null}
                  </dd>
                </div>
              </div>
            ) : null}

            <div className="flex gap-2">
              <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-muted" />
              <div>
                <dt className="text-fg-muted">Reference</dt>
                <dd className="font-medium tabular-nums">{booking.publicId}</dd>
              </div>
            </div>
          </dl>

          {booking.location?.virtualMeetingUrl ? (
            <a
              href={booking.location.virtualMeetingUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <Video aria-hidden className="size-4" />
              Join the video call
            </a>
          ) : null}

          {booking.customerNotes ? (
            <div className="rounded-lg bg-surface-sunken px-3 py-2 text-sm">
              <p className="text-fg-muted">Your note</p>
              <p className="whitespace-pre-line">{booking.customerNotes}</p>
            </div>
          ) : null}

          {business.supportEmail || business.supportPhone ? (
            <div className="flex flex-wrap items-center gap-4 border-t border-border pt-3 text-sm">
              <span className="text-fg-muted">Contact {business.name}</span>
              {business.supportEmail ? (
                <a
                  href={`mailto:${business.supportEmail}`}
                  className="inline-flex items-center gap-1.5 rounded-xs font-medium text-brand-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  <Mail aria-hidden className="size-4" />
                  {business.supportEmail}
                </a>
              ) : null}
              {business.supportPhone ? (
                <a
                  href={`tel:${business.supportPhone}`}
                  className="inline-flex items-center gap-1.5 rounded-xs font-medium text-brand-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  <Phone aria-hidden className="size-4" />
                  {business.supportPhone}
                </a>
              ) : null}
            </div>
          ) : null}
        </CardBody>
      </Card>

      {!isTerminal && !isPast ? (
        <div className="flex flex-col gap-3">
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
                  leadingIcon={<CalendarClock aria-hidden className="size-4" />}
                >
                  Move this booking
                </Button>
                <Button
                  variant="danger"
                  onClick={() => setCancelOpen(true)}
                  disabled={!policy.canCancel}
                  leadingIcon={<CalendarX2 aria-hidden className="size-4" />}
                >
                  Cancel
                </Button>
              </div>

              {rescheduleBlocked ? (
                <p className="text-sm text-fg-muted">{rescheduleBlocked}</p>
              ) : null}
              {cancelBlocked && cancelBlocked !== rescheduleBlocked ? (
                <p className="text-sm text-fg-muted">{cancelBlocked}</p>
              ) : null}
              {policy.canReschedule && policy.remainingReschedules > 0 ? (
                <p className="text-sm text-fg-muted">
                  You can move this booking {policy.remainingReschedules} more time
                  {policy.remainingReschedules === 1 ? '' : 's'}.
                </p>
              ) : null}
            </>
          ) : (
            <Card>
              <CardBody className="space-y-5">
                <p className="flex items-start gap-2 rounded-lg bg-info-subtle px-3 py-2 text-sm text-info-text">
                  <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
                  Choose when you would like to come instead. We will check it against{' '}
                  {business.name}&rsquo;s calendar and tell you straight away if it is not free.
                </p>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="New date" required>
                    {(props) => (
                      <DatePicker
                        {...props}
                        value={newDate}
                        // The venue's clock, so "today" is today where the
                        // appointment happens rather than where the reader is.
                        timezone={venueZone}
                        min={todayAtVenue}
                        onChange={setNewDate}
                      />
                    )}
                  </Field>
                  <Field
                    label="New time"
                    required
                    hint={`Read as ${formatZoneLabel(venueZone)} — the clock ${business.name} works to.`}
                  >
                    {(props) => <TimePicker {...props} value={newTime} onChange={setNewTime} />}
                  </Field>
                </div>

                {/* The same instant in the reader's own clock, so a cross-zone
                    booking cannot be made by accident. Rendered only once both
                    halves are chosen — there is nothing to convert before that. */}
                {chosenStartsAt && zonesDiffer ? (
                  <p className="text-sm text-fg-secondary">
                    That is{' '}
                    <span className="font-medium">
                      {formatDateLong(chosenStartsAt, viewerZone)},{' '}
                      {DateTime.fromISO(chosenStartsAt).setZone(viewerZone).toFormat('h:mm a')}
                    </span>{' '}
                    in your own time zone.
                  </p>
                ) : null}

                <Field label="Reason" hint="Optional. Shared with the business.">
                  {(props) => (
                    <Textarea
                      {...props}
                      rows={2}
                      value={moveReason}
                      onChange={(event) => setMoveReason(event.target.value)}
                      placeholder="Let them know why, if you would like to."
                    />
                  )}
                </Field>

                <p aria-live="polite" className="mf-sr-only">
                  {reschedule.isPending ? 'Moving your booking' : ''}
                </p>

                <div className="flex items-center justify-between gap-3">
                  <Button
                    variant="ghost"
                    onClick={leaveRescheduleMode}
                    disabled={reschedule.isPending}
                  >
                    Keep the current time
                  </Button>
                  <Button
                    onClick={() => void submitReschedule()}
                    disabled={!chosenStartsAt}
                    loading={reschedule.isPending}
                  >
                    Move booking
                  </Button>
                </div>
              </CardBody>
            </Card>
          )}
        </div>
      ) : null}

      <ConfirmDialog
        open={cancelOpen}
        onCancel={() => setCancelOpen(false)}
        onConfirm={() => void submitCancel()}
        title="Cancel this booking?"
        confirmLabel="Cancel booking"
        cancelLabel="Keep it"
        destructive
        loading={cancel.isPending}
        description={
          <div className="space-y-3">
            <p>
              This frees the slot for somebody else and cannot be undone. {business.name} will be
              notified, and you would have to book again from the start.
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
    </>
  );
}
