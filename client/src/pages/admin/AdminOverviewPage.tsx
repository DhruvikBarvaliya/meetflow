import { useQuery } from '@tanstack/react-query';
import { Building2, CalendarCheck2, Contact, UsersRound } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PageHeader } from '@/components/layout';
import {
  ChartFrame,
  ChartTooltip,
  DataState,
  StatTile,
  StatTileGrid,
  seriesColour,
  useAxisStyle,
  useChartTheme,
} from '@/components/owner';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  TBody,
  THead,
  Table,
  TableContainer,
  Td,
  Th,
  Tr,
  type BadgeTone,
} from '@/components/ui';
import {
  browserTimezone,
  formatDate,
  formatNumber,
  formatRelative,
  humanizeEnum,
} from '@/lib/format';
import type { AdminOverview, AdminWorkspaceStatus } from '@/types/api';
import { fetchAdminOverview } from './adminApi';
import { adminKeys } from './adminKeys';

/**
 * The landing screen of the platform-administration surface.
 *
 * Every figure on this page is a live `count(*)` taken over the real tables at
 * the moment of the request — there is no rollup table, no nightly job and no
 * cached total behind any of it. That is the same discipline
 * `server/src/modules/analytics/analytics.service.ts` documents for the tenant
 * reports, and it holds here for the same reason: a rollup that drifts is worse
 * than no rollup, because nobody can tell by looking that it has drifted. The
 * cost is a handful of aggregate queries per load, which is why nothing on this
 * page polls.
 *
 * It also inherits the privacy boundary the admin API is shaped around. Nothing
 * below names a customer, a booking or a note, because the response has no field
 * to put one in: an operator running the platform has no business reading a
 * clinic's patient list, and counts are the whole answer this page needs.
 */

/** How far back the headline volume figures reach, matching the API's window. */
const WINDOW_DAYS = 30;

/**
 * Workspace status pills.
 *
 * Declared here rather than in `components/owner/StatusBadge.tsx` because the
 * tenant surface has no such pill to share: a workspace never sees its own
 * lifecycle status, only the operator does. Suspended is amber rather than red
 * — it is a reversible administrative decision, not a fault.
 */
const WORKSPACE_STATUS_TONES: Record<AdminWorkspaceStatus, BadgeTone> = {
  ACTIVE: 'success',
  SUSPENDED: 'warning',
  ARCHIVED: 'neutral',
};

interface BookingBar {
  date: string;
  count: number;
  /** The axis label, pre-formatted so the tick renderer stays a pure lookup. */
  label: string;
}

