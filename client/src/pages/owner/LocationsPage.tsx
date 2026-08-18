import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin, Pencil, Plus, Trash2, Video } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { PageHeader } from '@/components/layout';
import {
  ActiveBadge,
  DataState,
  FilterBar,
  FilterField,
  FormDrawer,
  ownerKeys,
  toSearchParams,
} from '@/components/owner';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Pagination,
  Select,
  Switch,
  TBody,
  THead,
  Table,
  TableContainer,
  Td,
  Th,
  Tr,
  Textarea,
  useToast,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { api, isApiError } from '@/lib/apiClient';
import { PERMISSIONS } from '@/lib/permissions';
import { timezoneOptions } from '@/lib/timezones';
import { useFormApiError } from '@/pages/auth/useFormApiError';
import type { Location, LocationType } from '@/types/api';

const PAGE_SIZE = 20;

/** Computed once: the browser's zone list is long and does not change. */
const TIMEZONE_OPTIONS = timezoneOptions();

/**
 * Exactly the four the API accepts (`LOCATION_TYPES` in the Location model).
 * Offering a fifth would let a form submit a value the server rejects, and
 * omitting one would make part of the product unreachable from the UI.
 */
const LOCATION_TYPES: Array<{ value: LocationType; label: string; hint: string }> = [
  { value: 'PHYSICAL', label: 'Physical', hint: 'Customers come to an address.' },
  { value: 'VIRTUAL', label: 'Virtual', hint: 'The appointment happens over a meeting link.' },
  { value: 'PHONE', label: 'Phone', hint: 'The appointment happens over a call.' },
  { value: 'CUSTOMER_SITE', label: 'Customer site', hint: 'Your team travels to the customer.' },
];

/**
 * `null` and `''` are different instructions to this API: an omitted key leaves
 * a field alone, an empty string clears it. The form works in strings, so every
 * optional text field is normalised on the way out.
 */
const optionalText = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : value));

const locationSchema = z.object({
  name: z.string().trim().min(1, 'A location name is required.').max(160),
  type: z.enum(['PHYSICAL', 'VIRTUAL', 'PHONE', 'CUSTOMER_SITE']),
  timezone: z.string().min(1, 'Choose the timezone this site keeps.'),
  description: optionalText,
  addressLine1: optionalText,
  addressLine2: optionalText,
  city: optionalText,
  state: optionalText,
  postalCode: optionalText,
  countryCode: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value.toUpperCase()))
    .refine(
      (value) => value === null || /^[A-Z]{2}$/.test(value),
      'Use the two-letter ISO code, e.g. IN.',
    ),
  phone: optionalText,
  email: optionalText.refine(
    (value) => value === null || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value),
    'Enter a valid email address.',
  ),
  virtualMeetingUrl: optionalText.refine(
    (value) => value === null || /^https?:\/\/\S+$/.test(value),
    'Enter a full URL including https://.',
  ),
  capacity: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : Number(value)))
    .refine(
      (value) => value === null || (Number.isInteger(value) && value > 0),
      'Capacity must be a whole number above zero, or blank for no cap.',
    ),
  isActive: z.boolean(),
});

type LocationFormValues = z.input<typeof locationSchema>;
type LocationPayload = z.output<typeof locationSchema>;

const EMPTY_FORM: LocationFormValues = {
  name: '',
  type: 'PHYSICAL',
  timezone: '',
  description: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  postalCode: '',
  countryCode: '',
  phone: '',
  email: '',
  virtualMeetingUrl: '',
  capacity: '',
  isActive: true,
};

function toFormValues(location: Location): LocationFormValues {
  return {
    name: location.name,
    type: location.type,
    timezone: location.timezone,
    description: location.description ?? '',
    addressLine1: location.addressLine1 ?? '',
    addressLine2: location.addressLine2 ?? '',
    city: location.city ?? '',
    state: location.state ?? '',
    postalCode: location.postalCode ?? '',
    countryCode: location.countryCode ?? '',
    phone: location.phone ?? '',
    email: location.email ?? '',
    virtualMeetingUrl: location.virtualMeetingUrl ?? '',
    capacity: location.capacity === null ? '' : String(location.capacity),
    isActive: location.isActive,
  };
}

