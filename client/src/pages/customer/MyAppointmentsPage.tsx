/**
 * Everything the signed-in person has booked, everywhere.
 *
 * This page used to read `GET /customers?search=<my email>` inside whatever
 * workspace the management app happened to have selected, which needed
 * `customers:read` — a permission a customer never holds — and could only ever
 * show one business at a time. It now reads `/me/bookings`, whose scope is the
 * `Customer` rows pointing at the signed-in account across every workspace at
 * once, and needs no permission at all because the scope *is* the
 * authorisation.
 *
 * Two presentation decisions worth stating.
 *
 * **Rows are labelled by workspace, not grouped under it.** The list is
 * paginated by time, so a page can hold bookings from four businesses and a
 * heading would either fragment a single page into four one-row sections or
 * force client-side regrouping that lies about the page boundaries. The row
 * carries the logo and the name instead. There is also no workspace id in the
 * payload — by design, since this surface never accepts one — so grouping could
 * only key on a display name, and two businesses may share one.
 *
 * **Times render in the reader's own clock, with the venue's stated when they
 * differ.** A booking carries the zone the workspace confirmed it in. Somebody
 * with appointments in two countries needs one reference to compare them, and
 * the only one that is theirs is the browser's — but a person travelling to the
 * appointment needs the local time too, so where the two disagree both are
 * shown rather than one being quietly dropped.
 */
