import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Contact, Mail, Pencil, Phone, Plus, Trash2 } from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { PageHeader } from '@/components/layout';
import {
  AppointmentStatusBadge,
  CustomerStatusBadge,
  DataState,
  FilterBar,
  FilterField,
  FormDrawer,
  SearchField,
  filterOptions,
  ownerKeys,
  toSearchParams,
  useDebouncedValue,
  useLocationsLookup,
  useStaffLookup,
  type CustomerAppointment,
  type CustomerDetail,
} from '@/components/owner';
import {
  Avatar,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Pagination,
  Select,
  Skeleton,
  Switch,
  TBody,
  THead,
  Table,
  TableContainer,
  Tabs,
  Td,
  Textarea,
  Th,
  Tr,
  useToast,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { api, isApiError } from '@/lib/apiClient';
import {
  customerName,
  formatDate,
  formatDateTime,
  formatNumber,
  formatRelative,
  formatTime,
} from '@/lib/format';
import { PERMISSIONS } from '@/lib/permissions';
import { timezoneOptions } from '@/lib/timezones';
import { useFormApiError } from '@/pages/auth/useFormApiError';
import type { Customer } from '@/types/api';

const PAGE_SIZE = 20;
const TIMEZONE_OPTIONS = timezoneOptions();

const optionalText = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : value));

const customerSchema = z.object({
  firstName: z.string().trim().min(1, 'A first name is required.').max(100),
  lastName: optionalText,
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254),
  phone: optionalText,
  timezone: z.string(),
  notes: optionalText,
  tags: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag !== ''),
    )
    .refine((tags) => tags.length <= 25, 'A customer can carry at most 25 tags.'),
  preferredStaffProfileId: z.string().transform((value) => (value === '' ? null : value)),
  preferredLocationId: z.string().transform((value) => (value === '' ? null : value)),
  status: z.enum(['ACTIVE', 'BLOCKED', 'ARCHIVED']),
  emailEnabled: z.boolean(),
  smsEnabled: z.boolean(),
  marketingOptIn: z.boolean(),
});

type CustomerFormValues = z.input<typeof customerSchema>;

const EMPTY_FORM: CustomerFormValues = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  timezone: '',
  notes: '',
  tags: '',
  preferredStaffProfileId: '',
  preferredLocationId: '',
  status: 'ACTIVE',
  emailEnabled: true,
  smsEnabled: false,
  marketingOptIn: false,
};

const FORM_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'timezone',
  'notes',
  'tags',
  'preferredStaffProfileId',
  'preferredLocationId',
  'status',
  'emailEnabled',
  'smsEnabled',
  'marketingOptIn',
] as const;

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function Counter({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-fg">{formatNumber(value)}</p>
    </div>
  );
}

