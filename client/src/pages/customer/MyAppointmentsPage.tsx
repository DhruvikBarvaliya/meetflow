import { useQuery } from '@tanstack/react-query';
import {
  CalendarCheck2,
  CalendarClock,
  ChevronRight,
  History,
  MapPin,
  UserRound,
} from 'lucide-react';
import { DateTime } from 'luxon';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorState,
  Pagination,
  Skeleton,
  Tabs,
  type TabItem,
} from '@/components/ui';
import { AppointmentStatusBadge } from '@/components/owner';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/apiClient';
import {
  browserTimezone,
  formatDayLabel,
  formatDuration,
  formatMoney,
  formatRelative,
  formatTimeRange,
  formatZoneOffset,
} from '@/lib/format';
import type { Appointment } from '@/types/api';
import { customerKeys, queryString } from './api';
import { CustomerRecordState } from './CustomerRecordState';
import { useMyCustomer } from './useMyCustomer';

const PAGE_SIZE = 10;

type Scope = 'upcoming' | 'past';

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function BookingRow({
  appointment,
  timezone,
  showCountdown,
}: {
  appointment: Appointment;
  timezone: string;
  showCountdown: boolean;
}): JSX.Element {
  return (
    <li className="relative flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:gap-5 sm:px-5">
      <div className="flex shrink-0 flex-row items-baseline gap-2 sm:w-36 sm:flex-col sm:items-start sm:gap-0.5">
        <span className="text-sm font-semibold text-fg">
          {formatDayLabel(appointment.startsAt, timezone)}
        </span>
        <span className="text-sm tabular-nums text-fg-secondary">
          {formatTimeRange(appointment.startsAt, appointment.endsAt, timezone)}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/app/my/bookings/${appointment.publicId}`}
            className="truncate rounded-xs text-sm font-medium text-fg after:absolute after:inset-0 after:content-[''] hover:text-brand-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {appointment.service?.name ?? appointment.title ?? 'Appointment'}
          </Link>
          <AppointmentStatusBadge status={appointment.status} />
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
          {appointment.staffProfile ? (
            <span className="inline-flex items-center gap-1.5">
              <UserRound className="size-3.5 shrink-0" aria-hidden="true" />
              {appointment.staffProfile.displayName}
            </span>
          ) : null}
          {appointment.location ? (
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{appointment.location.name}</span>
            </span>
          ) : null}
          <span>{formatDuration(appointment.durationMinutes)}</span>
          {appointment.priceAmount > 0 ? (
            <span className="tabular-nums">
              {formatMoney(appointment.priceAmount, appointment.currency)}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 text-xs text-fg-muted">
        {showCountdown ? <span>{formatRelative(appointment.startsAt, timezone)}</span> : null}
        <ChevronRight className="size-4" aria-hidden="true" />
      </div>
    </li>
  );
}

function ListSkeleton(): JSX.Element {
  return (
    <div className="flex flex-col gap-3 px-5 py-4" aria-hidden="true">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex items-center gap-4">
          <Skeleton className="h-4 w-28" />
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

export default function MyAppointmentsPage(): JSX.Element {
  const { activeBusinessId, activeMembership } = useAuth();
  const { state, customer, refetch } = useMyCustomer();

  const [scope, setScope] = useState<Scope>('upcoming');
  const [upcomingPage, setUpcomingPage] = useState(1);
  const [pastPage, setPastPage] = useState(1);

  /*
   * A customer reads their own diary in their own clock. The record's zone is
   * the one the workspace confirmed their booking in; the browser's is only a
   * fallback, and where the two differ the page says which is on screen.
   */
  const viewerZone = customer?.timezone ?? browserTimezone();

  // Recomputed per render on purpose: "upcoming" is measured against now, and a
  // page left open for an hour must not keep showing a finished appointment as
  // still ahead once anything refetches.
  const nowIso = DateTime.now().toISO() ?? '';
  const customerId = customer?.id ?? '';
  const enabled = customerId.length > 0;

  const upcomingQuery = useQuery({
    queryKey: customerKeys.appointments(activeBusinessId, customerId, 'upcoming', upcomingPage),
    queryFn: () =>
      api.getPage<Appointment>(
        `/appointments${queryString({
          customerId,
          from: nowIso,
          page: upcomingPage,
          pageSize: PAGE_SIZE,
        })}`,
      ),
    enabled,
  });

  const pastQuery = useQuery({
    queryKey: customerKeys.appointments(activeBusinessId, customerId, 'past', pastPage),
    queryFn: () =>
      api.getPage<Appointment>(
        `/appointments${queryString({
          customerId,
          to: nowIso,
          page: pastPage,
          pageSize: PAGE_SIZE,
        })}`,
      ),
    enabled,
  });

  const activeQuery = scope === 'upcoming' ? upcomingQuery : pastQuery;
  const rows = activeQuery.data?.items ?? [];
  const pastMeta = pastQuery.data?.meta ?? null;

  const tabs = useMemo<Array<TabItem<Scope>>>(
    () => [
      {
        value: 'upcoming' as const,
        label: 'Upcoming',
        icon: <CalendarClock className="size-4" />,
        ...(upcomingQuery.data ? { count: upcomingQuery.data.meta.totalItems } : {}),
      },
      {
        value: 'past' as const,
        label: 'Past',
        icon: <History className="size-4" />,
        ...(pastQuery.data ? { count: pastQuery.data.meta.totalItems } : {}),
      },
    ],
    [upcomingQuery.data, pastQuery.data],
  );

  const zoneNote = `Times are shown in ${viewerZone.replace(/_/g, ' ')} (${formatZoneOffset(viewerZone)}).`;

  if (state.status !== 'ready') {
    return (
      <>
        <PageHeader title="My bookings" description={zoneNote} />
        <CustomerRecordState state={state} onRetry={refetch} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="My bookings"
        description={
          <>
            Everything you have booked with {activeMembership?.businessName ?? 'this workspace'}.{' '}
            {zoneNote}
          </>
        }
      />

      <Tabs label="Booking history" value={scope} onValueChange={setScope} items={tabs}>
        <Card>
          {/* The API returns a diary in chronological order and offers no way to
              reverse it, so history reads earliest first and the jump does what
              a "newest first" sort would have — using its real page count. */}
          {scope === 'past' && pastMeta !== null && pastMeta.totalPages > 1 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
              <p className="text-sm text-fg-muted">Your history, earliest first.</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPastPage(pastMeta.totalPages)}
                disabled={pastPage === pastMeta.totalPages}
              >
                Jump to most recent
              </Button>
            </div>
          ) : null}

          {activeQuery.isPending ? (
            <ListSkeleton />
          ) : activeQuery.isError ? (
            <ErrorState error={activeQuery.error} onRetry={() => void activeQuery.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<CalendarCheck2 className="size-6" aria-hidden="true" />}
              title={scope === 'upcoming' ? 'Nothing booked yet' : 'No past bookings'}
              description={
                scope === 'upcoming'
                  ? 'When you book an appointment it appears here, with everything you can still change about it.'
                  : 'Appointments move here once they have been and gone.'
              }
              action={
                scope === 'past' ? (
                  <Button variant="secondary" onClick={() => setScope('upcoming')}>
                    See what is coming up
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <ul className="divide-y divide-border">
                {rows.map((appointment) => (
                  <BookingRow
                    key={appointment.id}
                    appointment={appointment}
                    timezone={viewerZone}
                    showCountdown={scope === 'upcoming'}
                  />
                ))}
              </ul>
              {activeQuery.data ? (
                <Pagination
                  meta={activeQuery.data.meta}
                  onPageChange={scope === 'upcoming' ? setUpcomingPage : setPastPage}
                  itemLabel="bookings"
                />
              ) : null}
            </>
          )}
        </Card>
      </Tabs>

      <Card variant="flat">
        <CardBody className="flex flex-col gap-1">
          <p className="text-sm text-fg-secondary">
            Booked as{' '}
            <span className="font-medium text-fg">
              {state.customer.firstName} {state.customer.lastName}
            </span>{' '}
            · {state.customer.email}
          </p>
          {/* Counters maintained by the booking lifecycle, not derived here. */}
          <p className="text-sm text-fg-muted">
            {state.customer.totalBookings} booking{state.customer.totalBookings === 1 ? '' : 's'} in
            total · {state.customer.completedCount} attended
            {state.customer.cancelledCount > 0
              ? ` · ${state.customer.cancelledCount} cancelled`
              : ''}
            {state.customer.noShowCount > 0 ? ` · ${state.customer.noShowCount} missed` : ''}
          </p>
        </CardBody>
      </Card>
    </>
  );
}