import {
  CalendarCheck2,
  ChevronRight,
  History,
  MailWarning,
  MapPin,
  UserRound,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/layout/PageHeader';
// Imported from the file rather than the `@/components/owner` barrel: this is
// the customer's chunk, and the barrel would drag the whole management bundle
// into it. `pages/public/ManageBookingPage.tsx` avoids it for the same reason.
import { AppointmentStatusBadge } from '@/components/owner/StatusBadge';
import {
  Card,
  CardBody,
  EmptyState,
  ErrorState,
  Pagination,
  Skeleton,
  Tabs,
  type TabItem,
} from '@/components/ui';
import {
  browserTimezone,
  canonicalTimezone,
  formatDayLabel,
  formatDuration,
  formatMoney,
  formatRelative,
  formatTimeRange,
  formatZoneLabel,
} from '@/lib/format';
import {
  usePortalBookings,
  usePortalProfile,
  type BookingWindow,
  type PortalBooking,
} from './portalApi';

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function BookingRow({
  booking,
  viewerZone,
  showCountdown,
}: {
  booking: PortalBooking;
  viewerZone: string;
  showCountdown: boolean;
}): JSX.Element {
  // Canonicalised before comparing: Chrome still reports `Asia/Calcutta` for
  // what the API stores as `Asia/Kolkata`, and an uncanonicalised comparison
  // would print "also 10:00 am there" on every single row.
  const venueZone = canonicalTimezone(booking.timezone);
  const zonesDiffer = venueZone !== viewerZone;

  return (
    <li className="relative flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:gap-5 sm:px-5">
      <div className="flex shrink-0 flex-row items-baseline gap-2 sm:w-40 sm:flex-col sm:items-start sm:gap-0.5">
        <span className="text-sm font-semibold text-fg">
          {formatDayLabel(booking.startsAt, viewerZone)}
        </span>
        <span className="text-sm tabular-nums text-fg-secondary">
          {formatTimeRange(booking.startsAt, booking.endsAt, viewerZone)}
        </span>
        {zonesDiffer ? (
          <span className="text-xs tabular-nums text-fg-muted">
            {formatTimeRange(booking.startsAt, booking.endsAt, venueZone)} local time
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/portal/bookings/${booking.publicId}`}
            className="truncate rounded-xs text-sm font-medium text-fg after:absolute after:inset-0 after:content-[''] hover:text-brand-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {booking.service?.name ?? booking.title ?? 'Appointment'}
          </Link>
          <AppointmentStatusBadge status={booking.status} />
        </div>

        {/* Which business this belongs to. The logo is decorative — the name
            beside it carries the meaning, and a broken image must not leave a
            row that belongs to nobody. */}
        <div className="flex items-center gap-2 text-xs font-medium text-fg-secondary">
          {booking.business.logoUrl ? (
            <img
              src={booking.business.logoUrl}
              alt=""
              className="size-4 shrink-0 rounded-sm object-cover"
            />
          ) : null}
          <span className="truncate">{booking.business.name}</span>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
          {booking.staff ? (
            <span className="inline-flex items-center gap-1.5">
              <UserRound className="size-3.5 shrink-0" aria-hidden="true" />
              {booking.staff.displayName}
            </span>
          ) : null}
          {booking.location ? (
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{booking.location.name}</span>
            </span>
          ) : null}
          <span>{formatDuration(booking.durationMinutes)}</span>
          {booking.priceAmount > 0 ? (
            <span className="tabular-nums">
              {formatMoney(booking.priceAmount, booking.currency)}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 text-xs text-fg-muted">
        {showCountdown ? <span>{formatRelative(booking.startsAt, viewerZone)}</span> : null}
        <ChevronRight className="size-4" aria-hidden="true" />
      </div>
    </li>
  );
}

function ListSkeleton(): JSX.Element {
  return (
    <div className="flex flex-col gap-4 px-5 py-4" aria-hidden="true">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex items-center gap-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-5 w-20" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type Scope = Extract<BookingWindow, 'UPCOMING' | 'PAST'>;

export default function MyAppointmentsPage(): JSX.Element {
  const [scope, setScope] = useState<Scope>('UPCOMING');
  const [upcomingPage, setUpcomingPage] = useState(1);
  const [pastPage, setPastPage] = useState(1);

  const viewerZone = useMemo(() => browserTimezone(), []);

  const profileQuery = usePortalProfile();
  const upcoming = usePortalBookings({ when: 'UPCOMING', page: upcomingPage });
  const past = usePortalBookings({ when: 'PAST', page: pastPage });

  const active = scope === 'UPCOMING' ? upcoming : past;
  const rows = active.data?.items ?? [];

  const tabs = useMemo<Array<TabItem<Scope>>>(
    () => [
      {
        value: 'UPCOMING' as const,
        label: 'Upcoming',
        icon: <CalendarCheck2 className="size-4" />,
        // Spread rather than defaulted: a count of 0 rendered while the request
        // is still in flight is a confident claim the page cannot make.
        ...(upcoming.data ? { count: upcoming.data.meta.totalItems } : {}),
      },
      {
        value: 'PAST' as const,
        label: 'Past',
        icon: <History className="size-4" />,
        ...(past.data ? { count: past.data.meta.totalItems } : {}),
      },
    ],
    [upcoming.data, past.data],
  );

  /**
   * The one-line summary under the title.
   *
   * Withheld entirely until the profile has arrived. "0 bookings across 0
   * businesses" is the single most damaging thing this page could say to
   * somebody whose data simply has not loaded yet.
   */
  const summary = profileQuery.data
    ? `${profileQuery.data.upcomingBookings} upcoming across ${profileQuery.data.workspaces.length} ${
        profileQuery.data.workspaces.length === 1 ? 'business' : 'businesses'
      }. Times are shown in ${formatZoneLabel(viewerZone)}.`
    : undefined;

  // Nobody's address book has a record of this person yet. That is a different
  // fact from "no bookings in this window", and it has a different remedy.
  const unlinked = profileQuery.data !== undefined && profileQuery.data.workspaces.length === 0;
  const unverified = profileQuery.data?.user.emailVerified === false;

  return (
    <>
      <PageHeader title="Your bookings" description={summary} />

      {unlinked ? (
        <Card>
          <EmptyState
            icon={
              unverified ? (
                <MailWarning className="size-6" aria-hidden="true" />
              ) : (
                <CalendarCheck2 className="size-6" aria-hidden="true" />
              )
            }
            title={
              unverified
                ? 'Confirm your email to see your bookings'
                : 'No bookings under this account yet'
            }
            // The verification gate is real and worth naming: MeetFlow only
            // attaches an existing booking to an account once the address has
            // been proven, because matching on an unproven address would let
            // anyone read a stranger's diary by typing their email at sign-up.
            description={
              unverified
                ? 'MeetFlow only links your existing bookings to this account once you have confirmed the email address on it — otherwise anyone could read your diary by typing your address when they signed up. The confirmation link was sent when the account was created.'
                : 'Anything you book with the email address on this account appears here, from every business you book with.'
            }
          />
        </Card>
      ) : (
        <Tabs label="Your bookings" value={scope} onValueChange={setScope} items={tabs}>
          <Card>
            {active.isPending ? (
              <ListSkeleton />
            ) : active.isError ? (
              <ErrorState error={active.error} onRetry={() => void active.refetch()} />
            ) : rows.length === 0 ? (
              <EmptyState
                icon={
                  scope === 'UPCOMING' ? (
                    <CalendarCheck2 className="size-6" aria-hidden="true" />
                  ) : (
                    <History className="size-6" aria-hidden="true" />
                  )
                }
                title={scope === 'UPCOMING' ? 'Nothing booked yet' : 'No past bookings'}
                description={
                  scope === 'UPCOMING'
                    ? 'When you book an appointment it appears here, with everything you can still change about it.'
                    : 'Appointments move here once they have been and gone.'
                }
              />
            ) : (
              <>
                {/* Polite rather than assertive, and busy while a page swaps:
                    `placeholderData` keeps the old rows visible, so without this
                    a screen-reader user would have no idea the list changed. */}
                <div aria-live="polite" aria-busy={active.isFetching}>
                  <ul className="divide-y divide-border">
                    {rows.map((booking) => (
                      <BookingRow
                        key={booking.publicId}
                        booking={booking}
                        viewerZone={viewerZone}
                        showCountdown={scope === 'UPCOMING'}
                      />
                    ))}
                  </ul>
                </div>
                {active.data ? (
                  <Pagination
                    meta={active.data.meta}
                    onPageChange={scope === 'UPCOMING' ? setUpcomingPage : setPastPage}
                    itemLabel="bookings"
                  />
                ) : null}
              </>
            )}
          </Card>
        </Tabs>
      )}

      {profileQuery.isError ? (
        <Card variant="flat">
          <CardBody>
            <ErrorState
              error={profileQuery.error}
              title="We could not load your account summary"
              onRetry={() => void profileQuery.refetch()}
            />
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