function addressOf(location: Location): string {
  return [location.addressLine1, location.city, location.state, location.postalCode]
    .filter((part) => part !== null && part !== '')
    .join(', ');
}

const FORM_FIELDS = [
  'name',
  'type',
  'timezone',
  'description',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'postalCode',
  'countryCode',
  'phone',
  'email',
  'virtualMeetingUrl',
  'capacity',
  'isActive',
] as const;

export default function LocationsPage(): JSX.Element {
  const { activeBusinessId, activeTimezone, can } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [page, setPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState('');
  const [editing, setEditing] = useState<Location | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Location | null>(null);

  const canManage = can(PERMISSIONS.LOCATIONS_MANAGE);

  const scope = {
    page,
    pageSize: PAGE_SIZE,
    type: typeFilter === '' ? undefined : typeFilter,
    isActive: activeFilter === '' ? undefined : activeFilter,
  };

  const listQuery = useQuery({
    queryKey: ownerKeys.locations(activeBusinessId, scope),
    queryFn: () => api.getPage<Location>(`/locations${toSearchParams(scope)}`),
  });

  const form = useForm<LocationFormValues>({
    // `raw: true` hands the *untransformed* form values to handleSubmit.
    // Without it the resolver returns zod's output, and the explicit
    // `.parse(values)` below would run a second time over already-transformed
    // data — turning `city: null` back into a string parse and failing the
    // submit silently, with no field error to show for it.
    resolver: zodResolver(locationSchema, undefined, { raw: true }),
    defaultValues: EMPTY_FORM,
  });
  const { formError, clearFormError, handleApiError } = useFormApiError(form.setError, FORM_FIELDS);

  const drawerOpen = creating || editing !== null;

  useEffect(() => {
    if (!drawerOpen) return;
    clearFormError();
    form.reset(editing ? toFormValues(editing) : { ...EMPTY_FORM, timezone: activeTimezone });
  }, [drawerOpen, editing, form, clearFormError, activeTimezone]);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({
      queryKey: [...ownerKeys.root(activeBusinessId), 'locations'],
    });
  };

  const save = useMutation<Location, unknown, LocationPayload>({
    mutationFn: (payload) =>
      editing
        ? api.patch<Location>(`/locations/${editing.id}`, payload)
        : api.post<Location>('/locations', payload),
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: editing ? 'Location updated' : 'Location added' });
      setCreating(false);
      setEditing(null);
    },
    onError: handleApiError,
  });

  const remove = useMutation<void, unknown, string>({
    mutationFn: (id) => api.delete(`/locations/${id}`),
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: 'Location removed' });
      setDeleting(null);
    },
    onError: (error) => {
      toast({
        tone: 'error',
        title: 'Could not remove this location',
        description: isApiError(error) ? error.message : undefined,
      });
      setDeleting(null);
    },
  });

  const items = listQuery.data?.items ?? [];
  const selectedType = form.watch('type');

  return (
    <>
      <PageHeader
        title="Locations"
        description="The sites your workspace works from. Each one keeps its own clock, so a studio in another city resolves its own opening hours."
        actions={
          canManage ? (
            <Button
              onClick={() => setCreating(true)}
              leadingIcon={<Plus className="size-4" aria-hidden="true" />}
            >
              Add location
            </Button>
          ) : null
        }
      >
        <FilterBar>
          <FilterField label="Type">
            {({ id }) => (
              <Select
                id={id}
                selectSize="sm"
                value={typeFilter}
                onChange={(event) => {
                  setTypeFilter(event.target.value);
                  setPage(1);
                }}
                options={[
                  { value: '', label: 'All types' },
                  ...LOCATION_TYPES.map((entry) => ({ value: entry.value, label: entry.label })),
                ]}
              />
            )}
          </FilterField>
          <FilterField label="Status">
            {({ id }) => (
              <Select
                id={id}
                selectSize="sm"
                value={activeFilter}
                onChange={(event) => {
                  setActiveFilter(event.target.value);
                  setPage(1);
                }}
                options={[
                  { value: '', label: 'Active and inactive' },
                  { value: 'true', label: 'Active only' },
                  { value: 'false', label: 'Inactive only' },
                ]}
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
              icon={<MapPin className="size-6" aria-hidden="true" />}
              title={
                typeFilter !== '' || activeFilter !== ''
                  ? 'No location matches these filters'
                  : 'No locations yet'
              }
              description={
                typeFilter !== '' || activeFilter !== ''
                  ? 'Clear the filters to see every site in this workspace.'
                  : 'Add the first site your team works from. Services and staff are then offered against it, and it keeps its own opening hours.'
              }
              action={
                canManage && typeFilter === '' && activeFilter === '' ? (
                  <Button
                    onClick={() => setCreating(true)}
                    leadingIcon={<Plus className="size-4" aria-hidden="true" />}
                  >
                    Add location
                  </Button>
                ) : typeFilter !== '' || activeFilter !== '' ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setTypeFilter('');
                      setActiveFilter('');
                      setPage(1);
                    }}
                  >
                    Clear filters
                  </Button>
                ) : null
              }
            />
          }
        >
          <TableContainer>
            <Table caption="Locations in this workspace">
              <THead>
                <Tr>
                  <Th>Name</Th>
                  <Th>Type</Th>
                  <Th>Where</Th>
                  <Th>Timezone</Th>
                  <Th>Status</Th>
                  {canManage ? (
                    <Th align="right">
                      <span className="mf-sr-only">Actions</span>
                    </Th>
                  ) : null}
                </Tr>
              </THead>
              <TBody>
                {items.map((location) => (
                  <Tr key={location.id}>
                    <Td>
                      <span className="font-medium text-fg">{location.name}</span>
                      {location.description ? (
                        <span className="block max-w-md truncate text-xs text-fg-muted">
                          {location.description}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      <span className="inline-flex items-center gap-1.5 text-sm text-fg-secondary">
                        {location.type === 'VIRTUAL' ? (
                          <Video className="size-4 text-fg-muted" aria-hidden="true" />
                        ) : (
                          <MapPin className="size-4 text-fg-muted" aria-hidden="true" />
                        )}
                        {LOCATION_TYPES.find((entry) => entry.value === location.type)?.label ??
                          location.type}
                      </span>
                    </Td>
                    <Td>
                      {location.type === 'VIRTUAL' ? (
                        location.virtualMeetingUrl ? (
                          <a
                            href={location.virtualMeetingUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="rounded-xs text-sm text-brand-text underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                          >
                            Meeting link
                          </a>
                        ) : (
                          <span className="text-sm text-fg-muted">No link set</span>
                        )
                      ) : (
                        <span className="text-sm text-fg-secondary">
                          {addressOf(location) || '—'}
                        </span>
                      )}
                    </Td>
                    <Td>
                      <span className="text-sm text-fg-secondary">{location.timezone}</span>
                    </Td>
                    <Td>
                      <ActiveBadge active={location.isActive} />
                    </Td>
                    {canManage ? (
                      <Td align="right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            aria-label={`Edit ${location.name}`}
                            onClick={() => setEditing(location)}
                          >
                            <Pencil className="size-4" aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-danger-text"
                            aria-label={`Remove ${location.name}`}
                            onClick={() => setDeleting(location)}
                          >
                            <Trash2 className="size-4" aria-hidden="true" />
                          </Button>
                        </div>
                      </Td>
                    ) : null}
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableContainer>

          {listQuery.data ? (
            <Pagination meta={listQuery.data.meta} onPageChange={setPage} itemLabel="locations" />
          ) : null}
        </DataState>
      </Card>

      <FormDrawer
        open={drawerOpen}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        title={editing ? `Edit ${editing.name}` : 'Add a location'}
        description="A location's timezone is what its opening hours and bookable slots are resolved against."
        submitLabel={editing ? 'Save changes' : 'Add location'}
        isSubmitting={save.isPending}
        formError={formError}
        width="lg"
        onSubmit={form.handleSubmit((values) => {
          clearFormError();
          save.mutate(locationSchema.parse(values));
        })}
      >
        <Field label="Name" required error={form.formState.errors.name?.message}>
          {(field) => <Input {...field} {...form.register('name')} autoComplete="off" />}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Type"
            required
            hint={LOCATION_TYPES.find((entry) => entry.value === selectedType)?.hint}
            error={form.formState.errors.type?.message}
          >
            {(field) => (
              <Select
                {...field}
                {...form.register('type')}
                options={LOCATION_TYPES.map((entry) => ({
                  value: entry.value,
                  label: entry.label,
                }))}
              />
            )}
          </Field>

          <Field
            label="Timezone"
            required
            hint="Defaults to the workspace clock."
            error={form.formState.errors.timezone?.message}
          >
            {(field) => (
              <Select {...field} {...form.register('timezone')} options={TIMEZONE_OPTIONS} />
            )}
          </Field>
        </div>

        <Field label="Description" error={form.formState.errors.description?.message}>
          {(field) => (
            <Textarea
              {...field}
              {...form.register('description')}
              rows={2}
              placeholder="Flagship studio with two treatment rooms."
            />
          )}
        </Field>

        {selectedType === 'VIRTUAL' ? (
          <Field
            label="Meeting link"
            hint="Sent to the customer with their confirmation."
            error={form.formState.errors.virtualMeetingUrl?.message}
          >
            {(field) => (
              <Input
                {...field}
                {...form.register('virtualMeetingUrl')}
                type="url"
                placeholder="https://meet.example.com/studio"
              />
            )}
          </Field>
        ) : (
          <>
            <Field label="Address line 1" error={form.formState.errors.addressLine1?.message}>
              {(field) => <Input {...field} {...form.register('addressLine1')} />}
            </Field>
            <Field label="Address line 2" error={form.formState.errors.addressLine2?.message}>
              {(field) => <Input {...field} {...form.register('addressLine2')} />}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="City" error={form.formState.errors.city?.message}>
                {(field) => <Input {...field} {...form.register('city')} />}
              </Field>
              <Field label="State or region" error={form.formState.errors.state?.message}>
                {(field) => <Input {...field} {...form.register('state')} />}
              </Field>
              <Field label="Postal code" error={form.formState.errors.postalCode?.message}>
                {(field) => <Input {...field} {...form.register('postalCode')} />}
              </Field>
              <Field
                label="Country code"
                hint="Two letters, e.g. IN."
                error={form.formState.errors.countryCode?.message}
              >
                {(field) => <Input {...field} {...form.register('countryCode')} maxLength={2} />}
              </Field>
            </div>
          </>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Phone" error={form.formState.errors.phone?.message}>
            {(field) => <Input {...field} {...form.register('phone')} type="tel" />}
          </Field>
          <Field label="Email" error={form.formState.errors.email?.message}>
            {(field) => <Input {...field} {...form.register('email')} type="email" />}
          </Field>
        </div>

        <Field
          label="Capacity"
          hint="How many appointments this site can run at once. Leave blank for no cap of its own."
          error={form.formState.errors.capacity?.message}
        >
          {(field) => (
            <Input {...field} {...form.register('capacity')} inputMode="numeric" min={1} />
          )}
        </Field>

        <Switch
          checked={form.watch('isActive')}
          onCheckedChange={(checked) => form.setValue('isActive', checked, { shouldDirty: true })}
          label="Bookable"
          description="An inactive location keeps its history but is offered to nobody."
        />
      </FormDrawer>

      <ConfirmDialog
        open={deleting !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
        title={deleting ? `Remove ${deleting.name}?` : ''}
        description="The location is archived rather than erased — past appointments keep their record of where they happened — but it can no longer be booked or assigned."
        confirmLabel="Remove location"
        cancelLabel="Keep it"
        destructive
        loading={remove.isPending}
      />
    </>
  );
}
