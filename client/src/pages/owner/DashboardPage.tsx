import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BellRing,
  CalendarCheck2,
  CalendarClock,
  CalendarDays,
  Clock3,
  Contact,
  IndianRupee,
  Link2,
  Sparkles,
  UserMinus,
  XCircle,
} from 'lucide-react';
import { DateTime } from 'luxon';
import { useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { PageHeader, PermissionGate } from '@/components/layout';
import {
  APPOINTMENT_EVENTS,
  AppointmentActions,
  AppointmentStatusBadge,
  ChartFrame,
  ChartTooltip,
  DataState,
  StatTile,
  StatTileGrid,
  ownerKeys,
  seriesColour,
  toSearchParams,
  useAxisStyle,
  useChartTheme,
  useLiveRefresh,
  type ServicePerformance,
  type StaffPerformance,
  type TrendBucket,
} from '@/components/owner';
import { Card, CardBody, CardHeader, EmptyState, buttonStyles } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { SOCKET_EVENTS } from '@/context/SocketContext';
import { api } from '@/lib/apiClient';
import {
  formatDate,
  formatDuration,
  formatMoneyCompact,
  formatNumber,
  formatRatioAsPercent,
  formatRelative,
  formatTime,
} from '@/lib/format';
import { PERMISSIONS } from '@/lib/permissions';
import type { AnalyticsOverview, Appointment } from '@/types/api';

/** The window the headline rates are measured over. */
const TREND_DAYS = 30;

/** How far ahead "coming up" looks. */
const UPCOMING_DAYS = 7;

const DASHBOARD_EVENTS = [...APPOINTMENT_EVENTS, SOCKET_EVENTS.dashboardMetricsUpdated];

interface QuickAction {
  label: string;
  description: string;
  to: string;
  icon: typeof CalendarDays;
  permission: (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    label: 'Open the calendar',
    description: 'See the week and move things around.',
    to: '/app/calendar',
    icon: CalendarDays,
    permission: PERMISSIONS.APPOINTMENTS_READ,
  },
  {
    label: 'Share a booking link',
    description: 'Copy the address customers book through.',
    to: '/app/booking-links',
    icon: Link2,
    permission: PERMISSIONS.BOOKING_LINKS_READ,
  },
  {
    label: 'Work the waitlist',
    description: 'Offer openings to the people waiting.',
    to: '/app/waitlist',
    icon: BellRing,
    permission: PERMISSIONS.WAITLIST_READ,
  },
  {
    label: 'Find a customer',
    description: 'History, notes and what they have booked.',
    to: '/app/customers',
    icon: Contact,
    permission: PERMISSIONS.CUSTOMERS_READ,
  },
];

/**
 * The first screen after signing in.
 *
 * Everything on it is a real figure from `/api/v1/analytics/*` or a real row
 * from the diary — there is no placeholder, no target and no projection. A tile
 * whose number has not arrived shows a skeleton rather than a zero, because a
 * zero that turns out to be a loading state is the single most damaging thing a
 * dashboard can print.
 *
 * It refreshes itself from the socket. Several events fire for one operator
 * action, so they are coalesced into a single refetch pass rather than firing
 * seven analytics queries three times over.
 */
export default function DashboardPage(): JSX.Element {
  const { activeBusinessId, activeTimezone, can } = useAuth();
  const queryClient = useQueryClient();
  const chart = useChartTheme();
  const axis = useAxisStyle(chart);

  /*
   * Pinned to the top of the hour.
   *
   * Every window below becomes part of a React Query key, and a key that
   * carried the current millisecond would differ on every render — which is not
   * a stale-cache problem but an infinite refetch loop. Rounding down to the
   * hour keeps the keys stable while still moving the "next seven days" window
   * forward as the day goes on.
   */
  const now = DateTime.now().setZone(activeTimezone).startOf('hour');
  const todayIso = now.toISODate() ?? '';

  const canReadDiary = can(PERMISSIONS.APPOINTMENTS_READ) || can(PERMISSIONS.APPOINTMENTS_READ_OWN);
  const canReadAnalytics = can(PERMISSIONS.ANALYTICS_READ);

  // --- Today's diary -------------------------------------------------------

  const todayScope = {
    from: now.startOf('day').toISO() ?? '',
    to: now.endOf('day').toISO() ?? '',
    pageSize: 100,
  };

  const todayQuery = useQuery({
    queryKey: ownerKeys.appointments(activeBusinessId, todayScope),
    queryFn: () => api.getPage<Appointment>(`/appointments${toSearchParams(todayScope)}`),
    enabled: canReadDiary,
  });

  const upcomingScope = {
    from: now.toISO() ?? '',
    to: now.plus({ days: UPCOMING_DAYS }).toISO() ?? '',
    status: 'CONFIRMED',
    pageSize: 1,
  };

  const upcomingQuery = useQuery({
    queryKey: ownerKeys.appointments(activeBusinessId, upcomingScope),
    queryFn: () => api.getPage<Appointment>(`/appointments${toSearchParams(upcomingScope)}`),
    enabled: canReadDiary,
  });

  const pendingScope = { status: 'PENDING', pageSize: 5 };

  const pendingQuery = useQuery({
    queryKey: ownerKeys.appointments(activeBusinessId, pendingScope),
    queryFn: () => api.getPage<Appointment>(`/appointments${toSearchParams(pendingScope)}`),
    enabled: canReadDiary,
  });

  // --- Analytics -----------------------------------------------------------

  const analyticsScope = {
    from: now.minus({ days: TREND_DAYS - 1 }).toISODate() ?? todayIso,
    to: todayIso,
  };

  const overviewQuery = useQuery({
    queryKey: ownerKeys.analytics(activeBusinessId, 'overview', analyticsScope),
    queryFn: () =>
      api.get<AnalyticsOverview>(`/analytics/overview${toSearchParams(analyticsScope)}`),
    enabled: canReadAnalytics,
  });

  const trendsQuery = useQuery({
    queryKey: ownerKeys.analytics(activeBusinessId, 'trends', analyticsScope),
    queryFn: () => api.get<TrendBucket[]>(`/analytics/trends${toSearchParams(analyticsScope)}`),
    enabled: canReadAnalytics,
  });

  const staffQuery = useQuery({
    queryKey: ownerKeys.analytics(activeBusinessId, 'staff', analyticsScope),
    queryFn: () => api.get<StaffPerformance[]>(`/analytics/staff${toSearchParams(analyticsScope)}`),
    enabled: canReadAnalytics,
  });

  const servicesQuery = useQuery({
    queryKey: ownerKeys.analytics(activeBusinessId, 'services', analyticsScope),
    queryFn: () =>
      api.get<ServicePerformance[]>(`/analytics/services${toSearchParams(analyticsScope)}`),
    enabled: canReadAnalytics,
  });

  // --- Live ----------------------------------------------------------------

  const refresh = useCallback(() => {
    const scope = ownerKeys.root(activeBusinessId);
    void queryClient.invalidateQueries({ queryKey: [...scope, 'appointments'] });
    void queryClient.invalidateQueries({ queryKey: [...scope, 'analytics'] });
  }, [queryClient, activeBusinessId]);

  const { lastUpdatedAt } = useLiveRefresh({ events: DASHBOARD_EVENTS, onRefresh: refresh });

  // --- Derived -------------------------------------------------------------

  const todayAppointments = todayQuery.data?.items ?? [];

  /**
   * What is left of today.
   *
   * Measured against the real clock at the moment the diary arrived, not
   * against the hour-rounded `now` the query keys use — an operator asking
   * "what is still to come" means now, not the top of the hour. It is not
   * re-evaluated on a timer: a counter that silently decrements while someone
   * reads it is more unsettling than useful, and the socket refresh moves it
   * whenever the diary actually changes.
   */
  const nextUp = useMemo(() => {
    const boundary = Date.now();
    return todayAppointments.filter(
      (appointment) =>
        DateTime.fromISO(appointment.endsAt).toMillis() >= boundary &&
        appointment.status !== 'CANCELLED' &&
        appointment.status !== 'REJECTED',
    );
  }, [todayAppointments]);

  /**
   * Workspace-wide utilisation over the window.
   *
   * Summed rather than averaged across people: a provider rostered for one hour
   * and a provider rostered for forty must not count equally, which is exactly
   * what averaging their rates would do.
   */
  const utilisation = useMemo(() => {
    const rows = staffQuery.data ?? [];
    const booked = rows.reduce((total, row) => total + row.bookedMinutes, 0);
    const rostered = rows.reduce((total, row) => total + row.workingMinutes, 0);
    return { booked, rostered, rate: rostered === 0 ? null : booked / rostered };
  }, [staffQuery.data]);

  const trendData = useMemo(
    () =>
      (trendsQuery.data ?? []).map((bucket) => ({
        ...bucket,
        label: formatDate(bucket.date, activeTimezone),
      })),
    [trendsQuery.data, activeTimezone],
  );

  const topServices = useMemo(() => (servicesQuery.data ?? []).slice(0, 6), [servicesQuery.data]);

  const currency = overviewQuery.data?.currency ?? 'INR';

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`${now.toFormat('cccc d LLLL')} · ${activeTimezone}`}
        actions={
          lastUpdatedAt ? (
            <p className="text-xs text-fg-muted" role="status" aria-live="polite">
              Updated {formatRelative(lastUpdatedAt, activeTimezone)}
            </p>
          ) : null
        }
      />

      <StatTileGrid columns={3}>
        <StatTile
          label="On today"
          value={formatNumber(todayQuery.data?.meta.totalItems ?? 0)}
          icon={CalendarCheck2}
          isLoading={todayQuery.isPending}
          caption={
            canReadDiary
              ? `${formatNumber(nextUp.length)} still to come`
              : 'Your role cannot read the diary'
          }
        />
        <StatTile
          label={`Next ${UPCOMING_DAYS} days`}
          value={formatNumber(upcomingQuery.data?.meta.totalItems ?? 0)}
          icon={CalendarClock}
          isLoading={upcomingQuery.isPending}
          caption="Confirmed appointments ahead"
        />
        <StatTile
          label="Utilisation"
          value={utilisation.rate === null ? '—' : formatRatioAsPercent(utilisation.rate)}
          icon={Clock3}
          isLoading={staffQuery.isPending}
          caption={
            utilisation.rate === null
              ? 'Nobody was rostered in the last 30 days'
              : `${formatDuration(utilisation.booked)} booked of ${formatDuration(
                  utilisation.rostered,
                )} rostered`
          }
        />
        <StatTile
          label="Cancellations"
          value={formatNumber(overviewQuery.data?.cancelled ?? 0)}
          detail={formatRatioAsPercent(overviewQuery.data?.cancellationRate ?? 0)}
          icon={XCircle}
          tone={(overviewQuery.data?.cancellationRate ?? 0) > 0.2 ? 'negative' : 'default'}
          isLoading={overviewQuery.isPending}
          caption={`In the last ${TREND_DAYS} days`}
        />
        <StatTile
          label="No-shows"
          value={formatNumber(overviewQuery.data?.noShows ?? 0)}
          detail={formatRatioAsPercent(overviewQuery.data?.noShowRate ?? 0)}
          icon={UserMinus}
          tone={(overviewQuery.data?.noShowRate ?? 0) > 0.1 ? 'negative' : 'default'}
          isLoading={overviewQuery.isPending}
          caption={`Of everything due in the last ${TREND_DAYS} days`}
        />
        <StatTile
          label="Revenue"
          value={formatMoneyCompact(overviewQuery.data?.revenueAmount ?? 0, currency)}
          icon={IndianRupee}
          isLoading={overviewQuery.isPending}
          caption={`From ${formatNumber(
            overviewQuery.data?.completed ?? 0,
          )} completed appointments in the last ${TREND_DAYS} days`}
        />
      </StatTileGrid>

      <div className="grid gap-4">
        <ChartFrame
          title="Booking trend"
          description={`Bookings placed and completed over the last ${TREND_DAYS} days.`}
          height={260}
          isLoading={trendsQuery.isPending}
          error={trendsQuery.error}
          onRetry={() => void trendsQuery.refetch()}
          isEmpty={trendData.every((bucket) => bucket.bookings === 0)}
          emptyMessage={`Nothing was booked in the last ${TREND_DAYS} days, so there is no trend to draw yet.`}
          legend={[
            { label: 'Booked', colour: seriesColour(chart, 0) },
            { label: 'Completed', colour: seriesColour(chart, 1) },
          ]}
          summary={`Daily bookings and completions over the last ${TREND_DAYS} days.`}
          actions={
            <Link to="/app/analytics" className={buttonStyles('ghost', 'sm')}>
              Full analytics
            </Link>
          }
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trendData} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
              <CartesianGrid stroke={chart.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="label"
                tick={axis.tick}
                tickLine={false}
                axisLine={axis.line}
                minTickGap={28}
              />
              <YAxis
                tick={axis.tick}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
                width={36}
              />
              <Tooltip
                cursor={{ stroke: chart.grid }}
                content={<ChartTooltip formatValue={(value) => formatNumber(value)} />}
              />
              <Line
                type="monotone"
                dataKey="bookings"
                name="Booked"
                stroke={seriesColour(chart, 0)}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: chart.surface }}
              />
              <Line
                type="monotone"
                dataKey="completed"
                name="Completed"
                stroke={seriesColour(chart, 1)}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: chart.surface }}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartFrame>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            as="h2"
            title="Today"
            description={
              todayAppointments.length > 0
                ? `${formatNumber(todayAppointments.length)} in the diary, ${formatNumber(
                    nextUp.length,
                  )} still to come.`
                : undefined
            }
            actions={
              <Link
                to={`/app/appointments?from=${todayIso}&to=${todayIso}`}
                className={buttonStyles('ghost', 'sm')}
              >
                Open the diary
              </Link>
            }
          />
          <DataState
            isPending={todayQuery.isPending}
            isError={todayQuery.isError}
            error={todayQuery.error}
            onRetry={() => void todayQuery.refetch()}
            isEmpty={todayAppointments.length === 0}
            rows={4}
            columns={4}
            empty={
              <EmptyState
                icon={<CalendarDays className="size-6" aria-hidden="true" />}
                title="Nothing booked today"
                description="A clear day. Share a booking link if you would rather it were not."
                action={
                  <PermissionGate permission={PERMISSIONS.BOOKING_LINKS_READ}>
                    <Link to="/app/booking-links" className={buttonStyles('secondary', 'md')}>
                      Booking links
                    </Link>
                  </PermissionGate>
                }
              />
            }
          >
            <ul className="divide-y divide-border">
              {todayAppointments.map((appointment) => (
                <li key={appointment.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <span className="w-16 shrink-0 text-sm font-medium tabular-nums text-fg">
                    {formatTime(appointment.startsAt, activeTimezone)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-fg">
                      {appointment.service?.name ?? 'Appointment'}
                    </span>
                    <span className="block truncate text-xs text-fg-muted">
                      {appointment.customer
                        ? `${appointment.customer.firstName} ${appointment.customer.lastName}`
                        : 'No customer'}
                      {appointment.staffProfile ? ` · ${appointment.staffProfile.displayName}` : ''}
                    </span>
                  </span>
                  <AppointmentStatusBadge status={appointment.status} />
                  <AppointmentActions
                    appointment={appointment}
                    variant="menu"
                    onCompleted={refresh}
                  />
                </li>
              ))}
            </ul>
          </DataState>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader
              as="h2"
              title="Waiting on you"
              description="Bookings that arrived needing approval."
            />
            <DataState
              isPending={pendingQuery.isPending}
              isError={pendingQuery.isError}
              error={pendingQuery.error}
              onRetry={() => void pendingQuery.refetch()}
              isEmpty={(pendingQuery.data?.items ?? []).length === 0}
              rows={2}
              columns={2}
              empty={
                <EmptyState
                  title="Nothing to approve"
                  description="Every booking that needed a decision has had one."
                />
              }
            >
              <ul className="divide-y divide-border">
                {(pendingQuery.data?.items ?? []).map((appointment) => (
                  <li key={appointment.id} className="flex flex-col gap-2 px-5 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-fg">
                        {appointment.service?.name ?? 'Appointment'}
                      </p>
                      <p className="truncate text-xs text-fg-muted">
                        {formatDate(appointment.startsAt, activeTimezone)} ·{' '}
                        {formatTime(appointment.startsAt, activeTimezone)}
                        {appointment.customer
                          ? ` · ${appointment.customer.firstName} ${appointment.customer.lastName}`
                          : ''}
                      </p>
                    </div>
                    <AppointmentActions
                      appointment={appointment}
                      variant="buttons"
                      onCompleted={refresh}
                    />
                  </li>
                ))}
              </ul>
            </DataState>
            {(pendingQuery.data?.meta.totalItems ?? 0) > 5 ? (
              <CardBody className="border-t border-border pt-3">
                <Link
                  to="/app/appointments?status=PENDING"
                  className="text-sm font-medium text-brand-text underline underline-offset-4"
                >
                  See all {formatNumber(pendingQuery.data?.meta.totalItems ?? 0)} pending
                </Link>
              </CardBody>
            ) : null}
          </Card>

          <Card>
            <CardHeader as="h2" title="Quick actions" />
            <CardBody className="flex flex-col gap-1">
              {QUICK_ACTIONS.map((action) => (
                <PermissionGate key={action.to} permission={action.permission}>
                  <Link
                    to={action.to}
                    className="flex items-start gap-3 rounded-md px-2 py-2 transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  >
                    <span
                      className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-brand-subtle text-brand-text"
                      aria-hidden="true"
                    >
                      <action.icon className="size-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-fg">{action.label}</span>
                      <span className="block text-xs text-fg-muted">{action.description}</span>
                    </span>
                  </Link>
                </PermissionGate>
              ))}
            </CardBody>
          </Card>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            as="h2"
            title="Staff workload"
            description={`Booked time against rostered time, over the last ${TREND_DAYS} days.`}
          />
          <DataState
            isPending={staffQuery.isPending}
            isError={staffQuery.isError}
            error={staffQuery.error}
            onRetry={() => void staffQuery.refetch()}
            isEmpty={(staffQuery.data ?? []).length === 0}
            rows={3}
            columns={3}
            empty={
              <EmptyState
                title="No workload to show"
                description="Nobody has taken an appointment in this window."
              />
            }
          >
            <CardBody className="flex flex-col gap-4">
              {(staffQuery.data ?? []).map((row, index) => (
                <div key={row.staffProfileId} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium text-fg">{row.displayName}</span>
                    <span className="shrink-0 text-sm tabular-nums text-fg-secondary">
                      {formatRatioAsPercent(row.utilisationRate)}
                    </span>
                  </div>
                  <span
                    className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken"
                    aria-hidden="true"
                  >
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${Math.min(100, row.utilisationRate * 100)}%`,
                        backgroundColor: seriesColour(chart, index),
                      }}
                    />
                  </span>
                  <span className="text-xs text-fg-muted">
                    {formatNumber(row.appointments)} appointment
                    {row.appointments === 1 ? '' : 's'} · {formatDuration(row.bookedMinutes)} of{' '}
                    {formatDuration(row.workingMinutes)}
                    {row.noShows > 0 ? ` · ${formatNumber(row.noShows)} no-show` : ''}
                  </span>
                </div>
              ))}
            </CardBody>
          </DataState>
        </Card>

        <ChartFrame
          title="Service performance"
          description={`Bookings per service over the last ${TREND_DAYS} days.`}
          height={240}
          isLoading={servicesQuery.isPending}
          error={servicesQuery.error}
          onRetry={() => void servicesQuery.refetch()}
          isEmpty={topServices.length === 0}
          emptyMessage="No service was booked in this window."
          summary="Bookings per service, most booked first."
          actions={
            <PermissionGate permission={PERMISSIONS.SERVICES_READ}>
              <Link to="/app/services" className={buttonStyles('ghost', 'sm')}>
                Catalogue
              </Link>
            </PermissionGate>
          }
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              layout="vertical"
              data={topServices}
              margin={{ top: 4, right: 16, bottom: 4, left: 0 }}
              barCategoryGap="30%"
            >
              <CartesianGrid stroke={chart.grid} strokeDasharray="3 3" horizontal={false} />
              <XAxis
                type="number"
                tick={axis.tick}
                tickLine={false}
                axisLine={axis.line}
                allowDecimals={false}
              />
              <YAxis
                type="category"
                dataKey="name"
                tick={axis.tick}
                tickLine={false}
                axisLine={false}
                width={124}
              />
              <Tooltip
                cursor={{ fill: chart.grid, fillOpacity: 0.35 }}
                content={<ChartTooltip formatValue={(value) => formatNumber(value)} />}
              />
              <Bar
                dataKey="bookings"
                name="Bookings"
                fill={seriesColour(chart, 0)}
                radius={[0, 4, 4, 0]}
                maxBarSize={20}
              />
            </BarChart>
          </ResponsiveContainer>
        </ChartFrame>
      </div>

      {!canReadAnalytics ? (
        <Card>
          <EmptyState
            icon={<Sparkles className="size-6" aria-hidden="true" />}
            title="Analytics are not available to your role"
            description="Utilisation, the booking trend and service performance all come from the reporting endpoints, which your role cannot read. Everything else on this page is the diary itself."
          />
        </Card>
      ) : null}
    </>
  );
}
