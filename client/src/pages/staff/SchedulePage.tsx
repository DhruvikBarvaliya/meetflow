import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, CalendarDays, Clock, LogIn, MapPin, Radio, UserRound } from 'lucide-react';
import { DateTime } from 'luxon';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  APPOINTMENT_EVENTS,
  AppointmentStatusBadge,
  DataState,
  availableTransitions,
  ownerKeys,
  toSearchParams,
  useAppointmentActions,
  useLiveRefresh,
} from '@/components/owner';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  Pagination,
  Select,
  Skeleton,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useSocket } from '@/context/SocketContext';
import { api } from '@/lib/apiClient';
import { cn } from '@/lib/cn';
import {
  formatDayLabel,
  formatDuration,
  formatRelative,
  formatTime,
  formatTimeRange,
  formatZoneOffset,
  customerName,
  toIsoDate,
} from '@/lib/format';
import type { Appointment } from '@/types/api';
import { useMyStaffProfile } from './useMyStaffProfile';

/** A provider's day never legitimately exceeds this; the page says so if it does. */
const DAY_PAGE_SIZE = 100;
const UPCOMING_PAGE_SIZE = 50;

const HORIZON_OPTIONS = [
  { value: '7', label: 'Next 7 days' },
  { value: '14', label: 'Next 14 days' },
  { value: '30', label: 'Next 30 days' },
];

function iso(value: DateTime): string {
  return value.toISO() ?? '';
}

// ---------------------------------------------------------------------------
// Live connection
// ---------------------------------------------------------------------------

/**
 * The socket's own state, shown rather than assumed.
 *
 * A staff member who has walked out of Wi-Fi range needs to know the page has
 * stopped updating itself, because the alternative is trusting a diary that
 * quietly froze twenty minutes ago.
 */
function LiveIndicator({ lastUpdatedAt }: { lastUpdatedAt: Date | null }): JSX.Element {
  const { status } = useSocket();
  const connected = status === 'connected';

  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
          connected
            ? 'border-success-border bg-success-subtle text-success-text'
            : 'border-border bg-surface-sunken text-fg-muted',
        )}
      >
        <Radio className="size-3.5" aria-hidden="true" />
        {connected ? 'Live' : 'Reconnecting'}
      </span>
      {/* Announced, not just drawn: a row changing under the cursor is easy to
          miss, and impossible to notice without sight. */}
      <span role="status" aria-live="polite" className="mf-sr-only">
        {lastUpdatedAt
          ? `Schedule updated at ${DateTime.fromJSDate(lastUpdatedAt).toFormat('h:mm a')}`
          : connected
            ? 'Live updates connected'
            : 'Live updates disconnected'}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface RowProps {
  appointment: Appointment;
  timezone: string;
  /** Only today's rows offer arrival; a Friday booking cannot be checked in. */
  showCheckIn: boolean;
  onCheckIn: (appointmentId: string) => void;
  checkingInId: string | null;
}

