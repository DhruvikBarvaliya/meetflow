import { useQuery } from '@tanstack/react-query';
import { Download, FileSpreadsheet } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/layout';
import {
  AppointmentStatusBadge,
  DataState,
  FilterBar,
  FilterField,
  MAX_RANGE_DAYS,
  RangeControl,
  defaultRange,
  filterOptions,
  ownerKeys,
  rangeSpanDays,
  toSearchParams,
  useCsvExport,
  useLocationsLookup,
  useServicesLookup,
  useStaffLookup,
  type AppointmentReportRow,
  type DateRange,
} from '@/components/owner';
import {
  Button,
  Card,
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
import { formatDuration, formatMoney, formatNumber, humanizeEnum } from '@/lib/format';
import { PERMISSIONS } from '@/lib/permissions';
import { APPOINTMENT_STATUSES } from '@/types/api';

const PAGE_SIZE = 50;

/**
 * The appointment ledger.
 *
 * Where Analytics aggregates, this lists: one row per appointment, with the
 * columns a bookkeeper or an auditor asks for. It is the same query behind both
 * the table and the CSV — an export that could not reproduce what is on screen
 * would be worse than no export at all.
 *
 * The API's `startsAtLocal` column is rendered by the server in the workspace's
 * own zone and carries the zone name with it, so the times here need no
 * conversion and cannot be misread.
 */
export default function ReportsPage(): JSX.Element {
  const { activeBusinessId, activeTimezone, can } = useAuth();
  const staff = useStaffLookup();
  const services = useServicesLookup();
  const locations = useLocationsLookup();
  const csv = useCsvExport();

  const [page, setPage] = useState(1);
  const [range, setRange] = useState<DateRange>(() => defaultRange(activeTimezone, '30d'));
  const [status, setStatus] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [staffProfileId, setStaffProfileId] = useState('');
  const [locationId, setLocationId] = useState('');

  const span = rangeSpanDays(range);
  const withinCap = span >= 1 && span <= MAX_RANGE_DAYS;

  const filters = {
    from: range.from,
    to: range.to,
    status: status === '' ? undefined : status,
    serviceId: serviceId === '' ? undefined : serviceId,
    staffProfileId: staffProfileId === '' ? undefined : staffProfileId,
    locationId: locationId === '' ? undefined : locationId,
  };

  const scope = { ...filters, page, pageSize: PAGE_SIZE };

  const reportQuery = useQuery({
    queryKey: ownerKeys.reportAppointments(activeBusinessId, scope),
    queryFn: () =>
      api.getPage<AppointmentReportRow>(`/reports/appointments${toSearchParams(scope)}`),
    enabled: withinCap,
  });

  const rows = reportQuery.data?.items ?? [];

  const exportCsv = (): void => {
    void csv.download(
      `/reports/appointments.csv${toSearchParams(filters)}`,
      `appointments-${range.from}-to-${range.to}.csv`,
    );
  };

  return (
    <>
      <PageHeader
        title="Reports"
        description="Every appointment in the period, as a list. Export it to a spreadsheet when you need to work on it elsewhere."
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
            onChange={(next) => {
              setRange(next);
              setPage(1);
            }}
            timezone={activeTimezone}
            hint={`windows are capped at ${MAX_RANGE_DAYS} days`}
          />

          <FilterBar>
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
                  options={[
                    { value: '', label: 'Every status' },
                    ...APPOINTMENT_STATUSES.map((entry) => ({
                      value: entry,
                      label: entry === 'NO_SHOW' ? 'No-show' : humanizeEnum(entry),
                    })),
                  ]}
                />
              )}
            </FilterField>
            <FilterField label="Service">
              {({ id }) => (
                <Select
                  id={id}
                  selectSize="sm"
                  value={serviceId}
                  onChange={(event) => {
                    setServiceId(event.target.value);
                    setPage(1);
                  }}
                  options={filterOptions(services.items, 'Every service', (service) => ({
                    value: service.id,
                    label: service.name,
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
                  onChange={(event) => {
                    setStaffProfileId(event.target.value);
                    setPage(1);
                  }}
                  options={filterOptions(staff.items, 'Everyone', (profile) => ({
                    value: profile.id,
                    label: profile.displayName,
                  }))}
                />
              )}
            </FilterField>
            <FilterField label="Location">
              {({ id }) => (
                <Select
                  id={id}
                  selectSize="sm"
                  value={locationId}
                  onChange={(event) => {
                    setLocationId(event.target.value);
                    setPage(1);
                  }}
                  options={filterOptions(locations.items, 'Everywhere', (location) => ({
                    value: location.id,
                    label: location.name,
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
            icon={<FileSpreadsheet className="size-6" aria-hidden="true" />}
            title="Choose a shorter period"
            description={`This window covers ${span} days, and a report may span at most ${MAX_RANGE_DAYS}. Nothing is requested until it fits.`}
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
        <Card>
          <DataState
            isPending={reportQuery.isPending}
            isError={reportQuery.isError}
            error={reportQuery.error}
            onRetry={() => void reportQuery.refetch()}
            isEmpty={rows.length === 0}
            columns={7}
            rows={8}
            empty={
              <EmptyState
                icon={<FileSpreadsheet className="size-6" aria-hidden="true" />}
                title="No appointment matches"
                description="Nothing in this period matches the filters you have set. Widen the window, or clear a filter."
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setStatus('');
                      setServiceId('');
                      setStaffProfileId('');
                      setLocationId('');
                      setPage(1);
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            }
          >
            <TableContainer>
              <Table caption={`Appointments between ${range.from} and ${range.to}`}>
                <THead>
                  <Tr>
                    <Th>Reference</Th>
                    <Th>Local start</Th>
                    <Th>Customer</Th>
                    <Th>Service</Th>
                    <Th>Provider</Th>
                    <Th>Status</Th>
                    <Th align="right">Price</Th>
                  </Tr>
                </THead>
                <TBody>
                  {rows.map((row) => (
                    <Tr key={row.bookingReference}>
                      <Td>
                        <span className="font-mono text-xs text-fg-secondary">
                          {row.bookingReference}
                        </span>
                      </Td>
                      <Td>
                        <span className="block tabular-nums text-fg">{row.startsAtLocal}</span>
                        <span className="block text-xs text-fg-muted">
                          {row.timezone} · {formatDuration(row.durationMinutes)}
                          {row.rescheduleCount > 0
                            ? ` · moved ${formatNumber(row.rescheduleCount)}×`
                            : ''}
                        </span>
                      </Td>
                      <Td>
                        <span className="block text-fg">{row.customerName ?? '—'}</span>
                        {row.customerEmail ? (
                          <span className="block truncate text-xs text-fg-muted">
                            {row.customerEmail}
                          </span>
                        ) : null}
                      </Td>
                      <Td>{row.service ?? '—'}</Td>
                      <Td>{row.staff ?? '—'}</Td>
                      <Td>
                        <AppointmentStatusBadge status={row.status} />
                        {row.cancellationReason ? (
                          <span className="mt-1 block max-w-xs truncate text-xs text-fg-muted">
                            {row.cancellationReason}
                          </span>
                        ) : null}
                      </Td>
                      <Td numeric>{formatMoney(row.priceAmount, row.currency)}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </TableContainer>

            {reportQuery.data ? (
              <Pagination
                meta={reportQuery.data.meta}
                onPageChange={setPage}
                itemLabel="appointments"
              />
            ) : null}
          </DataState>
        </Card>
      )}
    </>
  );
}
