/**
 * The page at the other end of a waitlist offer email.
 *
 * `waitlist.links.ts` mints the address as `${PUBLIC_APP_URL}/waitlist/{wlt_…}`
 * and `waitlist.matcher.ts` puts it in every offer it sends, so this component
 * must be mounted at `/waitlist/:publicId`. Until it existed the link rendered
 * the not-found page: somebody was told a slot had come free, followed the
 * link, found nothing, and the hold lapsed while they waited.
 *
 * Unauthenticated, like the rest of `pages/public`. The `wlt_…` handle is the
 * whole credential, exactly as `apt_…` is on the manage page, which is why
 * `GET /public/waitlist/:publicId` publishes a given name and no contact
 * details — a forwarded offer must not hand on somebody's email address.
 *
 * **The two ordinary failures are the point of the design.** A hold that lapsed
 * and an opening somebody else took are not errors; they are the normal
 * outcomes of a queue, and a page that renders them as red failures tells the
 * reader they did something wrong. Both states here say what happened, say that
 * the person is still on the list, and give them somewhere to go. The server
 * helps: `assertClaimable` distinguishes four refusals rather than answering one
 * flat conflict, and each maps to its own panel below.
 *
 * Opening this page never claims anything — the read is a GET and the claim is
 * a POST behind a button. That split is what makes the address safe to put in
 * an email, where corporate link scanners prefetch every URL they see.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import {
  CalendarClock,
  CalendarPlus,
  CheckCircle2,
  Clock,
  Hourglass,
  Mail,
  MapPin,
  Phone,
  UserRound,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Button, Card, CardBody, ErrorState, Skeleton, buttonStyles } from '@/components/ui';
import { cn } from '@/lib/cn';
import { api, isApiError, type ApiError } from '@/lib/apiClient';
import {
  browserTimezone,
  formatDateLong,
  formatDuration,
  formatMinuteOfDay,
  formatRelative,
  formatTimeRange,
  formatZoneLabel,
} from '@/lib/format';
import type { PublicAppointment, WaitlistStatus } from '@/types/api';
import { PublicShell } from './PublicShell';

// ---------------------------------------------------------------------------
// The response shapes
// ---------------------------------------------------------------------------
//
// Declared here rather than in `@/types/api` because that file is the shared
// contract and these two shapes have exactly one consumer. If a second surface
// ever reads an offer, they belong there instead — they are copied from
// `PublicWaitlistView` and `PublicWaitlistClaim` in
// server/src/modules/waitlist/publicWaitlist.service.ts, with `Date` replaced by
// the ISO strings JSON actually carries.

/** The opening being held, when there is one. */
interface WaitlistOffer {
  startsAt: string;
  /**
   * The service's own duration. The provider is only settled at the moment of
   * claiming, so a per-provider override cannot be known yet.
   */
  durationMinutes: number;
  holdExpiresAt: string;
  /** The server's own verdict on the clock, not one computed here. */
  expired: boolean;
}

interface WaitlistOfferView {
  publicId: string;
  status: WaitlistStatus;
  /** True exactly when the claim endpoint would accept. */
  claimable: boolean;
  offer: WaitlistOffer | null;
  timezone: string;
  window: {
    earliestDate: string;
    latestDate: string;
    earliestMinute: number;
    latestMinute: number;
    /** Sunday = 0 … Saturday = 6. Empty means any weekday will do. */
    daysOfWeek: number[];
  };
  service: { name: string; description: string | null; durationMinutes: number } | null;
  staffName: string | null;
  business: {
    name: string;
    logoUrl: string | null;
    timezone: string;
    supportEmail: string | null;
    supportPhone: string | null;
  };
  customer: { firstName: string; lastName: string | null } | null;
  appointment: PublicAppointment | null;
  offerUrl: string;
}

interface WaitlistClaimResult {
  waitlist: WaitlistOfferView;
  appointment: PublicAppointment;
}

// ---------------------------------------------------------------------------
// Claim outcomes
// ---------------------------------------------------------------------------

/**
 * A refused claim, sorted into the situations the reader is actually in.
 *
 * The server sends a distinct error code for each, which is the only reason
 * this page can tell them apart — a single flat conflict would leave all of
 * them reading the same shrug.
 */
