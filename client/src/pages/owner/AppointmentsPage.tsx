import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarX2 } from 'lucide-react';
import { DateTime } from 'luxon';
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/layout';
import {
  APPOINTMENT_EVENTS,
  AppointmentActions,
  AppointmentDetailDrawer,
  AppointmentStatusBadge,
  DataState,
  FilterBar,
  FilterField,
  RescheduleDialog,
  SearchField,
  filterOptions,
  ownerKeys,
  toSearchParams,
  useDebouncedValue,
  useLiveRefresh,
  useLocationsLookup,
  useServicesLookup,
  useStaffLookup,
  type RescheduleTarget,
} from '@/components/owner';
import {
  Button,
  Card,
  DatePicker,
  EmptyState,
  Pagination,
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
import { formatDayLabel, formatDuration, formatMoney, formatTime } from '@/lib/format';
import { APPOINTMENT_STATUSES, type Appointment } from '@/types/api';

const PAGE_SIZE = 20;

const STATUS_OPTIONS = [
  { value: '', label: 'Every status' },
  ...APPOINTMENT_STATUSES.map((status) => ({
    value: status,
    label:
      status === 'NO_SHOW'
        ? 'No-show'
        : status.charAt(0) + status.slice(1).toLowerCase().replace('_', ' '),
  })),
];

/**
 * The diary as a table: every booking, filtered, with the same lifecycle
 * actions the calendar offers.
 *
 * `from` and `to` bound a *window*, not a start time — an appointment that
 * began before the window and is still running belongs in it, which is what the
 * server's overlap test implements and what an operator expects when they ask
 * "what is on today".
 */
export default function AppointmentsPage(): JSX.Element {
  const { activeBusinessId, activeTimezone } = useAuth();
  const queryClient = useQueryClient();
  const staff = useStaffLookup();
  const services = useServicesLookup();
  const locations = useLocationsLookup();

  // Deep-linkable so the dashboard's quick actions and the customer drawer can
  // point at a pre-filtered diary rather than "the diary, now go and filter it".
  const [searchParams, setSearchParams] = useSearchParams();

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>(searchParams.get('status') ?? '');
  const [staffFilter, setStaffFilter] = useState(searchParams.get('staff') ?? '');
  const [serviceFilter, setServiceFilter] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [fromDate, setFromDate] = useState(searchParams.get('from') ?? '');
  const [toDate, setToDate] = useState(searchParams.get('to') ?? '');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState<RescheduleTarget | null>(null);

  const debouncedSearch = useDebouncedValue(search);

  /** A date-only filter becomes the whole local day, in the workspace's clock. */
  const windowInstants = useMemo(() => {
    const start = fromDate
      ? DateTime.fromISO(fromDate, { zone: activeTimezone }).startOf('day').toISO()
      : undefined;
    const end = toDate
      ? DateTime.fromISO(toDate, { zone: activeTimezone }).endOf('day').toISO()
      : undefined;
    return { from: start ?? undefined, to: end ?? undefined };
  }, [fromDate, toDate, activeTimezone]);

  const scope = {
    page,
    pageSize: PAGE_SIZE,
    status: status === '' ? undefined : status,
    staffProfileId: staffFilter === '' ? undefined : staffFilter,
    serviceId: serviceFilter === '' ? undefined : serviceFilter,
    locationId: locationFilter === '' ? undefined : locationFilter,
    from: windowInstants.from,
    to: windowInstants.to,
    q: debouncedSearch === '' ? undefined : debouncedSearch,
  };

  const listQuery = useQuery({
    queryKey: ownerKeys.appointments(activeBusinessId, scope),
    queryFn: () => api.getPage<Appointment>(`/appointments${toSearchParams(scope)}`),
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: [...ownerKeys.root(activeBusinessId), 'appointments'],
    });
  }, [queryClient, activeBusinessId]);

  useLiveRefresh({ events: APPOINTMENT_EVENTS, onRefresh: refresh });

  const clearFilters = (): void => {
    setStatus('');
    setStaffFilter('');
    setServiceFilter('');
    setLocationFilter('');
    setFromDate('');
    setToDate('');
    setSearch('');
    setPage(1);
    setSearchParams({}, { replace: true });
  };

  const hasFilters =
    status !== '' ||
    staffFilter !== '' ||
    serviceFilter !== '' ||
    locationFilter !== '' ||
    fromDate !== '' ||
    toDate !== '' ||
    search !== '';

  const items = listQuery.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Appointments"
        description={`Every booking in this workspace. Times are shown in ${activeTimezone}, the clock the diary is kept in.`}
        actions={
          hasFilters ? (
            <Button variant="secondary" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null
        }
      >
        <FilterBar>
          <SearchField
            label="Search"
            value={search}
            placeholder="Reference, title or customer"
            onChange={(value) => {
              setSearch(value);
              setPage(1);
            }}
          />
          <FilterField label="Status">
            {({ id }) => (
              <Select
                id={id}
                selectSize="sm"
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                  setPage(1);
                }}
                options={STATUS_OPTIONS}
              />
            )}
          </FilterField>
          <FilterField label="Provider">
            {({ id }) => (
              <Select
                id={id}
                selectSize="sm"
                value={staffFilter}
                onChange={(event) => {
                  setStaffFilter(event.target.value);
                  setPage(1);
                }}
                options={filterOptions(staff.items, 'Everyone', (profile) => ({
                  value: profile.id,
                  label: profile.displayName,
                }))}
              />
            )}
          </FilterField>
          <FilterField label="Service">
            {({ id }) => (
              <Select
                id={id}
                selectSize="sm"
                value={serviceFilter}
                onChange={(event) => {
                  setServiceFilter(event.target.value);
                  setPage(1);
                }}
                options={filterOptions(services.items, 'Every service', (service) => ({
                  value: service.id,
                  label: service.name,
                }))}
              />
            )}
          </FilterField>
          <FilterField label="Location">
            {({ id }) => (
              <Select
                id={id}
                selectSize="sm"
                value={locationFilter}
                onChange={(event) => {
                  setLocationFilter(event.target.value);
                  setPage(1);
                }}
                options={filterOptions(locations.items, 'Everywhere', (location) => ({
                  value: location.id,
                  label: location.name,
                }))}
              />
            )}
          </FilterField>
          <FilterField label="From">
            {({ id }) => (
              <DatePicker
                id={id}
                value={fromDate === '' ? null : fromDate}
                timezone={activeTimezone}
                max={toDate === '' ? undefined : toDate}
                placeholder="Any date"
                onChange={(value) => {
                  setFromDate(value);
                  setPage(1);
                }}
              />
            )}
          </FilterField>
          <FilterField label="To">
            {({ id }) => (
              <DatePicker
                id={id}
                value={toDate === '' ? null : toDate}
                timezone={activeTimezone}
                min={fromDate === '' ? undefined : fromDate}
                placeholder="Any date"
                onChange={(value) => {
                  setToDate(value);
                  setPage(1);
                }}
              />
            )}
          </FilterField>
        </FilterBar>
      </PageHeader>

      <Card>
        <DataState
          isPending={listQuery.isPending}
          isError={listQuery.isError}
          error={listQuery.error}
          onRetry={() => void listQuery.refetch()}
          isEmpty={items.length === 0}
          columns={6}
          empty={
            <EmptyState
              icon={<CalendarX2 className="size-6" aria-hidden="true" />}
              title={hasFilters ? 'No appointment matches these filters' : 'No appointments yet'}
              description={
                hasFilters
                  ? 'Widen the window or clear a filter — bookings outside the dates you chose are not counted here.'
                  : 'Once a customer books through one of your links, or your team books on their behalf, it appears here.'
              }
              action={
                hasFilters ? (
                  <Button variant="secondary" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : null
              }
            />
          }
        >
          <TableContainer>
            <Table caption="Appointments">
              <THead>
                <Tr>
                  <Th>When</Th>
                  <Th>Customer</Th>
                  <Th>Service</Th>
                  <Th>Provider</Th>
                  <Th>Status</Th>
                  <Th align="right">Price</Th>
                  <Th align="right">
                    <span className="mf-sr-only">Actions</span>
                  </Th>
                </Tr>
              </THead>
              <TBody>
                {items.map((appointment) => (
                  <Tr key={appointment.id} interactive>
                    <Td>
                      <button
                        type="button"
                        onClick={() => setSelectedId(appointment.id)}
                        className="rounded-xs text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                      >
                        <span className="block font-medium text-fg">
                          {formatDayLabel(appointment.startsAt, activeTimezone)}
                        </span>
                        <span className="block text-xs tabular-nums text-fg-muted">
                          {formatTime(appointment.startsAt, activeTimezone)} ·{' '}
                          {formatDuration(appointment.durationMinutes)}
                        </span>
                      </button>
                    </Td>
                    <Td>
                      {appointment.customer ? (
                        <span className="font-medium text-fg">
                          {appointment.customer.firstName} {appointment.customer.lastName}
                        </span>
                      ) : (
                        <span className="text-fg-muted">No customer</span>
                      )}
                    </Td>
                    <Td>{appointment.service?.name ?? '—'}</Td>
                    <Td>{appointment.staffProfile?.displayName ?? 'Unassigned'}</Td>
                    <Td>
                      <AppointmentStatusBadge status={appointment.status} />
                    </Td>
                    <Td numeric>{formatMoney(appointment.priceAmount, appointment.currency)}</Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelectedId(appointment.id)}
                        >
                          Open
                        </Button>
                        <AppointmentActions
                          appointment={appointment}
                          variant="menu"
                          onReschedule={() =>
                            setRescheduling({
                              id: appointment.id,
                              serviceId: appointment.serviceId,
                              serviceName: appointment.service?.name ?? null,
                              staffProfileId: appointment.staffProfileId,
                              locationId: appointment.locationId,
                              startsAt: appointment.startsAt,
                              timezone: appointment.timezone,
                            })
                          }
                          onCompleted={refresh}
                        />
                      </div>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableContainer>

          {listQuery.data ? (
            <Pagination
              meta={listQuery.data.meta}
              onPageChange={setPage}
              itemLabel="appointments"
            />
          ) : null}
        </DataState>
      </Card>

      <AppointmentDetailDrawer
        appointmentId={selectedId}
        open={selectedId !== null}
        onClose={() => setSelectedId(null)}
      />

      <RescheduleDialog
        appointment={rescheduling}
        open={rescheduling !== null}
        onClose={() => setRescheduling(null)}
        onMoved={refresh}
      />
    </>
  );
}