export default function AdminOverviewPage(): JSX.Element {
  const chart = useChartTheme();
  const axis = useAxisStyle(chart);

  /*
   * The operator's own clock, not a workspace's.
   *
   * Every other surface in MeetFlow renders in the workspace timezone, because
   * a 9am appointment means 9am where the clinic is. Here that would be the
   * wrong answer: an operator scanning the whole platform needs one consistent
   * clock to compare fifty workspaces against, not fifty clocks. `useAuth().user`
   * carries no timezone field, so the browser's zone is the only honest choice.
   */
  const zone = useMemo(() => browserTimezone(), []);

  const overview = useQuery({
    queryKey: adminKeys.overview(),
    queryFn: fetchAdminOverview,
  });

  const data: AdminOverview | undefined = overview.data;

  /*
   * `bookingsByDay` buckets are **UTC** calendar days, not instants, so they are
   * formatted in UTC as well. Reading them in the operator's zone would shift
   * every label by a day for anyone west of Greenwich and silently mislabel the
   * whole series — the one place on this page where the local clock is wrong.
   */
  const bookingBars = useMemo<BookingBar[]>(
    () =>
      (data?.bookingsByDay ?? []).map((bucket) => ({
        ...bucket,
        label: formatDate(bucket.date, 'UTC'),
      })),
    [data?.bookingsByDay],
  );

  const topWorkspaces = data?.topWorkspaces ?? [];
  const bookingWindowDays = bookingBars.length;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Workspaces, accounts and booking volume across the whole platform, counted live."
        actions={
          data ? (
            <p className="text-xs text-fg-muted">
              Counted {formatRelative(data.generatedAt, zone)}
            </p>
          ) : null
        }
      />

      {overview.isError ? (
        <Card>
          <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
        </Card>
      ) : (
        <>
          <StatTileGrid>
            <StatTile
              label="Workspaces"
              value={formatNumber(data?.workspaces.total ?? 0)}
              icon={Building2}
              isLoading={overview.isPending}
              detail={
                data
                  ? `${formatNumber(data.workspaces.active)} active · ${formatNumber(
                      data.workspaces.suspended,
                    )} suspended`
                  : undefined
              }
              /*
               * Amber only when something is actually suspended. A tile that is
               * permanently orange for a perfectly normal state teaches people
               * to stop seeing the colour, and then it cannot warn them.
               */
              tone={(data?.workspaces.suspended ?? 0) > 0 ? 'attention' : 'default'}
              /*
               * Withheld until the response is in hand, rather than defaulted to
               * zero. StatTile shows a skeleton in place of an unknown figure for
               * exactly this reason, and a caption reading "0 archived" beneath
               * that skeleton would put the fabricated number straight back —
               * stated as fact, in the one place the tile is not hedging.
               */
              caption={data ? `${formatNumber(data.workspaces.archived)} archived` : undefined}
            />
            <StatTile
              label="People"
              value={formatNumber(data?.users.total ?? 0)}
              icon={UsersRound}
              isLoading={overview.isPending}
              detail={data ? `${formatNumber(data.users.admins)} platform admins` : undefined}
              caption={
                data
                  ? `${formatNumber(data.users.active)} active · ${formatNumber(
                      data.users.invited,
                    )} invited · ${formatNumber(
                      data.users.suspended + data.users.deactivated,
                    )} suspended or deactivated`
                  : undefined
              }
            />
            <StatTile
              label={`Bookings, ${WINDOW_DAYS} days`}
              value={formatNumber(data?.appointments.last30Days ?? 0)}
              icon={CalendarCheck2}
              isLoading={overview.isPending}
              detail={
                data
                  ? `${formatNumber(data.appointments.cancelledLast30Days)} cancelled`
                  : undefined
              }
              caption={`Placed across every workspace in the last ${WINDOW_DAYS} days`}
            />
            <StatTile
              label="Customers"
              value={formatNumber(data?.customers.total ?? 0)}
              icon={Contact}
              isLoading={overview.isPending}
              caption="A count only — the admin API exposes no customer record"
            />
          </StatTileGrid>

          <div className="grid gap-4 xl:grid-cols-3">
            <ChartFrame
              className="xl:col-span-2"
              title="Bookings per day"
              description={
                bookingWindowDays > 0
                  ? `The last ${bookingWindowDays} days, counted in UTC days.`
                  : 'Counted in UTC days.'
              }
              height={260}
              isLoading={overview.isPending}
              error={overview.error}
              onRetry={() => void overview.refetch()}
              isEmpty={bookingBars.every((bar) => bar.count === 0)}
              emptyMessage="No booking was placed anywhere on the platform in this window, so there is no trend to draw yet."
              summary={`Bookings placed per day over the last ${bookingWindowDays} days, across every workspace.`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={bookingBars} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
                  <CartesianGrid stroke={chart.grid} strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={axis.tick}
                    tickLine={false}
                    axisLine={axis.line}
                    // Fourteen full dates will not fit on a phone, so ticks are
                    // thinned rather than truncated: a half-printed date is
                    // worse than a missing one.
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
                    cursor={{ fill: chart.grid, fillOpacity: 0.35 }}
                    content={<ChartTooltip formatValue={(value) => formatNumber(value)} />}
                  />
                  <Bar
                    dataKey="count"
                    name="Bookings"
                    fill={seriesColour(chart, 0)}
                    radius={[4, 4, 0, 0]}
                    maxBarSize={28}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartFrame>

            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader
                  as="h2"
                  title={`New in the last ${WINDOW_DAYS} days`}
                  description="What the platform gained, not what it holds."
                />
                <CardBody className="flex flex-col gap-3">
                  <FigureRow
                    label="Workspaces created"
                    value={data?.workspaces.createdLast30Days}
                    isLoading={overview.isPending}
                  />
                  <FigureRow
                    label="Accounts created"
                    value={data?.users.createdLast30Days}
                    isLoading={overview.isPending}
                  />
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  as="h2"
                  title="In the diary"
                  description="Every workspace's bookings together."
                />
                <CardBody className="flex flex-col gap-3">
                  <FigureRow
                    label="Still to happen"
                    value={data?.appointments.upcoming}
                    isLoading={overview.isPending}
                  />
                  <FigureRow
                    label="Booked all time"
                    value={data?.appointments.total}
                    isLoading={overview.isPending}
                  />
                </CardBody>
              </Card>
            </div>
          </div>

          <Card>
            <CardHeader
              as="h2"
              title="Busiest workspaces"
              description={`The five workspaces that took the most bookings in the last ${WINDOW_DAYS} days. Suspended and archived workspaces are included — one that was busy right up to the moment it was suspended is exactly what is worth seeing.`}
            />
            <DataState
              isPending={overview.isPending}
              isError={overview.isError}
              error={overview.error}
              onRetry={() => void overview.refetch()}
              isEmpty={topWorkspaces.length === 0}
              rows={5}
              columns={3}
              empty={
                <EmptyState
                  icon={<Building2 className="size-6" aria-hidden="true" />}
                  title="No workspaces yet"
                  description="Nothing has been created on this platform, so there is nothing to rank."
                />
              }
            >
              <TableContainer>
                <Table
                  caption={`The five workspaces with the most bookings in the last ${WINDOW_DAYS} days.`}
                >
                  <THead>
                    <Tr>
                      <Th>Workspace</Th>
                      <Th>Status</Th>
                      <Th align="right">Bookings</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {topWorkspaces.map((workspace) => (
                      <Tr key={workspace.businessId}>
                        <Td>
                          <Link
                            to={`/admin/workspaces/${workspace.businessId}`}
                            className="rounded-xs font-medium text-fg underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                          >
                            {workspace.name}
                          </Link>
                          <span className="block truncate text-xs text-fg-muted">
                            /{workspace.slug}
                          </span>
                        </Td>
                        <Td>
                          <Badge tone={WORKSPACE_STATUS_TONES[workspace.status]} dot>
                            {humanizeEnum(workspace.status)}
                          </Badge>
                        </Td>
                        <Td numeric className="font-medium text-fg">
                          {formatNumber(workspace.appointmentsLast30Days)}
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </TableContainer>
            </DataState>
          </Card>
        </>
      )}
    </>
  );
}

/**
 * One labelled figure in a two-line card.
 *
 * Shows a dash rather than a zero while the request is in flight, for the same
 * reason `StatTile` shows a skeleton: a zero that turns out to have been a
 * loading state is the most damaging thing a dashboard can print, and "no
 * workspaces were created this month" is a real finding somebody might act on.
 */
function FigureRow({
  label,
  value,
  isLoading,
}: {
  label: string;
  value: number | undefined;
  isLoading: boolean;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-sm text-fg-secondary">{label}</span>
      <span className="text-lg font-semibold tabular-nums text-fg">
        {isLoading || value === undefined ? '—' : formatNumber(value)}
      </span>
    </div>
  );
}
