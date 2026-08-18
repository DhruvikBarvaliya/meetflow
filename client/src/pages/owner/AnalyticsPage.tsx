import { useQuery } from '@tanstack/react-query';
import {
  BadgeCheck,
  CalendarCheck2,
  Download,
  IndianRupee,
  Repeat,
  TrendingUp,
  UserMinus,
  UserPlus,
  XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
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
import { PageHeader } from '@/components/layout';
import {
  ChartFrame,
  ChartTooltip,
  DataState,
  FilterBar,
  FilterField,
  RangeControl,
  StatTile,
  StatTileGrid,
  defaultRange,
  filterOptions,
  ownerKeys,
  rangeSpanDays,
  seriesColour,
  toSearchParams,
  useAxisStyle,
  useChartTheme,
  useCsvExport,
  useLocationsLookup,
  useStaffLookup,
  MAX_RANGE_DAYS,
  type CustomerAnalytics,
  type DateRange,
  type LocationPerformance,
  type PeakTimeBucket,
  type ServicePerformance,
  type StaffPerformance,
  type TrendBucket,
} from '@/components/owner';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Select,
  TBody,
  THead,
  Table,
  TableContainer,
  Td,
  Th,
  Tr,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/apiClient';
import { cn } from '@/lib/cn';
import {
  formatDate,
  formatDuration,
  formatMinuteOfDay,
  formatMoney,
  formatMoneyCompact,
  formatNumber,
  formatRatioAsPercent,
} from '@/lib/format';
import { PERMISSIONS } from '@/lib/permissions';
import type { AnalyticsOverview } from '@/types/api';

/** Sunday = 0, matching the API's `weekday` field. */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Only the hours a workspace plausibly trades in; the rest is empty grid. */
const HEATMAP_HOURS = Array.from({ length: 17 }, (_, index) => index + 6);

/** Recharts leaves no room for a rotated label unless the axis is told. */
const CATEGORY_AXIS_WIDTH = 132;

function useAnalytics<T>(panel: string, scope: Record<string, string | undefined>) {
  const { activeBusinessId, can } = useAuth();
  return useQuery({
    queryKey: ownerKeys.analytics(activeBusinessId, panel, scope),
    queryFn: () => api.get<T>(`/analytics/${panel}${toSearchParams(scope)}`),
    enabled:
      can(PERMISSIONS.ANALYTICS_READ) &&
      scope.from !== undefined &&
      scope.to !== undefined &&
      scope.from !== '' &&
      scope.to !== '',
  });
}

// ---------------------------------------------------------------------------

export default function AnalyticsPage(): JSX.Element {
  const { activeTimezone, can } = useAuth();
  const staff = useStaffLookup();
  const locations = useLocationsLookup();
  const chart = useChartTheme();
  const axis = useAxisStyle(chart);
  const csv = useCsvExport();

  const [range, setRange] = useState<DateRange>(() => defaultRange(activeTimezone, '30d'));
  const [locationId, setLocationId] = useState('');
  const [staffProfileId, setStaffProfileId] = useState('');

  const span = rangeSpanDays(range);
  const withinCap = span >= 1 && span <= MAX_RANGE_DAYS;

  const scope = useMemo(
    () => ({
      from: withinCap ? range.from : undefined,
      to: withinCap ? range.to : undefined,
      locationId: locationId === '' ? undefined : locationId,
      staffProfileId: staffProfileId === '' ? undefined : staffProfileId,
    }),
    [range, locationId, staffProfileId, withinCap],
  );

  const overview = useAnalytics<AnalyticsOverview>('overview', scope);
  const trends = useAnalytics<TrendBucket[]>('trends', scope);
  const staffPerformance = useAnalytics<StaffPerformance[]>('staff', scope);
  const servicePerformance = useAnalytics<ServicePerformance[]>('services', scope);
  const locationPerformance = useAnalytics<LocationPerformance[]>('locations', scope);
  const peakTimes = useAnalytics<PeakTimeBucket[]>('peak-times', scope);
  const customers = useAnalytics<CustomerAnalytics>('customers', scope);

  const currency = overview.data?.currency ?? 'INR';

  const trendData = useMemo(
    () =>
      (trends.data ?? []).map((bucket) => ({
        ...bucket,
        label: formatDate(bucket.date, activeTimezone),
      })),
    [trends.data, activeTimezone],
  );

  /** The heatmap needs a value for every cell; the API returns only what happened. */
  const peakGrid = useMemo(() => {
    const map = new Map<string, number>();
    let busiest = 0;
    for (const bucket of peakTimes.data ?? []) {
      map.set(`${bucket.weekday}-${bucket.hour}`, bucket.bookings);
      busiest = Math.max(busiest, bucket.bookings);
    }
    return { map, busiest };
  }, [peakTimes.data]);

  const exportCsv = (): void => {
    void csv.download(
      `/reports/appointments.csv${toSearchParams({
        from: range.from,
        to: range.to,
        locationId: locationId === '' ? undefined : locationId,
        staffProfileId: staffProfileId === '' ? undefined : staffProfileId,
      })}`,
      `appointments-${range.from}-to-${range.to}.csv`,
    );
  };

  const trendSeries = [
    { key: 'bookings', label: 'Booked', colour: seriesColour(chart, 0) },
    { key: 'completed', label: 'Completed', colour: seriesColour(chart, 1) },
    { key: 'cancelled', label: 'Cancelled', colour: seriesColour(chart, 2) },
  ];

  return (
    <>
      <PageHeader
        title="Analytics"
        description={`Every figure here is counted in ${activeTimezone}, the workspace clock, over the period you choose.`}
        actions={
          can(PERMISSIONS.REPORTS_EXPORT) ? (
            <Button
              variant="secondary"
              onClick={exportCsv}
              loading={csv.isExporting}
              disabled={!withinCap}
              leadingIcon={<Download className="size-4" aria-hidden="true" />}
            >
              Export CSV
            </Button>
          ) : null
        }
      >
        <div className="flex flex-col gap-4">
          <RangeControl
            value={range}
            onChange={setRange}
            timezone={activeTimezone}
            hint={`windows are capped at ${MAX_RANGE_DAYS} days`}
          />
          <FilterBar>
            <FilterField label="Location">
              {({ id }) => (
                <Select
                  id={id}
                  selectSize="sm"
                  value={locationId}
                  onChange={(event) => setLocationId(event.target.value)}
                  options={filterOptions(locations.items, 'Every location', (location) => ({
                    value: location.id,
                    label: location.name,
                  }))}
                />
              )}
            </FilterField>
            <FilterField label="Provider">
              {({ id }) => (
                <Select
                  id={id}
                  selectSize="sm"
                  value={staffProfileId}
                  onChange={(event) => setStaffProfileId(event.target.value)}
                  options={filterOptions(staff.items, 'Everyone', (profile) => ({
                    value: profile.id,
                    label: profile.displayName,
                  }))}
                />
              )}
            </FilterField>
          </FilterBar>
        </div>
      </PageHeader>

      {!withinCap ? (
        <Card>
          <EmptyState
            title="Choose a shorter period"
            description={`This window covers ${span} days. The API aggregates at most ${MAX_RANGE_DAYS} days at a time, so nothing is requested until the range fits.`}
            action={
              <Button
                variant="secondary"
                onClick={() => setRange(defaultRange(activeTimezone, '30d'))}
              >
                Back to the last 30 days
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <StatTileGrid>
            <StatTile
              label="Bookings"
              value={formatNumber(overview.data?.totalBookings ?? 0)}
              icon={CalendarCheck2}
              isLoading={overview.isPending}
              caption={`${formatNumber(overview.data?.confirmed ?? 0)} still to happen`}
            />
            <StatTile
              label="Completed"
              value={formatNumber(overview.data?.completed ?? 0)}
              icon={BadgeCheck}
              tone="positive"
              isLoading={overview.isPending}
              caption={`Average length ${formatDuration(overview.data?.averageDurationMinutes ?? 0)}`}
            />
            <StatTile
              label="Cancelled"
              value={formatNumber(overview.data?.cancelled ?? 0)}
              detail={formatRatioAsPercent(overview.data?.cancellationRate ?? 0)}
              icon={XCircle}
              tone={(overview.data?.cancellationRate ?? 0) > 0.2 ? 'negative' : 'default'}
              isLoading={overview.isPending}
              caption="of every booking in the period"
            />
            <StatTile
              label="No-shows"
              value={formatNumber(overview.data?.noShows ?? 0)}
              detail={formatRatioAsPercent(overview.data?.noShowRate ?? 0)}
              icon={UserMinus}
              tone={(overview.data?.noShowRate ?? 0) > 0.1 ? 'negative' : 'default'}
              isLoading={overview.isPending}
              caption="of everything that was due to happen"
            />
            <StatTile
              label="Revenue"
              value={formatMoneyCompact(overview.data?.revenueAmount ?? 0, currency)}
              icon={IndianRupee}
              isLoading={overview.isPending}
              caption="Completed appointments only"
            />
            <StatTile
              label="New customers"
              value={formatNumber(overview.data?.newCustomers ?? 0)}
              icon={UserPlus}
              isLoading={overview.isPending}
              caption={`${formatNumber(overview.data?.returningCustomers ?? 0)} returning`}
            />
            <StatTile
              label="Reschedules"
              value={formatNumber(overview.data?.reschedules ?? 0)}
              icon={Repeat}
              isLoading={overview.isPending}
              caption="Appointments moved at least once"
            />
            <StatTile
              label="Lead time"
              value={formatDuration((overview.data?.averageLeadTimeHours ?? 0) * 60)}
              icon={TrendingUp}
              isLoading={overview.isPending}
              caption="Average gap between booking and appointment"
            />
          </StatTileGrid>

          <div className="grid gap-4 xl:grid-cols-2">
            <ChartFrame
              title="Booking trend"
              description="Bookings placed, completed and cancelled, by day."
              isLoading={trends.isPending}
              error={trends.error}
              onRetry={() => void trends.refetch()}
              isEmpty={trendData.every((bucket) => bucket.bookings === 0)}
              emptyMessage="Nothing was booked in this period, so there is no trend to draw."
              legend={trendSeries.map((series) => ({
                label: series.label,
                colour: series.colour,
              }))}
              summary={`Daily bookings from ${range.from} to ${range.to}.`}
              className="xl:col-span-2"
              height={280}
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trendData} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
                  <CartesianGrid stroke={chart.grid} strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={axis.tick}
                    tickLine={false}
                    axisLine={axis.line}
                    minTickGap={24}
                  />
                  <YAxis
                    tick={axis.tick}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                    width={40}
                  />
                  <Tooltip
                    cursor={{ stroke: chart.grid }}
                    content={<ChartTooltip formatValue={(value) => formatNumber(value)} />}
                  />
                  {trendSeries.map((series) => (
                    <Line
                      key={series.key}
                      type="monotone"
                      dataKey={series.key}
                      name={series.label}
                      stroke={series.colour}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, strokeWidth: 2, stroke: chart.surface }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </ChartFrame>

            <ChartFrame
              title="Revenue by day"
              description="Taken from completed appointments, in the workspace currency."
              isLoading={trends.isPending}
              error={trends.error}
              onRetry={() => void trends.refetch()}
              isEmpty={trendData.every((bucket) => bucket.revenue === 0)}
              emptyMessage="No completed appointment carried a price in this period."
              summary={`Daily revenue from ${range.from} to ${range.to}.`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendData} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
                  <defs>
                    <linearGradient id="mf-revenue-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={seriesColour(chart, 0)} stopOpacity={0.28} />
                      <stop offset="100%" stopColor={seriesColour(chart, 0)} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={chart.grid} strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={axis.tick}
                    tickLine={false}
                    axisLine={axis.line}
                    minTickGap={24}
                  />
                  <YAxis
                    tick={axis.tick}
                    tickLine={false}
                    axisLine={false}
                    width={64}
                    tickFormatter={(value: number) => formatMoneyCompact(value, currency)}
                  />
                  <Tooltip
                    cursor={{ stroke: chart.grid }}
                    content={<ChartTooltip formatValue={(value) => formatMoney(value, currency)} />}
                  />
                  <Area
                    type="monotone"
                    dataKey="revenue"
                    name="Revenue"
                    stroke={seriesColour(chart, 0)}
                    strokeWidth={2}
                    fill="url(#mf-revenue-fill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </ChartFrame>

            <ChartFrame
              title="Service performance"
              description="Bookings per service over the period."
              isLoading={servicePerformance.isPending}
              error={servicePerformance.error}
              onRetry={() => void servicePerformance.refetch()}
              isEmpty={(servicePerformance.data ?? []).length === 0}
              emptyMessage="No service was booked in this period."
              summary="Bookings per service."
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  layout="vertical"
                  data={servicePerformance.data ?? []}
                  margin={{ top: 4, right: 16, bottom: 4, left: 0 }}
                  barCategoryGap="28%"
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
                    width={CATEGORY_AXIS_WIDTH}
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
                    maxBarSize={22}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartFrame>
          </div>

          <Card>
            <CardHeader
              as="h2"
              title="Staff workload"
              description="Utilisation is booked minutes against the hours each person was actually rostered."
            />
            <DataState
              isPending={staffPerformance.isPending}
              isError={staffPerformance.isError}
              error={staffPerformance.error}
              onRetry={() => void staffPerformance.refetch()}
              isEmpty={(staffPerformance.data ?? []).length === 0}
              columns={6}
              empty={
                <EmptyState
                  title="No provider took a booking"
                  description="Nobody has appointments in this period, so there is no workload to compare."
                />
              }
            >
              <TableContainer>
                <Table caption="Staff performance over the selected period">
                  <THead>
                    <Tr>
                      <Th>Provider</Th>
                      <Th align="right">Appointments</Th>
                      <Th align="right">Completed</Th>
                      <Th align="right">No-shows</Th>
                      <Th>Utilisation</Th>
                      <Th align="right">Revenue</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {(staffPerformance.data ?? []).map((row, index) => (
                      <Tr key={row.staffProfileId}>
                        <Td>
                          <span className="flex items-center gap-2">
                            <span
                              aria-hidden="true"
                              className="size-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: seriesColour(chart, index) }}
                            />
                            <span className="font-medium text-fg">{row.displayName}</span>
                          </span>
                        </Td>
                        <Td numeric>{formatNumber(row.appointments)}</Td>
                        <Td numeric>{formatNumber(row.completed)}</Td>
                        <Td numeric>
                          <span className={row.noShows > 0 ? 'text-danger-text' : undefined}>
                            {formatNumber(row.noShows)}
                          </span>
                        </Td>
                        <Td>
                          <div className="flex items-center gap-2">
                            <span
                              className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-sunken"
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
                            <span className="text-sm tabular-nums text-fg-secondary">
                              {formatRatioAsPercent(row.utilisationRate)}
                            </span>
                          </div>
                          <span className="mf-sr-only">
                            {formatDuration(row.bookedMinutes)} booked of{' '}
                            {formatDuration(row.workingMinutes)} rostered
                          </span>
                        </Td>
                        <Td numeric>{formatMoney(row.revenue, currency)}</Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </TableContainer>
            </DataState>
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            <ChartFrame
              title="Location utilisation"
              description="Booked minutes against each site's opening hours."
              isLoading={locationPerformance.isPending}
              error={locationPerformance.error}
              onRetry={() => void locationPerformance.refetch()}
              isEmpty={(locationPerformance.data ?? []).length === 0}
              emptyMessage="No location took a booking in this period."
              summary="Utilisation per location."
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  layout="vertical"
                  data={locationPerformance.data ?? []}
                  margin={{ top: 4, right: 16, bottom: 4, left: 0 }}
                  barCategoryGap="28%"
                >
                  <CartesianGrid stroke={chart.grid} strokeDasharray="3 3" horizontal={false} />
                  <XAxis
                    type="number"
                    tick={axis.tick}
                    tickLine={false}
                    axisLine={axis.line}
                    domain={[0, 1]}
                    tickFormatter={(value: number) => formatRatioAsPercent(value, 0)}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={axis.tick}
                    tickLine={false}
                    axisLine={false}
                    width={CATEGORY_AXIS_WIDTH}
                  />
                  <Tooltip
                    cursor={{ fill: chart.grid, fillOpacity: 0.35 }}
                    content={<ChartTooltip formatValue={(value) => formatRatioAsPercent(value)} />}
                  />
                  <Bar
                    dataKey="utilisationRate"
                    name="Utilisation"
                    fill={seriesColour(chart, 3)}
                    radius={[0, 4, 4, 0]}
                    maxBarSize={22}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartFrame>

            <Card className="flex flex-col">
              <CardHeader
                as="h2"
                title="When customers book"
                description="Bookings by weekday and hour of the local day. Darker means busier."
              />
              <CardBody className="flex-1">
                <DataState
                  isPending={peakTimes.isPending}
                  isError={peakTimes.isError}
                  error={peakTimes.error}
                  onRetry={() => void peakTimes.refetch()}
                  isEmpty={(peakTimes.data ?? []).length === 0}
                  rows={3}
                  columns={7}
                  empty={
                    <EmptyState
                      title="No pattern yet"
                      description="Nothing was booked in this period, so there is no busy hour to find."
                    />
                  }
                >
                  <div className="mf-scroll-x">
                    <table className="w-full min-w-[34rem] border-separate border-spacing-0.5">
                      <caption className="mf-sr-only">
                        Bookings by weekday and hour, in {activeTimezone}
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col" className="w-10">
                            <span className="mf-sr-only">Weekday</span>
                          </th>
                          {HEATMAP_HOURS.map((hour) => (
                            <th
                              key={hour}
                              scope="col"
                              className="pb-1 text-[0.625rem] font-medium tabular-nums text-fg-muted"
                            >
                              {hour}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {WEEKDAYS.map((label, weekday) => (
                          <tr key={label}>
                            <th
                              scope="row"
                              className="pr-1 text-right text-[0.6875rem] font-medium text-fg-muted"
                            >
                              {label}
                            </th>
                            {HEATMAP_HOURS.map((hour) => {
                              const bookings = peakGrid.map.get(`${weekday}-${hour}`) ?? 0;
                              const ratio =
                                peakGrid.busiest === 0 ? 0 : bookings / peakGrid.busiest;
                              return (
                                <td key={hour} className="p-0">
                                  <span
                                    title={`${label} ${formatMinuteOfDay(hour * 60)} — ${bookings} booking${
                                      bookings === 1 ? '' : 's'
                                    }`}
                                    className={cn(
                                      'block h-6 rounded-xs border border-border',
                                      bookings === 0 && 'bg-surface-sunken',
                                    )}
                                    style={
                                      bookings === 0
                                        ? undefined
                                        : {
                                            backgroundColor:
                                              chart.sequential[
                                                Math.min(
                                                  chart.sequential.length - 1,
                                                  Math.floor(ratio * chart.sequential.length),
                                                )
                                              ],
                                          }
                                    }
                                  >
                                    <span className="mf-sr-only">
                                      {label} {formatMinuteOfDay(hour * 60)}: {bookings} bookings
                                    </span>
                                  </span>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-3 flex items-center gap-2 text-xs text-fg-muted">
                    <span>0</span>
                    <span className="flex gap-0.5" aria-hidden="true">
                      {chart.sequential.map((colour) => (
                        <span
                          key={colour}
                          className="size-3 rounded-xs border border-border"
                          style={{ backgroundColor: colour }}
                        />
                      ))}
                    </span>
                    <span>{formatNumber(peakGrid.busiest)} bookings</span>
                  </div>
                </DataState>
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader
              as="h2"
              title="Customers"
              description={
                customers.data
                  ? `${formatNumber(customers.data.activeCustomers)} people booked in this period; ${formatRatioAsPercent(
                      customers.data.repeatRate,
                    )} of them had booked before.`
                  : 'Who booked, and how often.'
              }
            />
            <DataState
              isPending={customers.isPending}
              isError={customers.isError}
              error={customers.error}
              onRetry={() => void customers.refetch()}
              isEmpty={(customers.data?.topCustomers ?? []).length === 0}
              columns={4}
              empty={
                <EmptyState
                  title="Nobody booked in this period"
                  description="Widen the window, or share a booking link to start filling the diary."
                />
              }
            >
              <TableContainer>
                <Table caption="Customers with the most appointments in this period">
                  <THead>
                    <Tr>
                      <Th>Customer</Th>
                      <Th align="right">Appointments</Th>
                      <Th align="right">Attended</Th>
                      <Th align="right">Revenue</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {(customers.data?.topCustomers ?? []).map((row) => (
                      <Tr key={row.customerId}>
                        <Td>
                          <span className="font-medium text-fg">{row.name}</span>
                        </Td>
                        <Td numeric>{formatNumber(row.appointments)}</Td>
                        <Td numeric>{formatNumber(row.completed)}</Td>
                        <Td numeric>{formatMoney(row.revenue, currency)}</Td>
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