function ScheduleRow({
  appointment,
  timezone,
  showCheckIn,
  onCheckIn,
  checkingInId,
}: RowProps): JSX.Element {
  const { can } = useAuth();
  // `displayName`, not `customerName` — the latter is the imported helper, and
  // a local of the same name would shadow it into a self-reference.
  const displayName = appointment.customer
    ? customerName(appointment.customer)
    : 'No customer on this booking';

  const label = appointment.title ?? appointment.service?.name ?? 'Appointment';
  // The same test the action list uses, so the button only ever appears where
  // the API would accept it.
  const offersCheckIn =
    showCheckIn &&
    appointment.checkedInAt === null &&
    availableTransitions(appointment.status, can).includes('check-in');

  return (
    <li className="relative flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
      <div className="flex shrink-0 items-baseline gap-2 sm:w-32 sm:flex-col sm:items-start sm:gap-0.5">
        <span className="text-sm font-semibold tabular-nums text-fg">
          {formatTime(appointment.startsAt, timezone)}
        </span>
        <span className="text-xs text-fg-muted">{formatDuration(appointment.durationMinutes)}</span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="size-2.5 shrink-0 rounded-full border border-border"
            style={{ backgroundColor: appointment.service?.color ?? 'transparent' }}
            aria-hidden="true"
          />
          {/* Stretched link: the whole row is the tap target on a phone, while
              the quick action below keeps its own stacking context above it. */}
          <Link
            to={`/app/my/schedule/${appointment.id}`}
            className="truncate rounded-xs text-sm font-medium text-fg after:absolute after:inset-0 after:content-[''] hover:text-brand-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {label}
          </Link>
          <AppointmentStatusBadge status={appointment.status} />
          {appointment.checkedInAt !== null ? (
            <Badge tone="info">Arrived {formatTime(appointment.checkedInAt, timezone)}</Badge>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
          <span className="inline-flex items-center gap-1.5">
            <UserRound className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{displayName}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Clock className="size-3.5 shrink-0" aria-hidden="true" />
            {formatTimeRange(appointment.startsAt, appointment.endsAt, timezone)}
          </span>
          {appointment.location ? (
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{appointment.location.name}</span>
            </span>
          ) : null}
        </div>
      </div>

      {offersCheckIn ? (
        <div className="relative shrink-0">
          <Button
            variant="secondary"
            size="sm"
            loading={checkingInId === appointment.id}
            onClick={() => onCheckIn(appointment.id)}
            leadingIcon={<LogIn className="size-4" aria-hidden="true" />}
          >
            Check in
            <span className="mf-sr-only"> {displayName}</span>
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function RowSkeleton(): JSX.Element {
  return (
    <div className="flex flex-col gap-3 px-5 py-4" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex items-center gap-4">
          <Skeleton className="h-4 w-16" />
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

export default function SchedulePage(): JSX.Element {
  const { activeBusinessId, activeTimezone } = useAuth();
  const {
    staffProfileId,
    isLoading: profileLoading,
    isError: profileError,
    refetch,
  } = useMyStaffProfile();
  const queryClient = useQueryClient();
  const { transition } = useAppointmentActions();

  const [horizonDays, setHorizonDays] = useState('14');
  const [upcomingPage, setUpcomingPage] = useState(1);

  // Anchored to the workspace clock, not the browser's: a therapist checking
  // their diary from an airport must still see the studio's "today".
  const bounds = useMemo(() => {
    const todayStart = DateTime.now().setZone(activeTimezone).startOf('day');
    const tomorrowStart = todayStart.plus({ days: 1 });
    return {
      todayStart,
      todayEnd: tomorrowStart,
      upcomingStart: tomorrowStart,
      upcomingEnd: tomorrowStart.plus({ days: Number(horizonDays) }),
    };
  }, [activeTimezone, horizonDays]);

  const enabled = staffProfileId !== null && activeBusinessId !== null;

  const todayScope = {
    from: iso(bounds.todayStart),
    to: iso(bounds.todayEnd),
    staffProfileId: staffProfileId ?? '',
    pageSize: DAY_PAGE_SIZE,
  };

  const upcomingScope = {
    from: iso(bounds.upcomingStart),
    to: iso(bounds.upcomingEnd),
    staffProfileId: staffProfileId ?? '',
    page: upcomingPage,
    pageSize: UPCOMING_PAGE_SIZE,
  };

  const todayQuery = useQuery({
    queryKey: ownerKeys.appointments(activeBusinessId, todayScope),
    queryFn: () => api.getPage<Appointment>(`/appointments${toSearchParams(todayScope)}`),
    enabled,
  });

  const upcomingQuery = useQuery({
    queryKey: ownerKeys.appointments(activeBusinessId, upcomingScope),
    queryFn: () => api.getPage<Appointment>(`/appointments${toSearchParams(upcomingScope)}`),
    enabled,
  });

  /*
   * One coalesced refresh per burst of events rather than one per event: a
   * single cancellation fans out into an appointment event and a metrics
   * event, and refetching twice for one change is visible as a flicker.
   *
   * The whole appointments prefix is invalidated rather than a row patched —
   * the payloads carry ids and times, not the joined service, customer and
   * location a row renders, so a surgical merge would draw a row with holes.
   */
  const { lastUpdatedAt } = useLiveRefresh({
    events: APPOINTMENT_EVENTS,
    onRefresh: () => {
      void queryClient.invalidateQueries({
        queryKey: [...ownerKeys.root(activeBusinessId), 'appointments'],
      });
    },
  });

  const checkingInId =
    transition.isPending && transition.variables?.action === 'check-in'
      ? transition.variables.id
      : null;

  const onCheckIn = (appointmentId: string): void => {
    transition.mutate({ id: appointmentId, action: 'check-in' });
  };

  const todayRows = todayQuery.data?.items ?? [];

  /** The next thing this person actually has to walk into. */
  const nextUp = useMemo(() => {
    const now = DateTime.now();
    return (
      todayRows.find(
        (row) =>
          DateTime.fromISO(row.endsAt) > now &&
          (row.status === 'PENDING' ||
            row.status === 'CONFIRMED' ||
            row.status === 'RESCHEDULED' ||
            row.status === 'IN_PROGRESS'),
      ) ?? null
    );
  }, [todayRows]);

  const upcomingGroups = useMemo(() => {
    const rows = upcomingQuery.data?.items ?? [];
    const groups = new Map<string, Appointment[]>();
    for (const row of rows) {
      const day = toIsoDate(row.startsAt, activeTimezone);
      const existing = groups.get(day);
      if (existing) existing.push(row);
      else groups.set(day, [row]);
    }
    return [...groups.entries()];
  }, [upcomingQuery.data, activeTimezone]);

  const zoneNote = `Times are shown in ${activeTimezone.replace(/_/g, ' ')} (${formatZoneOffset(activeTimezone)}).`;

  // --- States before there is a diary to draw -------------------------------

  if (profileLoading) {
    return (
      <>
        <PageHeader title="My schedule" description={zoneNote} />
        <Card>
          <RowSkeleton />
        </Card>
      </>
    );
  }

  if (profileError) {
    return (
      <>
        <PageHeader title="My schedule" description={zoneNote} />
        <Card>
          {/* The roster lookup reports failure without surfacing the error
              object, so the generic presentation is the honest one here. */}
          <ErrorState
            error={null}
            onRetry={refetch}
            title="We could not work out whose diary to show"
          />
        </Card>
      </>
    );
  }

  if (staffProfileId === null) {
    return (
      <>
        <PageHeader title="My schedule" description={zoneNote} />
        <Card>
          <EmptyState
            icon={<CalendarDays className="size-6" aria-hidden="true" />}
            title="You are not set up as a provider here"
            description="Appointments are assigned to provider profiles, and your account does not have one in this workspace. An owner or manager can create it."
          />
        </Card>
      </>
    );
  }

  // --- The diary ------------------------------------------------------------

  return (
    <>
      <PageHeader
        title="My schedule"
        description={zoneNote}
        actions={<LiveIndicator lastUpdatedAt={lastUpdatedAt} />}
      />

      {nextUp ? (
        <Card className="border-brand-border bg-brand-subtle">
          <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-brand-text">
                Next up · {formatRelative(nextUp.startsAt, activeTimezone)}
              </p>
              <p className="truncate text-base font-semibold text-fg">
                {nextUp.title ?? nextUp.service?.name ?? 'Appointment'}
                {nextUp.customer ? (
                  <span className="font-normal text-fg-secondary">
                    {' '}
                    with {customerName(nextUp.customer)}
                  </span>
                ) : null}
              </p>
              <p className="text-sm text-fg-secondary">
                {formatTimeRange(nextUp.startsAt, nextUp.endsAt, activeTimezone)}
                {nextUp.location ? ` · ${nextUp.location.name}` : ''}
              </p>
            </div>
            <Link
              to={`/app/my/schedule/${nextUp.id}`}
              className="shrink-0 rounded-md bg-brand px-4 py-2 text-sm font-medium text-on-brand transition-colors hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              Open appointment
            </Link>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          as="h2"
          title={`Today · ${formatDayLabel(bounds.todayStart, activeTimezone)}`}
          description={
            todayQuery.data ? `${todayQuery.data.meta.totalItems} booked` : 'Loading your day'
          }
        />
        <DataState
          isPending={todayQuery.isPending}
          isError={todayQuery.isError}
          error={todayQuery.error}
          onRetry={() => void todayQuery.refetch()}
          isEmpty={todayRows.length === 0}
          skeleton={<RowSkeleton />}
          empty={
            <EmptyState
              icon={<CalendarCheck className="size-6" aria-hidden="true" />}
              title="Nothing booked today"
              description="Your day is clear. Anything booked from now on appears here without a refresh."
            />
          }
        >
          <ul className="divide-y divide-border">
            {todayRows.map((appointment) => (
              <ScheduleRow
                key={appointment.id}
                appointment={appointment}
                timezone={activeTimezone}
                showCheckIn
                onCheckIn={onCheckIn}
                checkingInId={checkingInId}
              />
            ))}
          </ul>
          {todayQuery.data?.meta.hasNextPage === true ? (
            <p className="border-t border-border px-5 py-3 text-sm text-fg-muted">
              Showing the first {DAY_PAGE_SIZE} of {todayQuery.data.meta.totalItems} bookings today.
            </p>
          ) : null}
        </DataState>
      </Card>

      <Card>
        <CardHeader
          as="h2"
          title="Upcoming"
          description={
            upcomingQuery.data
              ? `${upcomingQuery.data.meta.totalItems} booked from tomorrow onwards`
              : 'Loading what is ahead'
          }
          actions={
            <label className="flex items-center gap-2 text-sm">
              <span className="text-fg-muted">Show</span>
              <Select
                options={HORIZON_OPTIONS}
                value={horizonDays}
                selectSize="sm"
                className="w-40"
                onChange={(event) => {
                  setHorizonDays(event.target.value);
                  setUpcomingPage(1);
                }}
                aria-label="How far ahead to show"
              />
            </label>
          }
        />
        <DataState
          isPending={upcomingQuery.isPending}
          isError={upcomingQuery.isError}
          error={upcomingQuery.error}
          onRetry={() => void upcomingQuery.refetch()}
          isEmpty={upcomingGroups.length === 0}
          skeleton={<RowSkeleton />}
          empty={
            <EmptyState
              icon={<CalendarDays className="size-6" aria-hidden="true" />}
              title={`Nothing booked in the next ${horizonDays} days`}
              description="Widen the range above, or check your working hours if you expected bookings here."
              action={
                <Link
                  to="/app/my/availability"
                  className="rounded-md border border-border bg-surface-sunken px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  Review my availability
                </Link>
              }
            />
          }
        >
          {upcomingGroups.map(([day, rows]) => (
            <section key={day} aria-label={formatDayLabel(day, activeTimezone)}>
              <h3 className="sticky top-[var(--mf-topbar-height)] z-10 border-y border-border bg-surface-sunken px-5 py-2 text-xs font-semibold uppercase tracking-wide text-fg-secondary">
                {formatDayLabel(day, activeTimezone)}
              </h3>
              <ul className="divide-y divide-border">
                {rows.map((appointment) => (
                  <ScheduleRow
                    key={appointment.id}
                    appointment={appointment}
                    timezone={activeTimezone}
                    showCheckIn={false}
                    onCheckIn={onCheckIn}
                    checkingInId={checkingInId}
                  />
                ))}
              </ul>
            </section>
          ))}
          {upcomingQuery.data ? (
            <Pagination
              meta={upcomingQuery.data.meta}
              onPageChange={setUpcomingPage}
              itemLabel="appointments"
            />
          ) : null}
        </DataState>
      </Card>
    </>
  );
}