type ClaimRefusal =
  /** Somebody else — or an earlier click of this button — got there first. */
  | { kind: 'taken'; appointmentPublicId: string | null }
  /** The hold ran out. The server has already put the entry back on the list. */
  | { kind: 'lapsed' }
  /** The slot itself went in the seconds between the page loading and the click. */
  | { kind: 'slotGone' }
  /** Withdrawn, expired, or never offered anything. The server's words are best here. */
  | { kind: 'closed'; message: string }
  | { kind: 'other'; message: string };

function toRefusal(error: unknown): ClaimRefusal {
  if (!isApiError(error)) {
    return { kind: 'other', message: 'We could not reach MeetFlow. Please try again.' };
  }

  const apiError: ApiError = error;
  const handle = apiError.meta?.appointmentPublicId;

  switch (apiError.code) {
    case 'ALREADY_EXISTS':
      return {
        kind: 'taken',
        appointmentPublicId: typeof handle === 'string' ? handle : null,
      };
    case 'BOOKING_WINDOW_CLOSED':
      return { kind: 'lapsed' };
    case 'SLOT_UNAVAILABLE':
    case 'CAPACITY_EXCEEDED':
    case 'RESOURCE_UNAVAILABLE':
      return { kind: 'slotGone' };
    case 'INVALID_STATE_TRANSITION':
    case 'CONFLICT':
      return { kind: 'closed', message: apiError.message };
    default:
      return { kind: 'other', message: apiError.message };
  }
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** Sunday-first, matching the server's `daysOfWeek` numbering. */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function Notice({
  tone,
  icon,
  title,
  children,
}: {
  tone: 'success' | 'info' | 'warning';
  icon: JSX.Element;
  title: string;
  children: ReactNode;
}): JSX.Element {
  const surfaces = {
    success: 'border-success-border bg-success-subtle text-success-text',
    info: 'border-info-border bg-info-subtle text-info-text',
    warning: 'border-warning-border bg-warning-subtle text-warning-text',
  } as const;

  return (
    // `role="status"` rather than `alert`: none of these is an error, and an
    // assertive announcement would frame an ordinary queue outcome as a fault.
    <div role="status" className={cn('flex gap-3 rounded-lg border px-4 py-3', surfaces[tone])}>
      <span className="mt-0.5 shrink-0" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0 space-y-1 text-sm leading-relaxed">
        <p className="font-medium">{title}</p>
        {children}
      </div>
    </div>
  );
}

/**
 * Where somebody goes next when the opening is gone.
 *
 * A link to the workspace's booking page would be the ideal answer, and the
 * offer deliberately does not carry one: an entry records the service and the
 * window, never the booking link it arrived through, so there is no slug to
 * build `/b/:slug` from. `?link=` is honoured when a caller supplies one, and
 * otherwise the page offers the workspace's own contact details rather than
 * inventing an address that would 404.
 */
function NextSteps({
  business,
  slug,
}: {
  business: WaitlistOfferView['business'];
  slug: string | null;
}): JSX.Element | null {
  const hasContact = business.supportEmail !== null || business.supportPhone !== null;
  if (slug === null && !hasContact) return null;

  return (
    <div className="flex flex-wrap items-center gap-3">
      {slug !== null ? (
        <Link to={`/b/${slug}`} className={buttonStyles('primary', 'md')}>
          <CalendarPlus aria-hidden className="h-4 w-4" />
          Choose another time
        </Link>
      ) : null}
      {business.supportEmail ? (
        <a
          href={`mailto:${business.supportEmail}`}
          className="inline-flex items-center gap-2 rounded-md text-sm font-medium text-brand-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <Mail aria-hidden className="h-4 w-4" />
          {business.supportEmail}
        </a>
      ) : null}
      {business.supportPhone ? (
        <a
          href={`tel:${business.supportPhone}`}
          className="inline-flex items-center gap-2 rounded-md text-sm font-medium text-brand-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <Phone aria-hidden className="h-4 w-4" />
          {business.supportPhone}
        </a>
      ) : null}
    </div>
  );
}