function CustomerDrawer({
  customerId,
  open,
  onClose,
  onEdit,
}: {
  customerId: string | null;
  open: boolean;
  onClose: () => void;
  onEdit: (customer: Customer) => void;
}): JSX.Element {
  const { activeBusinessId, activeTimezone, can } = useAuth();
  const [tab, setTab] = useState<'upcoming' | 'history'>('upcoming');
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (open) {
      setTab('upcoming');
      setPage(1);
    }
  }, [open, customerId]);

  // The endpoint answers `{ customer, recentAppointments }` rather than a bare
  // record, so the wrapper is unwrapped here instead of at every read site.
  const customerQuery = useQuery({
    queryKey: ownerKeys.customer(activeBusinessId, customerId ?? ''),
    queryFn: () => api.get<CustomerDetail>(`/customers/${customerId ?? ''}`),
    enabled: open && customerId !== null,
  });

  const appointmentsQuery = useQuery({
    queryKey: ownerKeys.customerAppointments(activeBusinessId, customerId ?? '', page),
    queryFn: () =>
      api.getPage<CustomerAppointment>(
        `/customers/${customerId ?? ''}/appointments${toSearchParams({ page, pageSize: 50 })}`,
      ),
    enabled: open && customerId !== null && can(PERMISSIONS.CUSTOMERS_READ),
  });

  const customer = customerQuery.data?.customer;

  /*
   * One request feeds both tabs.
   *
   * `GET /customers/:id/appointments` returns the whole history in one page, so
   * splitting it on the client costs nothing and avoids a second round trip
   * every time the operator flips between "what is coming up" and "what
   * happened". The split is taken against the moment the data arrived rather
   * than a ticking clock — an appointment sliding from Upcoming to Past while
   * someone reads the list would be more surprising than useful.
   */
  const { upcoming, past } = useMemo(() => {
    const rows = appointmentsQuery.data?.items ?? [];
    const boundary = Date.now();
    const future: CustomerAppointment[] = [];
    const previous: CustomerAppointment[] = [];
    for (const row of rows) {
      if (DateTime.fromISO(row.startsAt).toMillis() >= boundary) future.push(row);
      else previous.push(row);
    }
    future.sort(
      (a, b) => DateTime.fromISO(a.startsAt).toMillis() - DateTime.fromISO(b.startsAt).toMillis(),
    );
    previous.sort(
      (a, b) => DateTime.fromISO(b.startsAt).toMillis() - DateTime.fromISO(a.startsAt).toMillis(),
    );
    return { upcoming: future, past: previous };
  }, [appointmentsQuery.data]);

  const rows = tab === 'upcoming' ? upcoming : past;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={customer ? customerName(customer) : 'Customer'}
      description={customer?.email ?? undefined}
      width="lg"
      footer={
        customer && can(PERMISSIONS.CUSTOMERS_MANAGE) ? (
          <Button
            variant="secondary"
            onClick={() => onEdit(customer)}
            leadingIcon={<Pencil className="size-4" aria-hidden="true" />}
          >
            Edit details
          </Button>
        ) : undefined
      }
    >
      {customerQuery.isPending ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : customerQuery.isError ? (
        <ErrorState error={customerQuery.error} onRetry={() => void customerQuery.refetch()} />
      ) : customer ? (
        <div className="flex flex-col gap-6">
          <div className="flex items-start gap-3">
            <Avatar name={customerName(customer)} size="lg" />
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold text-fg">{customerName(customer)}</p>
              <div className="mt-1 flex flex-col gap-1 text-sm">
                {customer.email ? (
                  <a
                    href={`mailto:${customer.email}`}
                    className="flex items-center gap-2 rounded-xs text-fg-secondary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  >
                    <Mail className="size-4 text-fg-muted" aria-hidden="true" />
                    {customer.email}
                  </a>
                ) : null}
                {customer.phone ? (
                  <a
                    href={`tel:${customer.phone}`}
                    className="flex items-center gap-2 rounded-xs text-fg-secondary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  >
                    <Phone className="size-4 text-fg-muted" aria-hidden="true" />
                    {customer.phone}
                  </a>
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <CustomerStatusBadge status={customer.status} />
                {customer.tags.map((tag) => (
                  <Badge key={tag} tone="brand">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Counter label="Bookings" value={customer.totalBookings} />
            <Counter label="Attended" value={customer.completedCount} />
            <Counter label="Cancelled" value={customer.cancelledCount} />
            <Counter label="No-shows" value={customer.noShowCount} />
          </div>

          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                First booking
              </dt>
              <dd className="text-fg">
                {customer.firstAppointmentAt
                  ? formatDate(customer.firstAppointmentAt, activeTimezone)
                  : 'Never booked'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                Most recent
              </dt>
              <dd className="text-fg">
                {customer.lastAppointmentAt
                  ? `${formatDate(customer.lastAppointmentAt, activeTimezone)} (${formatRelative(
                      customer.lastAppointmentAt,
                      activeTimezone,
                    )})`
                  : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                Their timezone
              </dt>
              <dd className="text-fg">{customer.timezone ?? activeTimezone}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                Contact preferences
              </dt>
              <dd className="text-fg">
                {[
                  customer.communicationPreferences.emailEnabled ? 'Email' : null,
                  customer.communicationPreferences.smsEnabled ? 'SMS' : null,
                  customer.communicationPreferences.marketingOptIn ? 'Marketing' : null,
                ]
                  .filter(Boolean)
                  .join(', ') || 'None'}
              </dd>
            </div>
          </dl>

          {customer.notes ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                Internal note
              </h3>
              <p className="whitespace-pre-wrap rounded-md border border-border px-3 py-2 text-sm leading-relaxed text-fg-secondary">
                {customer.notes}
              </p>
            </section>
          ) : null}

          <section className="flex flex-col gap-3">
            <Tabs
              label="Booking history"
              value={tab}
              onValueChange={setTab}
              items={[
                { value: 'upcoming', label: 'Upcoming', count: upcoming.length },
                { value: 'history', label: 'Past', count: past.length },
              ]}
            />

            <DataState
              isPending={appointmentsQuery.isPending}
              isError={appointmentsQuery.isError}
              error={appointmentsQuery.error}
              onRetry={() => void appointmentsQuery.refetch()}
              isEmpty={rows.length === 0}
              rows={3}
              columns={3}
              empty={
                <EmptyState
                  title={tab === 'upcoming' ? 'Nothing booked ahead' : 'No past appointments'}
                  description={
                    tab === 'upcoming'
                      ? 'This customer has no future bookings.'
                      : 'Nothing has happened yet for this customer.'
                  }
                />
              }
            >
              <ul className="flex flex-col gap-2">
                {rows.map((appointment) => (
                  <li
                    key={appointment.id}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-fg">
                        {appointment.service?.name ?? 'Appointment'}
                      </p>
                      <p className="text-xs tabular-nums text-fg-muted">
                        {formatDateTime(appointment.startsAt, appointment.timezone)}
                        {appointment.staffProfile
                          ? ` · ${appointment.staffProfile.displayName}`
                          : ''}
                      </p>
                    </div>
                    <AppointmentStatusBadge status={appointment.status} />
                  </li>
                ))}
              </ul>
            </DataState>

            {appointmentsQuery.data && appointmentsQuery.data.meta.totalPages > 1 ? (
              <Pagination
                meta={appointmentsQuery.data.meta}
                onPageChange={setPage}
                itemLabel="appointments"
              />
            ) : null}
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CustomersPage(): JSX.Element {
  const { activeBusinessId, activeTimezone, can } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const staff = useStaffLookup();
  const locations = useLocationsLookup();
  const [searchParams, setSearchParams] = useSearchParams();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [tag, setTag] = useState('');
  const [viewing, setViewing] = useState<string | null>(searchParams.get('customer'));
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [deleting, setDeleting] = useState<Customer | null>(null);

  const canManage = can(PERMISSIONS.CUSTOMERS_MANAGE);
  const debouncedSearch = useDebouncedValue(search);

  const scope = {
    page,
    pageSize: PAGE_SIZE,
    search: debouncedSearch === '' ? undefined : debouncedSearch,
    status: status === '' ? undefined : status,
    tag: tag === '' ? undefined : tag,
  };

  const listQuery = useQuery({
    queryKey: ownerKeys.customers(activeBusinessId, scope),
    queryFn: () => api.getPage<Customer>(`/customers${toSearchParams(scope)}`),
  });

  const form = useForm<CustomerFormValues>({
    // `raw: true` hands the *untransformed* form values to handleSubmit.
    // Without it the resolver returns zod's output, and the explicit
    // `.parse(values)` below would run a second time over already-transformed
    // data — turning `city: null` back into a string parse and failing the
    // submit silently, with no field error to show for it.
    resolver: zodResolver(customerSchema, undefined, { raw: true }),
    defaultValues: EMPTY_FORM,
  });
  const { formError, clearFormError, handleApiError } = useFormApiError(form.setError, FORM_FIELDS);

  const drawerOpen = creating || editing !== null;

  useEffect(() => {
    if (!drawerOpen) return;
    clearFormError();
    form.reset(
      editing
        ? {
            firstName: editing.firstName,
            lastName: editing.lastName ?? '',
            email: editing.email ?? '',
            phone: editing.phone ?? '',
            timezone: editing.timezone ?? activeTimezone,
            notes: editing.notes ?? '',
            tags: editing.tags.join(', '),
            preferredStaffProfileId: editing.preferredStaffProfileId ?? '',
            preferredLocationId: editing.preferredLocationId ?? '',
            status: editing.status,
            emailEnabled: editing.communicationPreferences.emailEnabled,
            smsEnabled: editing.communicationPreferences.smsEnabled,
            marketingOptIn: editing.communicationPreferences.marketingOptIn,
          }
        : { ...EMPTY_FORM, timezone: activeTimezone },
    );
  }, [drawerOpen, editing, form, clearFormError, activeTimezone]);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({
      queryKey: [...ownerKeys.root(activeBusinessId), 'customers'],
    });
  };

  const save = useMutation<Customer, unknown, z.output<typeof customerSchema>>({
    mutationFn: ({ emailEnabled, smsEnabled, marketingOptIn, ...rest }) => {
      const payload = {
        ...rest,
        communicationPreferences: { emailEnabled, smsEnabled, marketingOptIn },
      };
      return editing
        ? api.patch<Customer>(`/customers/${editing.id}`, payload)
        : api.post<Customer>('/customers', payload);
    },
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: editing ? 'Customer updated' : 'Customer added' });
      setCreating(false);
      setEditing(null);
    },
    onError: handleApiError,
  });

  const remove = useMutation<void, unknown, string>({
    mutationFn: (id) => api.delete(`/customers/${id}`),
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: 'Customer archived' });
      setDeleting(null);
      setViewing(null);
    },
    onError: (error) => {
      toast({
        tone: 'error',
        title: 'Could not archive this customer',
        description: isApiError(error) ? error.message : undefined,
      });
      setDeleting(null);
    },
  });

  const items = listQuery.data?.items ?? [];
  const hasFilters = search !== '' || status !== '' || tag !== '';

  const closeDetail = (): void => {
    setViewing(null);
    if (searchParams.has('customer')) setSearchParams({}, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="Customers"
        description="Everyone who has booked with this workspace, with their history and the notes your team keeps on them."
        actions={
          canManage ? (
            <Button
              onClick={() => setCreating(true)}
              leadingIcon={<Plus className="size-4" aria-hidden="true" />}
            >
              Add customer
            </Button>
          ) : null
        }
      >
        <FilterBar>
          <SearchField
            label="Search"
            value={search}
            placeholder="Name or email"
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
                options={[
                  { value: '', label: 'Every status' },
                  { value: 'ACTIVE', label: 'Active' },
                  { value: 'BLOCKED', label: 'Blocked' },
                  { value: 'ARCHIVED', label: 'Archived' },
                ]}
              />
            )}
          </FilterField>
          <FilterField label="Tag">
            {({ id }) => (
              <Input
                id={id}
                inputSize="sm"
                value={tag}
                placeholder="vip"
                onChange={(event) => {
                  setTag(event.target.value.toLowerCase());
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
          columns={5}
          empty={
            <EmptyState
              icon={<Contact className="size-6" aria-hidden="true" />}
              title={hasFilters ? 'No customer matches' : 'No customers yet'}
              description={
                hasFilters
                  ? 'Try a different search, or clear the filters.'
                  : 'Customers are created automatically the first time someone books. You can also add one by hand for a booking taken over the phone.'
              }
              action={
                hasFilters ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSearch('');
                      setStatus('');
                      setTag('');
                      setPage(1);
                    }}
                  >
                    Clear filters
                  </Button>
                ) : canManage ? (
                  <Button
                    onClick={() => setCreating(true)}
                    leadingIcon={<Plus className="size-4" aria-hidden="true" />}
                  >
                    Add customer
                  </Button>
                ) : null
              }
            />
          }
        >
          <TableContainer>
            <Table caption="Customers">
              <THead>
                <Tr>
                  <Th>Customer</Th>
                  <Th align="right">Bookings</Th>
                  <Th align="right">No-shows</Th>
                  <Th>Last seen</Th>
                  <Th>Status</Th>
                  <Th align="right">
                    <span className="mf-sr-only">Actions</span>
                  </Th>
                </Tr>
              </THead>
              <TBody>
                {items.map((customer) => (
                  <Tr key={customer.id} interactive>
                    <Td>
                      <button
                        type="button"
                        onClick={() => setViewing(customer.id)}
                        className="flex items-center gap-3 rounded-xs text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                      >
                        <Avatar name={customerName(customer)} size="sm" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-fg">
                            {customerName(customer)}
                          </span>
                          <span className="block truncate text-xs text-fg-muted">
                            {customer.email ?? customer.phone ?? 'No contact details'}
                          </span>
                        </span>
                      </button>
                    </Td>
                    <Td numeric>{formatNumber(customer.totalBookings)}</Td>
                    <Td numeric>
                      <span className={customer.noShowCount > 0 ? 'text-danger-text' : undefined}>
                        {formatNumber(customer.noShowCount)}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-sm text-fg-secondary">
                        {customer.lastAppointmentAt
                          ? `${formatDate(customer.lastAppointmentAt, activeTimezone)} · ${formatTime(
                              customer.lastAppointmentAt,
                              activeTimezone,
                            )}`
                          : '—'}
                      </span>
                    </Td>
                    <Td>
                      <CustomerStatusBadge status={customer.status} />
                    </Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setViewing(customer.id)}>
                          Open
                        </Button>
                        {canManage ? (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              aria-label={`Edit ${customerName(customer)}`}
                              onClick={() => setEditing(customer)}
                            >
                              <Pencil className="size-4" aria-hidden="true" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-danger-text"
                              aria-label={`Archive ${customerName(customer)}`}
                              onClick={() => setDeleting(customer)}
                            >
                              <Trash2 className="size-4" aria-hidden="true" />
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableContainer>

          {listQuery.data ? (
            <Pagination meta={listQuery.data.meta} onPageChange={setPage} itemLabel="customers" />
          ) : null}
        </DataState>
      </Card>

      <CustomerDrawer
        customerId={viewing}
        open={viewing !== null}
        onClose={closeDetail}
        onEdit={(customer) => {
          closeDetail();
          setEditing(customer);
        }}
      />

      <FormDrawer
        open={drawerOpen}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        title={editing ? `Edit ${customerName(editing)}` : 'Add a customer'}
        submitLabel={editing ? 'Save changes' : 'Add customer'}
        isSubmitting={save.isPending}
        formError={formError}
        width="lg"
        onSubmit={form.handleSubmit((values) => {
          clearFormError();
          save.mutate(customerSchema.parse(values));
        })}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" required error={form.formState.errors.firstName?.message}>
            {(field) => (
              <Input {...field} {...form.register('firstName')} autoComplete="given-name" />
            )}
          </Field>
          <Field label="Last name" error={form.formState.errors.lastName?.message}>
            {(field) => (
              <Input {...field} {...form.register('lastName')} autoComplete="family-name" />
            )}
          </Field>
        </div>

        <Field label="Email" required error={form.formState.errors.email?.message}>
          {(field) => (
            <Input {...field} {...form.register('email')} type="email" autoComplete="email" />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Phone" error={form.formState.errors.phone?.message}>
            {(field) => <Input {...field} {...form.register('phone')} type="tel" />}
          </Field>
          <Field
            label="Timezone"
            hint="Their reminders are rendered against this clock."
            error={form.formState.errors.timezone?.message}
          >
            {(field) => (
              <Select {...field} {...form.register('timezone')} options={TIMEZONE_OPTIONS} />
            )}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Preferred provider"
            error={form.formState.errors.preferredStaffProfileId?.message}
          >
            {(field) => (
              <Select
                {...field}
                {...form.register('preferredStaffProfileId')}
                options={filterOptions(staff.items, 'No preference', (profile) => ({
                  value: profile.id,
                  label: profile.displayName,
                }))}
              />
            )}
          </Field>
          <Field
            label="Preferred location"
            error={form.formState.errors.preferredLocationId?.message}
          >
            {(field) => (
              <Select
                {...field}
                {...form.register('preferredLocationId')}
                options={filterOptions(locations.items, 'No preference', (location) => ({
                  value: location.id,
                  label: location.name,
                }))}
              />
            )}
          </Field>
        </div>

        <Field
          label="Tags"
          hint="Comma separated. Folded to lower case so a tag filter finds them all."
          error={form.formState.errors.tags?.message}
        >
          {(field) => <Input {...field} {...form.register('tags')} placeholder="vip, member" />}
        </Field>

        <Field
          label="Internal note"
          hint="Your team only. Never shown to the customer."
          error={form.formState.errors.notes?.message}
        >
          {(field) => <Textarea {...field} {...form.register('notes')} rows={3} />}
        </Field>

        <Field label="Status" error={form.formState.errors.status?.message}>
          {(field) => (
            <Select
              {...field}
              {...form.register('status')}
              options={[
                { value: 'ACTIVE', label: 'Active' },
                { value: 'BLOCKED', label: 'Blocked — cannot book' },
                { value: 'ARCHIVED', label: 'Archived' },
              ]}
            />
          )}
        </Field>

        <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
          <Switch
            checked={form.watch('emailEnabled')}
            onCheckedChange={(checked) =>
              form.setValue('emailEnabled', checked, { shouldDirty: true })
            }
            label="Email them"
            description="Confirmations and reminders. Turning this off stops both."
          />
          <Switch
            checked={form.watch('smsEnabled')}
            onCheckedChange={(checked) =>
              form.setValue('smsEnabled', checked, { shouldDirty: true })
            }
            label="Text them"
          />
          <Switch
            checked={form.watch('marketingOptIn')}
            onCheckedChange={(checked) =>
              form.setValue('marketingOptIn', checked, { shouldDirty: true })
            }
            label="Marketing consent"
            description="Only set this if they have actually agreed to it."
          />
        </div>
      </FormDrawer>

      <ConfirmDialog
        open={deleting !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
        title={deleting ? `Archive ${customerName(deleting)}?` : ''}
        description="Their appointment history is kept, but they stop appearing in the address book and cannot be booked."
        confirmLabel="Archive customer"
        cancelLabel="Keep them"
        destructive
        loading={remove.isPending}
      />
    </>
  );
}
