import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  CalendarClock,
  Clock,
  Info,
  Mail,
  MapPin,
  Phone,
  Receipt,
  Sparkles,
  UserRound,
  Video,
} from 'lucide-react';
import { DateTime } from 'luxon';
import { useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader } from '@/components/layout/PageHeader';
import { SlotPicker } from '@/components/scheduling/SlotPicker';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Dialog,
  ErrorState,
  Field,
  Skeleton,
  Textarea,
  useToast,
} from '@/components/ui';
import { ALLOWED_TRANSITIONS, AppointmentStatusBadge } from '@/components/owner';
import { ApiError, api } from '@/lib/apiClient';
import {
  formatDateLong,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatRelative,
  formatTime,
  formatTimeRange,
  formatZoneOffset,
  humanizeEnum,
} from '@/lib/format';
import type { PublicAppointment } from '@/types/api';
import { FormBanner } from '@/pages/auth/FormBanner';
import { customerKeys } from './api';

const BREADCRUMBS = [{ label: 'My bookings', to: '/app/my/bookings' }, { label: 'Booking' }];

/** Booking-form answers are workspace-defined, so values arrive untyped. */
function answerToText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map((entry) => answerToText(entry)).join(', ');
  return JSON.stringify(value);
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
  const { publicId = '' } = useParams<{ publicId: string }>();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveDate, setMoveDate] = useState<string | null>(null);
  const [moveSlot, setMoveSlot] = useState<string | null>(null);
  const [moveReason, setMoveReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  /*
   * Read from the public surface rather than from `/appointments/:id`.
   *
   * It is the only view that carries the customer *policy* — whether this
   * booking can still be cancelled or moved, and how many moves are left — and
   * it is the surface the matching write endpoints enforce that policy on. The
   * management endpoints deliberately skip it, because a workspace acting for a
   * customer who has just phoned in is not bound by the customer's deadline.
   */
  const bookingQuery = useQuery({
    queryKey: customerKeys.booking(publicId),
    queryFn: () => api.get<PublicAppointment>(`/public/appointments/${publicId}`),
    enabled: publicId.length > 0,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: customerKeys.booking(publicId) });
    void queryClient.invalidateQueries({ queryKey: ['customer', 'appointments'] });
  };

  const cancelMutation = useMutation({
    mutationFn: (reason: string | null) =>
      api.post<PublicAppointment>(`/public/appointments/${publicId}/cancel`, { reason }),
    onSuccess: () => {
      setCancelOpen(false);
      setCancelReason('');
      setActionError(null);
      toast({ title: 'Booking cancelled', tone: 'success' });
      invalidate();
    },
    onError: (error: unknown) => {
      setActionError(error instanceof ApiError ? error.message : 'Please try again in a moment.');
    },
  });

  const moveMutation = useMutation({
    mutationFn: (input: { startsAt: string; reason: string | null }) =>
      api.post<PublicAppointment>(`/public/appointments/${publicId}/reschedule`, input),
    onSuccess: () => {
      setMoveOpen(false);
      setMoveDate(null);
      setMoveSlot(null);
      setMoveReason('');
      setActionError(null);
      toast({ title: 'Booking moved', tone: 'success' });
      invalidate();
    },
    onError: (error: unknown) => {
      setActionError(error instanceof ApiError ? error.message : 'Please try again in a moment.');
    },
  });

  if (bookingQuery.isPending) {
    return (
      <>
        <PageHeader title="Booking" breadcrumbs={BREADCRUMBS} />
        <div className="flex flex-col gap-4" aria-hidden="true">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-48 w-full" />
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
            onRetry={() => void bookingQuery.refetch()}
            title="We could not open this booking"
          />
        </Card>
      </>
    );
  }

  const booking = bookingQuery.data;
  // The zone the booking was confirmed in — the customer's own clock.
  const zone = booking.timezone;
  const { policy, business } = booking;

  const now = DateTime.now();
  const startsAt = DateTime.fromISO(booking.startsAt);
  const cancelDeadline = startsAt.minus({ minutes: policy.cancellationDeadlineMinutes });
  const moveDeadline = startsAt.minus({ minutes: policy.rescheduleDeadlineMinutes });
  // A booking the state machine can no longer move is one nothing can be done
  // to, whatever the policy deadlines say.
  const terminal = ALLOWED_TRANSITIONS[booking.status].length === 0;
  const statusPhrase = humanizeEnum(booking.status).toLowerCase();

  /**
   * Why an action is unavailable, in the customer's own terms.
   *
   * `policy.canCancel` is a single boolean over three different reasons, so each
   * is reconstructed from facts the payload actually carries rather than shown
   * as a bare disabled button with no explanation.
   */
  const explain = (kind: 'cancel' | 'move'): string => {
    if (terminal) {
      return `This booking is ${statusPhrase}, so there is nothing left to change.`;
    }
    const deadline = kind === 'cancel' ? cancelDeadline : moveDeadline;
    if (now > deadline) {
      return `The deadline for changing this online passed on ${formatDateTime(deadline, zone)}. ${business.name} can still help.`;
    }
    if (kind === 'move' && policy.remainingReschedules === 0) {
      return `You have already moved this booking ${booking.rescheduleCount} ${
        booking.rescheduleCount === 1 ? 'time' : 'times'
      }, which is the most ${business.name} allows.`;
    }
    return `${business.name} does not take ${kind === 'cancel' ? 'cancellations' : 'changes'} online. Get in touch and they will sort it out.`;
  };

  const answers = Object.entries(booking.answers);
  const contact: ReactNode[] = [];
  if (business.supportEmail) {
    contact.push(
      <a
        key="email"
        href={`mailto:${business.supportEmail}`}
        className="rounded-xs text-brand-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {business.supportEmail}
      </a>,
    );
  }
  if (business.supportPhone) {
    contact.push(
      <a
        key="phone"
        href={`tel:${business.supportPhone}`}
        className="rounded-xs text-brand-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {business.supportPhone}
      </a>,
    );
  }

  return (
    <>
      <PageHeader
        title={booking.service?.name ?? booking.title ?? 'Your booking'}
        breadcrumbs={BREADCRUMBS}
        description={
          <>
            {formatDateLong(booking.startsAt, zone)} ·{' '}
            {formatTimeRange(booking.startsAt, booking.endsAt, zone)} (
            {formatZoneOffset(zone, booking.startsAt)}) · {formatDuration(booking.durationMinutes)}
          </>
        }
        actions={<AppointmentStatusBadge status={booking.status} />}
      />

      {actionError ? <FormBanner message={actionError} /> : null}

      {booking.status === 'CANCELLED' && booking.cancellationReason ? (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-md border border-danger-border bg-danger-subtle px-3.5 py-3 text-sm text-danger-text"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p className="leading-relaxed">Cancelled: {booking.cancellationReason}</p>
        </div>
      ) : null}

      {/* --- What you can still change ------------------------------------- */}
      <Card>
        <CardHeader
          as="h2"
          title="Changing this booking"
          description={`${business.name} sets these rules. They are shown in your own time, ${zone.replace(/_/g, ' ')}.`}
        />
        <CardBody className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
              <p className="text-sm font-semibold text-fg">Cancelling</p>
              {policy.canCancel ? (
                <p className="text-sm text-fg-secondary">
                  Free to cancel until{' '}
                  <span className="font-medium text-fg">
                    {formatDateTime(cancelDeadline, zone)}
                  </span>{' '}
                  — {formatRelative(cancelDeadline, zone)}.
                </p>
              ) : (
                <p className="text-sm text-fg-muted">{explain('cancel')}</p>
              )}
              <div className="mt-1">
                <Button
                  variant="danger"
                  size="sm"
                  disabled={!policy.canCancel}
                  leadingIcon={<Ban className="size-4" aria-hidden="true" />}
                  onClick={() => setCancelOpen(true)}
                >
                  Cancel booking
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
              <p className="text-sm font-semibold text-fg">Moving it</p>
              {policy.canReschedule ? (
                <p className="text-sm text-fg-secondary">
                  Can be moved until{' '}
                  <span className="font-medium text-fg">{formatDateTime(moveDeadline, zone)}</span>.{' '}
                  {policy.remainingReschedules} change
                  {policy.remainingReschedules === 1 ? '' : 's'} left.
                </p>
              ) : (
                <p className="text-sm text-fg-muted">{explain('move')}</p>
              )}
              <div className="mt-1">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!policy.canReschedule}
                  leadingIcon={<CalendarClock className="size-4" aria-hidden="true" />}
                  onClick={() => setMoveOpen(true)}
                >
                  Move booking
                </Button>
              </div>
            </div>
          </div>

          {contact.length > 0 ? (
            <p className="flex flex-wrap items-center gap-2 border-t border-border pt-4 text-sm text-fg-muted">
              <Phone className="size-4 shrink-0" aria-hidden="true" />
              Need something else? Contact {business.name} on{' '}
              {contact.map((node, index) => (
                <span key={index}>
                  {index > 0 ? ' or ' : ''}
                  {node}
                </span>
              ))}
              .
            </p>
          ) : null}
        </CardBody>
      </Card>

      {/* --- The booking ---------------------------------------------------- */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader as="h2" title="What you booked" />
          <CardBody>
            <dl className="flex flex-col gap-4">
              <DetailRow icon={<Sparkles className="size-4" />} label="Service">
                {booking.service?.name ?? 'Appointment'}
                {booking.service?.description ? (
                  <span className="block text-sm leading-relaxed text-fg-muted">
                    {booking.service.description}
                  </span>
                ) : null}
              </DetailRow>
              <DetailRow icon={<Clock className="size-4" />} label="When">
                {formatDateLong(booking.startsAt, zone)},{' '}
                {formatTimeRange(booking.startsAt, booking.endsAt, zone)}
                {!terminal ? (
                  <span className="block text-sm text-fg-muted">
                    {formatRelative(booking.startsAt, zone)}
                  </span>
                ) : null}
              </DetailRow>
              {booking.staff ? (
                <DetailRow icon={<UserRound className="size-4" />} label="With">
                  {booking.staff.displayName}
                </DetailRow>
              ) : null}
              {booking.location ? (
                <DetailRow icon={<MapPin className="size-4" />} label="Where">
                  {booking.location.name}
                  {booking.location.address ? (
                    <span className="block text-sm text-fg-muted">{booking.location.address}</span>
                  ) : null}
                  {booking.location.timezone !== zone ? (
                    <span className="block text-sm text-fg-muted">
                      Local time there: {formatTime(booking.startsAt, booking.location.timezone)}
                    </span>
                  ) : null}
                </DetailRow>
              ) : null}
              {booking.location?.virtualMeetingUrl ? (
                <DetailRow icon={<Video className="size-4" />} label="Join">
                  <a
                    href={booking.location.virtualMeetingUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="rounded-xs break-all text-brand-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  >
                    {booking.location.virtualMeetingUrl}
                  </a>
                </DetailRow>
              ) : null}
              <DetailRow icon={<Receipt className="size-4" />} label="Price">
                {booking.priceAmount > 0
                  ? formatMoney(booking.priceAmount, booking.currency)
                  : 'No charge'}
              </DetailRow>
              <DetailRow icon={<CalendarClock className="size-4" />} label="Reference">
                <span className="font-mono text-xs">{booking.publicId}</span>
              </DetailRow>
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader as="h2" title="What you told them" />
          <CardBody className="flex flex-col gap-4">
            {booking.customerNotes ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg-secondary">
                {booking.customerNotes}
              </p>
            ) : null}

            {answers.length > 0 ? (
              <dl className="flex flex-col gap-2">
                {answers.map(([key, value]) => (
                  <div key={key} className="flex flex-wrap items-baseline gap-x-2">
                    <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                      {humanizeEnum(key.replace(/([a-z])([A-Z])/g, '$1_$2'))}
                    </dt>
                    <dd className="text-sm text-fg-secondary">{answerToText(value)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}

            {!booking.customerNotes && answers.length === 0 ? (
              <p className="text-sm text-fg-muted">
                You did not add any notes when you booked. Contact {business.name} if there is
                something they should know.
              </p>
            ) : null}

            {booking.confirmedAt ? (
              <p className="border-t border-border pt-4 text-xs text-fg-muted">
                Confirmed {formatDateTime(booking.confirmedAt, zone)}.
              </p>
            ) : booking.requiresApproval ? (
              <p className="flex items-start gap-2 border-t border-border pt-4 text-xs leading-relaxed text-fg-muted">
                <Mail className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {business.name} is still reviewing this request. You will hear from them once it is
                confirmed.
              </p>
            ) : null}
          </CardBody>
        </Card>
      </div>

      {/* --- Cancel ---------------------------------------------------------- */}
      <Dialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancel this booking?"
        description={`Your appointment with ${business.name} on ${formatDateLong(booking.startsAt, zone)} will be released. This cannot be undone.`}
        width="sm"
        dismissOnBackdrop={!cancelMutation.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setCancelOpen(false)}
              disabled={cancelMutation.isPending}
            >
              Keep my booking
            </Button>
            <Button
              variant="danger"
              loading={cancelMutation.isPending}
              onClick={() =>
                cancelMutation.mutate(cancelReason.trim().length > 0 ? cancelReason.trim() : null)
              }
            >
              Cancel booking
            </Button>
          </>
        }
      >
        <Field label="Reason" hint="Shared with the business. Optional.">
          {(fieldProps) => (
            <Textarea
              {...fieldProps}
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Anything they should know?"
            />
          )}
        </Field>
      </Dialog>

      {/* --- Move ------------------------------------------------------------ */}
      <Dialog
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
        title="Move this booking"
        description={`Currently ${formatDateLong(booking.startsAt, zone)} at ${formatTime(booking.startsAt, zone)}.`}
        width="lg"
        dismissOnBackdrop={false}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setMoveOpen(false)}
              disabled={moveMutation.isPending}
            >
              Keep the current time
            </Button>
            <Button
              loading={moveMutation.isPending}
              disabled={moveSlot === null}
              onClick={() => {
                if (moveSlot === null) return;
                moveMutation.mutate({
                  startsAt: moveSlot,
                  reason: moveReason.trim().length > 0 ? moveReason.trim() : null,
                });
              }}
            >
              Move booking
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {booking.service && booking.staff ? (
            <SlotPicker
              serviceId={booking.service.id}
              staffProfileId={booking.staff.id}
              timezone={zone}
              date={moveDate}
              onDateChange={(next) => {
                setMoveDate(next);
                setMoveSlot(null);
              }}
              value={moveSlot}
              onChange={setMoveSlot}
              currentStartsAt={booking.startsAt}
              disabled={moveMutation.isPending}
            />
          ) : (
            <p className="text-sm text-fg-muted">
              This booking has no service or provider attached, so there are no times to search.
              Contact {business.name} to move it.
            </p>
          )}

          <Field label="Reason" hint="Shared with the business. Optional.">
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                value={moveReason}
                onChange={(event) => setMoveReason(event.target.value)}
                rows={2}
                maxLength={500}
              />
            )}
          </Field>

          <p className="text-xs text-fg-muted">
            You have {policy.remainingReschedules} change
            {policy.remainingReschedules === 1 ? '' : 's'} left on this booking.
          </p>
        </div>
      </Dialog>
    </>
  );
}