/** What the person originally asked for — shown when nothing is being held. */
function RequestedWindow({
  entry,
  timezone,
}: {
  entry: WaitlistOfferView;
  timezone: string;
}): JSX.Element {
  const { window: asked } = entry;
  const days =
    asked.daysOfWeek.length === 0
      ? 'any day'
      : asked.daysOfWeek
          .map((day) => DAY_NAMES[day] ?? '')
          .filter((name) => name !== '')
          .join(', ');

  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-fg-muted">What you asked for</dt>
        <dd className="font-medium">{entry.service?.name ?? 'An appointment'}</dd>
      </div>
      <div>
        <dt className="text-fg-muted">Between</dt>
        <dd className="font-medium">
          {formatDateLong(asked.earliestDate, timezone)} and{' '}
          {formatDateLong(asked.latestDate, timezone)}
        </dd>
      </div>
      <div>
        <dt className="text-fg-muted">On</dt>
        <dd className="font-medium">{days}</dd>
      </div>
      <div>
        <dt className="text-fg-muted">Time of day</dt>
        {/* Read in the zone the entry was stored with, not the viewer's: the
            window is a rule about local mornings and afternoons, and converting
            it would turn "weekday afternoons" into something the person never
            asked for. */}
        <dd className="font-medium">
          {formatMinuteOfDay(asked.earliestMinute)} to {formatMinuteOfDay(asked.latestMinute)}{' '}
          <span className="font-normal text-fg-muted">({formatZoneLabel(entry.timezone)})</span>
        </dd>
      </div>
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ClaimWaitlistPage(): JSX.Element {
  const { publicId = '' } = useParams<{ publicId: string }>();
  const [searchParams] = useSearchParams();
  const slug = searchParams.get('link');

  const [timezone, setTimezone] = useState(browserTimezone);
  const [refusal, setRefusal] = useState<ClaimRefusal | null>(null);
  const [claimed, setClaimed] = useState<PublicAppointment | null>(null);

  const offerQuery = useQuery({
    queryKey: ['public', 'waitlist', publicId],
    queryFn: () =>
      api.get<WaitlistOfferView>(`/public/waitlist/${encodeURIComponent(publicId)}`, {
        anonymous: true,
      }),
    enabled: publicId.length > 0,
    // A stale offer is the failure mode this endpoint has: somebody opens the
    // email, makes a cup of tea, and comes back to a button that will 409. The
    // hold's expiry is the server's judgement, so the page asks it again rather
    // than running a clock of its own.
    refetchInterval: (query) => (query.state.data?.claimable === true ? 60_000 : false),
    refetchOnWindowFocus: true,
    retry: false,
  });

  const claim = useMutation<WaitlistClaimResult, unknown, void>({
    mutationFn: () =>
      api.post<WaitlistClaimResult>(
        `/public/waitlist/${encodeURIComponent(publicId)}/claim`,
        {},
        { anonymous: true },
      ),
    // Losing a race is the expected outcome here, not a transport fault — an
    // automatic retry would only lose it again, more slowly.
    retry: false,
    onSuccess: (result) => {
      setRefusal(null);
      setClaimed(result.appointment);
    },
    onError: (error) => {
      setRefusal(toRefusal(error));
      // Whatever the refusal was, the entry has moved on. Re-reading it is what
      // replaces the offer card with the state the person is actually in.
      void offerQuery.refetch();
    },
  });

  if (offerQuery.isLoading) {
    return (
      <PublicShell business={null}>
        <Skeleton className="mb-4 h-8 w-64" />
        <Skeleton className="h-56 w-full rounded-xl" />
      </PublicShell>
    );
  }

  if (offerQuery.isError || !offerQuery.data) {
    return (
      <PublicShell business={null}>
        <ErrorState
          error={offerQuery.error}
          title="We could not find that offer"
          onRetry={() => void offerQuery.refetch()}
        />
      </PublicShell>
    );
  }

  const entry = offerQuery.data;
  const { business, offer } = entry;

  /*
   * The end of the offered slot.
   *
   * Derived rather than read: an offer is not an appointment yet, so it carries
   * a start and the service's duration and nothing else. The arithmetic is done
   * on the instant, then rendered in whichever zone the reader has chosen, so a
   * daylight-saving boundary inside the appointment cannot shift its length.
   */
  const offerEndsAt =
    offer === null
      ? null
      : (DateTime.fromISO(offer.startsAt).plus({ minutes: offer.durationMinutes }).toISO() ?? null);

  // The appointment this entry produced: from the claim that just succeeded, or
  // from the entry itself when it was claimed on an earlier visit.
  const booking = claimed ?? entry.appointment;
  const isBooked = entry.status === 'CONVERTED' || claimed !== null;
  const live = offer !== null && !offer.expired && entry.claimable && !isBooked;

  /*
   * The heading is the first thing read and has to be true of the state below
   * it. "An appointment has come free" over a panel saying nothing is being held
   * would be the page's own worst sentence, so it is chosen from the same three
   * conditions the panels are.
   */
  const heading = isBooked
    ? 'Your appointment is booked'
    : live
      ? 'An appointment has come free'
      : 'Your waitlist request';

  return (
    <PublicShell business={business} timezone={timezone} onTimezoneChange={setTimezone}>
      <h1 className="mb-5 text-xl font-semibold tracking-tight sm:text-2xl">{heading}</h1>

      {/* A failure the server did not describe as one of the four queue outcomes
          — a network fault, a rate limit — sits above every branch rather than
          inside one, so it cannot be lost when the refetch moves the page into a
          different state. */}
      {refusal?.kind === 'other' ? (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger-text"
        >
          {refusal.message}
        </p>
      ) : null}

      {/* --- Booked ------------------------------------------------------- */}
      {isBooked ? (
        <div className="space-y-4">
          <Notice
            tone="success"
            icon={<CheckCircle2 className="h-4 w-4" />}
            title={claimed ? 'That slot is yours' : 'This offer has already been claimed'}
          >
            <p>
              {claimed
                ? `${business.name} has your booking and a confirmation is on its way to you.`
                : 'Nothing more is needed here. The booking below is the one this offer became.'}
            </p>
          </Notice>

          {booking ? (
            <Card>
              <CardBody className="space-y-4">
                <div>
                  <p className="text-lg font-medium">
                    {booking.service?.name ?? booking.title ?? 'Appointment'}
                  </p>
                  <p className="text-sm text-fg-muted">{formatDuration(booking.durationMinutes)}</p>
                </div>

                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div className="flex gap-2">
                    <Clock aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
                    <div>
                      <dt className="text-fg-muted">When</dt>
                      <dd className="font-medium">
                        {formatDateLong(booking.startsAt, timezone)}
                        <br />
                        {formatTimeRange(booking.startsAt, booking.endsAt, timezone)}
                      </dd>
                    </div>
                  </div>

                  {booking.staff ? (
                    <div className="flex gap-2">
                      <UserRound aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
                      <div>
                        <dt className="text-fg-muted">With</dt>
                        <dd className="font-medium">{booking.staff.displayName}</dd>
                      </div>
                    </div>
                  ) : null}

                  {booking.location ? (
                    <div className="flex gap-2">
                      <MapPin aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
                      <div>
                        <dt className="text-fg-muted">Where</dt>
                        <dd className="font-medium">{booking.location.name}</dd>
                      </div>
                    </div>
                  ) : null}
                </dl>

                <Link
                  to={`/appointments/${booking.publicId}`}
                  className={buttonStyles('primary', 'md')}
                >
                  Open your booking
                </Link>
              </CardBody>
            </Card>
          ) : (
            // The entry says CONVERTED but the appointment it points at is not
            // readable — a workspace that deleted it, most likely. Saying so is
            // better than an empty card the reader will assume is still loading.
            <p className="text-sm text-fg-muted">
              We cannot show the booking itself from here. {business.name} can confirm the details.
            </p>
          )}
        </div>
      ) : null}

      {/* --- A live offer -------------------------------------------------- */}
      {live && offer ? (
        <div className="space-y-4">
          <Card>
            <CardBody className="space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-lg font-medium">{entry.service?.name ?? 'An appointment'}</p>
                  <p className="text-sm text-fg-muted">{formatDuration(offer.durationMinutes)}</p>
                </div>
              </div>

              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div className="flex gap-2">
                  <Clock aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
                  <div>
                    <dt className="text-fg-muted">When</dt>
                    <dd className="font-medium">
                      {formatDateLong(offer.startsAt, timezone)}
                      <br />
                      {offerEndsAt
                        ? formatTimeRange(offer.startsAt, offerEndsAt, timezone)
                        : formatTimeRange(offer.startsAt, offer.startsAt, timezone)}
                      <span className="block font-normal text-fg-muted">
                        {formatZoneLabel(timezone)}
                      </span>
                    </dd>
                  </div>
                </div>

                {entry.staffName ? (
                  <div className="flex gap-2">
                    <UserRound aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
                    <div>
                      <dt className="text-fg-muted">With</dt>
                      <dd className="font-medium">{entry.staffName}</dd>
                    </div>
                  </div>
                ) : null}
              </dl>

              {entry.service?.description ? (
                <p className="rounded-lg bg-surface-sunken px-3 py-2 text-sm text-fg-secondary">
                  {entry.service.description}
                </p>
              ) : null}

              <Notice
                tone="warning"
                icon={<Hourglass className="h-4 w-4" />}
                title={`This time is held for you until ${formatRelative(offer.holdExpiresAt, timezone)}`}
              >
                <p>
                  Nobody else can book it before then. After that it goes to the next person on the
                  list and you stay on it for the one after.
                </p>
              </Notice>

              {/* One action, and it is the only one on the page. A confirmation
                  step in front of it would spend the reader's hold on a dialog
                  that adds nothing — this is the thing they opened the email to
                  do, and it can be cancelled afterwards like any booking. */}
              <div className="flex flex-col gap-2">
                <Button
                  size="lg"
                  loading={claim.isPending}
                  onClick={() => claim.mutate()}
                  leadingIcon={<CalendarClock aria-hidden className="h-4 w-4" />}
                >
                  Take this appointment
                </Button>
                <p className="mf-sr-only" role="status" aria-live="polite">
                  {claim.isPending ? 'Booking this appointment, please wait.' : ''}
                </p>
                <p className="text-xs text-fg-muted">
                  {entry.customer ? `Booked in the name of ${entry.customer.firstName}. ` : ''}
                  You can change or cancel it afterwards, subject to {business.name}&rsquo;s policy.
                </p>
              </div>
            </CardBody>
          </Card>
        </div>
      ) : null}

      {/* --- The hold lapsed ---------------------------------------------- */}
      {!isBooked && !live && (refusal?.kind === 'lapsed' || offer?.expired === true) ? (
        <div className="space-y-4">
          <Notice
            tone="info"
            icon={<Hourglass className="h-4 w-4" />}
            title="This hold has run out"
          >
            <p>
              The time was held for a while and has now been offered to the next person waiting. You
              have not lost your place — you are still on the list, and you will be emailed the
              moment another opening matches what you asked for.
            </p>
          </Notice>
          <Card>
            <CardBody className="space-y-4">
              <RequestedWindow entry={entry} timezone={timezone} />
              <NextSteps business={business} slug={slug} />
            </CardBody>
          </Card>
        </div>
      ) : null}

      {/* --- Somebody else took it ---------------------------------------- */}
      {!isBooked && !live && (refusal?.kind === 'slotGone' || refusal?.kind === 'taken') ? (
        <div className="space-y-4">
          <Notice
            tone="info"
            icon={<CalendarClock className="h-4 w-4" />}
            title="That time has just gone"
          >
            <p>
              It was booked in the moments between this page loading and the button being pressed.
              That happens on a busy list. You are still on it, and the next opening that fits will
              come to you.
            </p>
            {refusal?.kind === 'taken' && refusal.appointmentPublicId !== null ? (
              <p>
                <Link
                  to={`/appointments/${refusal.appointmentPublicId}`}
                  className="font-medium underline underline-offset-4"
                >
                  If that was you, open the booking
                </Link>
                .
              </p>
            ) : null}
          </Notice>
          <Card>
            <CardBody className="space-y-4">
              <RequestedWindow entry={entry} timezone={timezone} />
              <NextSteps business={business} slug={slug} />
            </CardBody>
          </Card>
        </div>
      ) : null}

      {/* --- Nothing is being held ----------------------------------------- */}
      {/*
        Everything left over: an ACTIVE entry that has not been offered anything
        yet, one that was withdrawn or ran past its window, and a refusal the
        server described in its own words. They share a panel because they share
        an answer — there is nothing on this page to accept — and the heading
        above each says which it is.
      */}
      {!isBooked &&
      !live &&
      refusal?.kind !== 'lapsed' &&
      refusal?.kind !== 'slotGone' &&
      refusal?.kind !== 'taken' &&
      offer?.expired !== true ? (
        <div className="space-y-4">
          {entry.status === 'ACTIVE' ? (
            <Notice
              tone="info"
              icon={<Hourglass className="h-4 w-4" />}
              title="You are on the waitlist"
            >
              <p>
                Nothing is being held for you at this moment. As soon as a time comes free that fits
                what you asked for, {business.name} will email you a link like this one.
              </p>
            </Notice>
          ) : (
            <Notice
              tone="info"
              icon={<Hourglass className="h-4 w-4" />}
              title="This waitlist request is closed"
            >
              <p>
                {refusal?.kind === 'closed'
                  ? refusal.message
                  : `It is no longer active, so there is nothing here to accept. ${business.name} can add you again if you would like.`}
              </p>
            </Notice>
          )}

          <Card>
            <CardBody className="space-y-4">
              <RequestedWindow entry={entry} timezone={timezone} />
              <NextSteps business={business} slug={slug} />
            </CardBody>
          </Card>
        </div>
      ) : null}
    </PublicShell>
  );
}
