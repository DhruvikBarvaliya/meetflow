import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, CalendarPlus, Hourglass, Plus, Trash2 } from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/layout';
import {
  DataState,
  FilterBar,
  FilterField,
  SearchField,
  WaitlistStatusBadge,
  filterOptions,
  ownerKeys,
  toSearchParams,
  useDebouncedValue,
  useLocationsLookup,
  useServicesLookup,
  useStaffLookup,
  type AvailabilitySearchResult,
  type AvailableSlot,
  type WaitlistRow,
} from '@/components/owner';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DatePicker,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Pagination,
  Select,
  Skeleton,
  TBody,
  THead,
  Table,
  TableContainer,
  Td,
  Textarea,
  Th,
  Tr,
  useToast,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { api, isApiError } from '@/lib/apiClient';
import { cn } from '@/lib/cn';
import {
  customerName,
  formatDate,
  formatDateLong,
  formatMinuteOfDay,
  formatTime,
} from '@/lib/format';
import { PERMISSIONS } from '@/lib/permissions';
import { FormBanner } from '@/pages/auth/FormBanner';
import type { Customer, WaitlistEntry, WaitlistStatus } from '@/types/api';

const PAGE_SIZE = 20;

type WaitlistListRow = WaitlistEntry & WaitlistRow;

/**
 * Every value here is a `WaitlistStatus` the API will accept as a filter.
 *
 * The list used to offer "Slot held" against a `HELD` status the server has
 * never had; the real state is `NOTIFIED` — the customer has been told about an
 * opening and holds it until `holdExpiresAt` passes.
 */
const STATUS_OPTIONS: Array<{ value: WaitlistStatus | ''; label: string }> = [
  { value: '', label: 'Every status' },
  { value: 'ACTIVE', label: 'Waiting' },
  { value: 'NOTIFIED', label: 'Notified' },
  { value: 'CONVERTED', label: 'Booked' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'EXPIRED', label: 'Expired' },
];

/**
 * The two states a request can still be worked from — waiting, or notified and
 * holding the slot it was offered. A notified entry showed no actions at all
 * while this list named a status the server does not emit.
 */
const ACTIONABLE_STATUSES: readonly WaitlistStatus[] = ['ACTIVE', 'NOTIFIED'];

const DAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function describeDays(daysOfWeek: number[]): string {
  if (daysOfWeek.length === 0) return 'Any day';
  return daysOfWeek
    .slice()
    .sort((a, b) => a - b)
    .map((day) => DAY_INITIALS[day] ?? '?')
    .join(' ');
}

// ---------------------------------------------------------------------------
// Turning a request into a booking
// ---------------------------------------------------------------------------

function ConvertDialog({
  entry,
  open,
  onClose,
  onConverted,
}: {
  entry: WaitlistListRow | null;
  open: boolean;
  onClose: () => void;
  onConverted: () => void;
}): JSX.Element | null {
  const { activeBusinessId, can } = useAuth();
  const { toast } = useToast();
  const [date, setDate] = useState('');
  const [selected, setSelected] = useState<AvailableSlot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const zone = entry?.timezone ?? 'UTC';

  useEffect(() => {
    if (!open || !entry) return;
    // Start inside the window the customer actually asked for; offering them a
    // slot outside it is not converting their request, it is inventing one.
    const today = DateTime.now().setZone(zone).toISODate() ?? entry.earliestDate;
    setDate(today > entry.earliestDate ? today : entry.earliestDate);
    setSelected(null);
    setError(null);
  }, [open, entry, zone]);

  const scope = useMemo(
    () => ({
      serviceId: entry?.serviceId ?? '',
      staffProfileId: entry?.staffProfileId ?? undefined,
      locationId: entry?.locationId ?? undefined,
      fromDate: date,
      toDate: date,
      timezone: zone,
    }),
    [entry, date, zone],
  );

  const slotsQuery = useQuery({
    queryKey: ownerKeys.slots(activeBusinessId, scope),
    queryFn: () =>
      api.get<AvailabilitySearchResult>(`/appointments/availability/slots${toSearchParams(scope)}`),
    enabled: open && entry !== null && date !== '' && can(PERMISSIONS.AVAILABILITY_READ),
    staleTime: 0,
    gcTime: 0,
  });

  const convert = useMutation<unknown, unknown, string>({
    mutationFn: (startsAt) => api.post(`/waitlist/${entry?.id ?? ''}/convert`, { startsAt }),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Booked from the waitlist' });
      onConverted();
      onClose();
    },
    onError: (mutationError) => {
      setError(
        isApiError(mutationError)
          ? mutationError.message
          : 'That time could not be booked. Choose another.',
      );
    },
  });

  if (!entry) return null;

  const slots = slotsQuery.data?.slots ?? [];

  /** Times outside the daily window the customer asked for are dimmed, not hidden. */
  const withinWindow = (slot: AvailableSlot): boolean => {
    const local = DateTime.fromISO(slot.startsAt).setZone(zone);
    const minuteOfDay = local.hour * 60 + local.minute;
    return minuteOfDay >= entry.earliestMinute && minuteOfDay <= entry.latestMinute;
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Book this waitlist request"
      description={`${customerName(entry.customer, 'This customer')} asked for ${
        entry.service?.name ?? 'a service'
      } between ${formatDate(entry.earliestDate, zone)} and ${formatDate(entry.latestDate, zone)}.`}
      width="lg"
      dismissOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={convert.isPending}>
            Cancel
          </Button>
          <Button
            disabled={selected === null}
            loading={convert.isPending}
            onClick={() => {
              if (selected) convert.mutate(selected.startsAt);
            }}
          >
            {selected ? `Book ${formatTime(selected.startsAt, zone)}` : 'Choose a time'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormBanner message={error} />

        <Field
          label="Date"
          hint={`Their window is ${formatMinuteOfDay(entry.earliestMinute)} to ${formatMinuteOfDay(
            entry.latestMinute % 1440,
          )} on ${describeDays(entry.daysOfWeek)}.`}
        >
          {(field) => (
            <DatePicker
              {...field}
              value={date}
              onChange={(next) => {
                setDate(next);
                setSelected(null);
              }}
              timezone={zone}
              min={entry.earliestDate}
              max={entry.latestDate}
            />
          )}
        </Field>

        <div aria-live="polite" aria-busy={slotsQuery.isFetching}>
          {slotsQuery.isPending ? (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {Array.from({ length: 8 }, (_, index) => (
                <Skeleton key={index} className="h-10 w-full" />
              ))}
            </div>
          ) : slotsQuery.isError ? (
            <ErrorState error={slotsQuery.error} onRetry={() => void slotsQuery.refetch()} />
          ) : slots.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-fg-muted">
              Nothing is free on {formatDateLong(date, zone)}. Try another day inside their window.
            </p>
          ) : (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {slots.map((slot) => {
                const preferred = withinWindow(slot);
                const isSelected =
                  selected?.startsAt === slot.startsAt &&
                  selected.staffProfileId === slot.staffProfileId;
                return (
                  <li key={`${slot.startsAt}-${slot.staffProfileId}`}>
                    <button
                      type="button"
                      onClick={() => setSelected(slot)}
                      aria-pressed={isSelected}
                      className={cn(
                        'flex w-full flex-col items-center gap-0.5 rounded-md border px-2 py-2 text-sm transition-colors',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                        isSelected
                          ? 'border-brand bg-brand-subtle font-semibold text-brand-text'
                          : 'border-border bg-surface text-fg hover:bg-surface-hover',
                        !preferred && !isSelected && 'opacity-60',
                      )}
                    >
                      <span className="tabular-nums">{formatTime(slot.startsAt, zone)}</span>
                      <span className="truncate text-xs font-normal text-fg-muted">
                        {slot.staffName}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <p className="text-xs text-fg-muted">
          Times outside the hours they asked for are shown faded. Booking one is allowed — it is
          worth a phone call first.
        </p>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Adding someone
// ---------------------------------------------------------------------------

function AddEntryDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const { activeBusinessId, activeTimezone } = useAuth();
  const { toast } = useToast();
  const services = useServicesLookup();
  const staff = useStaffLookup();
  const locations = useLocationsLookup();

  const [customerSearch, setCustomerSearch] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [staffProfileId, setStaffProfileId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [earliestDate, setEarliestDate] = useState('');
  const [latestDate, setLatestDate] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const debouncedSearch = useDebouncedValue(customerSearch);

  useEffect(() => {
    if (!open) return;
    const today = DateTime.now().setZone(activeTimezone);
    setCustomerSearch('');
    setCustomerId('');
    setServiceId('');
    setStaffProfileId('');
    setLocationId('');
    setEarliestDate(today.toISODate() ?? '');
    setLatestDate(today.plus({ days: 30 }).toISODate() ?? '');
    setNote('');
    setError(null);
  }, [open, activeTimezone]);

  const customerScope = {
    pageSize: 20,
    search: debouncedSearch === '' ? undefined : debouncedSearch,
  };

  const customersQuery = useQuery({
    queryKey: ownerKeys.customers(activeBusinessId, customerScope),
    queryFn: () => api.getPage<Customer>(`/customers${toSearchParams(customerScope)}`),
    enabled: open,
  });

  const create = useMutation<unknown, unknown, void>({
    mutationFn: () =>
      api.post('/waitlist', {
        customerId,
        serviceId,
        staffProfileId: staffProfileId === '' ? null : staffProfileId,
        locationId: locationId === '' ? null : locationId,
        earliestDate,
        latestDate,
        note: note.trim() === '' ? null : note.trim(),
      }),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Added to the waitlist' });
      onCreated();
      onClose();
    },
    onError: (mutationError) => {
      setError(
        isApiError(mutationError)
          ? (mutationError.details[0]?.message ?? mutationError.message)
          : 'Could not add this request.',
      );
    },
  });

  const customers = customersQuery.data?.items ?? [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a waitlist request"
      description="Record who is waiting, for what, and when they could come in. The matcher offers them openings as they appear."
      width="lg"
      dismissOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={customerId === '' || serviceId === ''}
            onClick={() => create.mutate()}
          >
            Add to waitlist
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormBanner message={error} />

        <SearchField
          label="Find the customer"
          value={customerSearch}
          placeholder="Name or email"
          onChange={setCustomerSearch}
          className="max-w-none"
        />

        <Field label="Customer" required>
          {(field) => (
            <Select
              {...field}
              value={customerId}
              onChange={(event) => setCustomerId(event.target.value)}
              placeholder={customers.length === 0 ? 'No customer matches' : 'Choose a customer'}
              options={customers.map((customer) => ({
                value: customer.id,
                label: `${customerName(customer)} — ${customer.email ?? 'no email'}`,
              }))}
            />
          )}
        </Field>

        <Field label="Service" required>
          {(field) => (
            <Select
              {...field}
              value={serviceId}
              onChange={(event) => setServiceId(event.target.value)}
              placeholder="Choose a service"
              options={services.items.map((service) => ({
                value: service.id,
                label: service.name,
              }))}
            />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Provider" hint="Leave open for no preference.">
            {(field) => (
              <Select
                {...field}
                value={staffProfileId}
                onChange={(event) => setStaffProfileId(event.target.value)}
                options={filterOptions(staff.items, 'No preference', (profile) => ({
                  value: profile.id,
                  label: profile.displayName,
                }))}
              />
            )}
          </Field>
          <Field label="Location" hint="Leave open for any site.">
            {(field) => (
              <Select
                {...field}
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
                options={filterOptions(locations.items, 'Any location', (location) => ({
                  value: location.id,
                  label: location.name,
                }))}
              />
            )}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Earliest date" required>
            {(field) => (
              <DatePicker
                {...field}
                value={earliestDate}
                onChange={setEarliestDate}
                timezone={activeTimezone}
                max={latestDate}
              />
            )}
          </Field>
          <Field label="Latest date" required>
            {(field) => (
              <DatePicker
                {...field}
                value={latestDate}
                onChange={setLatestDate}
                timezone={activeTimezone}
                min={earliestDate}
              />
            )}
          </Field>
        </div>

        <Field label="Note" hint="Anything worth knowing when you call them.">
          {(field) => (
            <Textarea
              {...field}
              rows={2}
              maxLength={2000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Happy with any evening slot with Rahul."
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WaitlistPage(): JSX.Element {
  const { activeBusinessId, can } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const services = useServicesLookup();

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>('ACTIVE');
  const [serviceFilter, setServiceFilter] = useState('');
  const [converting, setConverting] = useState<WaitlistListRow | null>(null);
  const [removing, setRemoving] = useState<WaitlistListRow | null>(null);
  const [adding, setAdding] = useState(false);

  const canManage = can(PERMISSIONS.WAITLIST_MANAGE);

  const scope = {
    page,
    pageSize: PAGE_SIZE,
    status: status === '' ? undefined : status,
    serviceId: serviceFilter === '' ? undefined : serviceFilter,
  };

  const listQuery = useQuery({
    queryKey: ownerKeys.waitlist(activeBusinessId, scope),
    queryFn: () => api.getPage<WaitlistListRow>(`/waitlist${toSearchParams(scope)}`),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({
      queryKey: [...ownerKeys.root(activeBusinessId), 'waitlist'],
    });
    void queryClient.invalidateQueries({
      queryKey: [...ownerKeys.root(activeBusinessId), 'appointments'],
    });
  };

  const notify = useMutation<unknown, unknown, string>({
    mutationFn: (id) => api.post(`/waitlist/${id}/notify`, {}),
    onSuccess: () => {
      invalidate();
      toast({
        tone: 'success',
        title: 'Offer sent',
        description: 'They have been told a slot is available and the hold has started.',
      });
    },
    onError: (error) => {
      toast({
        tone: 'error',
        title: 'Could not send that offer',
        description: isApiError(error) ? error.message : undefined,
      });
    },
  });

  const remove = useMutation<void, unknown, string>({
    mutationFn: (id) => api.delete(`/waitlist/${id}`),
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: 'Request removed' });
      setRemoving(null);
    },
    onError: (error) => {
      toast({
        tone: 'error',
        title: 'Could not remove that request',
        description: isApiError(error) ? error.message : undefined,
      });
      setRemoving(null);
    },
  });

  const items = listQuery.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Waitlist"
        description="Customers waiting for a slot that does not exist yet. Notify them when one opens, or book them straight in."
        actions={
          canManage ? (
            <Button
              onClick={() => setAdding(true)}
              leadingIcon={<Plus className="size-4" aria-hidden="true" />}
            >
              Add request
            </Button>
          ) : null
        }
      >
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
                options={STATUS_OPTIONS}
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
        </FilterBar>
      </PageHeader>

      <Card>
        <DataState
          isPending={listQuery.isPending}
          isError={listQuery.isError}
          error={listQuery.error}
          onRetry={() => void listQuery.refetch()}
          isEmpty={items.length === 0}
          columns={5}
          empty={
            <EmptyState
              icon={<Hourglass className="size-6" aria-hidden="true" />}
              title={status === 'ACTIVE' ? 'Nobody is waiting' : 'Nothing matches these filters'}
              description={
                status === 'ACTIVE'
                  ? 'When a customer wants a time you cannot offer, add them here and the matcher will tell them the moment one opens.'
                  : 'Change the status filter to see other requests.'
              }
              action={
                status !== 'ACTIVE' ? (
                  <Button variant="secondary" onClick={() => setStatus('ACTIVE')}>
                    Show waiting
                  </Button>
                ) : canManage ? (
                  <Button
                    onClick={() => setAdding(true)}
                    leadingIcon={<Plus className="size-4" aria-hidden="true" />}
                  >
                    Add request
                  </Button>
                ) : null
              }
            />
          }
        >
          <TableContainer>
            <Table caption="Waitlist requests">
              <THead>
                <Tr>
                  <Th>Customer</Th>
                  <Th>Wants</Th>
                  <Th>Window</Th>
                  <Th>Status</Th>
                  <Th align="right">
                    <span className="mf-sr-only">Actions</span>
                  </Th>
                </Tr>
              </THead>
              <TBody>
                {items.map((entry) => (
                  <Tr key={entry.id}>
                    <Td>
                      <span className="font-medium text-fg">{customerName(entry.customer)}</span>
                      {entry.customer?.email ? (
                        <span className="block truncate text-xs text-fg-muted">
                          {entry.customer.email}
                        </span>
                      ) : null}
                      {entry.note ? (
                        <span className="mt-0.5 block max-w-xs truncate text-xs italic text-fg-muted">
                          {entry.note}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      <span className="text-sm text-fg">{entry.service?.name ?? '—'}</span>
                      <span className="block text-xs text-fg-muted">
                        {entry.staffProfile?.displayName ?? 'Any provider'}
                        {entry.location ? ` · ${entry.location.name}` : ''}
                      </span>
                    </Td>
                    <Td>
                      <span className="block text-sm tabular-nums text-fg-secondary">
                        {formatDate(entry.earliestDate, entry.timezone)} –{' '}
                        {formatDate(entry.latestDate, entry.timezone)}
                      </span>
                      <span className="block text-xs tabular-nums text-fg-muted">
                        {formatMinuteOfDay(entry.earliestMinute)} –{' '}
                        {formatMinuteOfDay(entry.latestMinute % 1440)} ·{' '}
                        {describeDays(entry.daysOfWeek)}
                      </span>
                    </Td>
                    <Td>
                      <div className="flex flex-col items-start gap-1">
                        <WaitlistStatusBadge status={entry.status} />
                        {entry.notificationCount > 0 ? (
                          <Badge tone="neutral">Offered {entry.notificationCount}×</Badge>
                        ) : null}
                        {entry.status === 'CONVERTED' && entry.convertedAppointment ? (
                          <span className="text-xs text-fg-muted">
                            Booked for{' '}
                            {formatDate(entry.convertedAppointment.startsAt, entry.timezone)}
                          </span>
                        ) : null}
                      </div>
                    </Td>
                    <Td align="right">
                      {canManage && ACTIONABLE_STATUSES.includes(entry.status) ? (
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={notify.isPending && notify.variables === entry.id}
                            onClick={() => notify.mutate(entry.id)}
                            leadingIcon={<BellRing className="size-4" aria-hidden="true" />}
                          >
                            Notify
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setConverting(entry)}
                            leadingIcon={<CalendarPlus className="size-4" aria-hidden="true" />}
                          >
                            Book
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-danger-text"
                            aria-label="Remove this request"
                            onClick={() => setRemoving(entry)}
                          >
                            <Trash2 className="size-4" aria-hidden="true" />
                          </Button>
                        </div>
                      ) : null}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableContainer>

          {listQuery.data ? (
            <Pagination meta={listQuery.data.meta} onPageChange={setPage} itemLabel="requests" />
          ) : null}
        </DataState>
      </Card>

      <ConvertDialog
        entry={converting}
        open={converting !== null}
        onClose={() => setConverting(null)}
        onConverted={invalidate}
      />

      <AddEntryDialog open={adding} onClose={() => setAdding(false)} onCreated={invalidate} />

      <ConfirmDialog
        open={removing !== null}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) remove.mutate(removing.id);
        }}
        title="Remove this waitlist request?"
        description="They stop being offered openings. Nothing is sent to them about it."
        confirmLabel="Remove request"
        cancelLabel="Keep it"
        destructive
        loading={remove.isPending}
      />
    </>
  );
}
